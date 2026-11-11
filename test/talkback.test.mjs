import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { pcmEncoderArgs, serveTalkback, talkFormat } from "../src/talkback.mjs";

/** A talkback handle that records what it was given and lets a test drive its events. */
function fakeHandle(codec = "aac-lc") {
  const handle = new EventEmitter();
  handle.codec = codec;
  handle.received = [];
  handle.stopped = 0;
  handle.stop = async () => {
    handle.stopped += 1;
  };
  handle.writable = () =>
    new Writable({
      write(chunk, _enc, cb) {
        handle.received.push(chunk);
        cb();
      },
      final(cb) {
        cb();
        queueMicrotask(() => handle.emit("finished"));
      },
    });
  return handle;
}

function fakeEufy(handle) {
  return {
    async getDevice() {
      return { camera: () => (handle === null ? {} : { talkback: async () => handle }) };
    },
  };
}

function fakeReq(method = "POST") {
  const req = new PassThrough();
  req.method = method;
  req.complete = false;
  req.on("end", () => (req.complete = true));
  return req;
}

function fakeRes() {
  const res = new EventEmitter();
  res.headersSent = false;
  res.writableEnded = false;
  res.lines = []; // the lines of a talk that started: states, then the outcome
  res.writeHead = (code, headers) => {
    res.code = code;
    res.headers = headers;
    res.headersSent = true;
  };
  res.write = (chunk) => {
    res.lines.push(JSON.parse(chunk));
  };
  res.end = (body) => {
    res.writableEnded = true;
    res.body = body ? JSON.parse(body) : undefined;
    if (res.body && res.code === 200) res.lines.push(res.body);
    res.emit("done");
  };
  return res;
}

/** How a talk ended: the status in its last line once it started, else the HTTP status of the refusal. */
const ended = (res) => res.body?.status ?? res.code;

const answered = (res) => new Promise((resolve) => res.once("done", resolve));

test("a posted file plays on the speaker to its end, then the talkback stops", async () => {
  const handle = fakeHandle();
  const talking = new Set();
  const req = fakeReq();
  const res = fakeRes();
  await serveTalkback(req, res, "CAM1", { eufy: fakeEufy(handle), talking });
  assert.ok(talking.has("CAM1"));
  req.end(Buffer.from([0xff, 0xf1, 1, 2]));
  await answered(res);
  assert.equal(res.code, 200);
  assert.deepEqual(Buffer.concat(handle.received), Buffer.from([0xff, 0xf1, 1, 2]));
  assert.equal(handle.stopped, 1);
  assert.ok(!talking.has("CAM1")); // the camera is free for the next talker
});

test("a talk that started says so at once, and its outcome comes as the last line", async () => {
  const handle = fakeHandle();
  const req = fakeReq();
  const res = fakeRes();
  await serveTalkback(req, res, "CAM1", { eufy: fakeEufy(handle), talking: new Set() });
  // Before any sound arrives the dashboard hears that the camera listens.
  assert.equal(res.code, 200);
  assert.equal(res.headers["content-type"], "application/x-ndjson");
  assert.deepEqual(res.lines, [{ state: "connected" }]);
  req.end(Buffer.from([0xff, 0xf1, 1]));
  await answered(res);
  assert.equal(res.lines.length, 2);
  assert.equal(res.lines[1].ok, true);
  assert.equal(res.lines[1].status, 200);
});

test("a refusal before the camera takes the talk stays a plain answer", async () => {
  const res = fakeRes();
  await serveTalkback(fakeReq(), res, "CAM1", { eufy: fakeEufy(fakeHandle()), talking: new Set(["CAM1"]) });
  assert.equal(res.code, 409);
  assert.deepEqual(res.lines, []);
});

test("a talker who goes away stops the talkback at once", async () => {
  const handle = fakeHandle();
  const req = fakeReq();
  const res = fakeRes();
  await serveTalkback(req, res, "CAM1", { eufy: fakeEufy(handle), talking: new Set() });
  req.write(Buffer.from([1]));
  req.destroy(); // released button / closed browser: the body never completes
  await answered(res);
  assert.equal(ended(res), 499);
  assert.equal(handle.stopped, 1);
});

test("the camera ending its session ends the talk", async () => {
  const handle = fakeHandle();
  const req = fakeReq();
  const res = fakeRes();
  await serveTalkback(req, res, "CAM1", { eufy: fakeEufy(handle), talking: new Set() });
  handle.emit("stop");
  await answered(res);
  assert.equal(ended(res), 503);
});

test("a second talker on the same camera is refused", async () => {
  const talking = new Set(["CAM1"]);
  const res = fakeRes();
  await serveTalkback(fakeReq(), res, "CAM1", { eufy: fakeEufy(fakeHandle()), talking });
  assert.equal(res.code, 409);
  assert.ok(talking.has("CAM1")); // the first talker keeps the camera
});

test("a camera without a speaker answers 404 and frees the slot", async () => {
  const talking = new Set();
  const res = fakeRes();
  await serveTalkback(fakeReq(), res, "CAM1", { eufy: fakeEufy(null), talking });
  assert.equal(res.code, 404);
  assert.equal(talking.size, 0);
});

test("an AAC-ELD speaker is refused instead of being fed ADTS it cannot play", async () => {
  const handle = fakeHandle("aac-eld");
  const res = fakeRes();
  await serveTalkback(fakeReq(), res, "CAM1", { eufy: fakeEufy(handle), talking: new Set() });
  assert.equal(res.code, 415);
  assert.equal(res.body.codec, "aac-eld");
  assert.equal(handle.stopped, 1);
});

test("a talkback that cannot start answers 502", async () => {
  const eufy = {
    getDevice: async () => ({
      camera: () => ({ talkback: async () => Promise.reject(new Error("P2P connect timeout")) }),
    }),
  };
  const talking = new Set();
  const res = fakeRes();
  await serveTalkback(fakeReq(), res, "CAM1", { eufy, talking });
  assert.equal(res.code, 502);
  assert.match(res.body.reason, /P2P connect timeout/);
  assert.equal(talking.size, 0);
});

test("only POST is accepted", async () => {
  const res = fakeRes();
  await serveTalkback(fakeReq("GET"), res, "CAM1", { eufy: fakeEufy(fakeHandle()), talking: new Set() });
  assert.equal(res.code, 405);
});

test("the PCM format and rate come from the query", () => {
  assert.equal(talkFormat(new URLSearchParams("")), null); // ADTS AAC as before
  assert.deepEqual(talkFormat(new URLSearchParams("format=s16le&rate=48000")), { rate: 48000 });
  assert.match(talkFormat(new URLSearchParams("format=opus")).error, /unknown format/);
  assert.match(talkFormat(new URLSearchParams("format=s16le&rate=96000")).error, /rate/);
  assert.match(talkFormat(new URLSearchParams("format=s16le")).error, /rate/);
});

test("the PCM encoder turns mono s16le into ADTS AAC-LC 16 kHz mono", () => {
  const args = pcmEncoderArgs(48000).join(" ");
  assert.match(args, /-f s16le -ar 48000 -ch_layout mono -i pipe:0/);
  assert.match(args, /-ar 16000 -ac 1 -c:a aac .* -f adts pipe:1$/);
});

/** A spawned ffmpeg: stdin collects the PCM, stdout is what the test makes it encode. */
function fakeEncoder() {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.pcm = [];
  proc.stdin.on("data", (chunk) => proc.pcm.push(chunk));
  proc.killed = null;
  proc.kill = (signal) => {
    proc.killed = signal;
    proc.emit("close", null);
  };
  return proc;
}

test("PCM from a microphone is encoded by ffmpeg and the AAC reaches the speaker", async () => {
  const handle = fakeHandle();
  const encoder = fakeEncoder();
  const spawned = [];
  const req = fakeReq();
  const res = fakeRes();
  await serveTalkback(req, res, "CAM1", {
    eufy: fakeEufy(handle),
    talking: new Set(),
    query: new URLSearchParams("format=s16le&rate=48000"),
    spawn: (bin, args) => (spawned.push([bin, args]), encoder),
  });
  assert.equal(spawned.length, 1);
  req.end(Buffer.from([1, 2, 3, 4])); // PCM in
  encoder.stdout.end(Buffer.from([0xff, 0xf1, 9])); // AAC out
  await answered(res);
  assert.deepEqual(Buffer.concat(encoder.pcm), Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(Buffer.concat(handle.received), Buffer.from([0xff, 0xf1, 9]));
  assert.equal(res.code, 200);
});

test("a talk with no sound at all still ends and frees the camera", async () => {
  const handle = fakeHandle();
  handle.writable = () => new Writable({ write: (_c, _e, cb) => cb(), final: (cb) => cb() }); // never "finished"
  const encoder = fakeEncoder();
  const talking = new Set();
  const req = fakeReq();
  const res = fakeRes();
  await serveTalkback(req, res, "CAM1", {
    eufy: fakeEufy(handle),
    talking,
    query: new URLSearchParams("format=s16le&rate=16000"),
    spawn: () => encoder,
    settleMs: 10,
  });
  req.end(); // tapped and released at once: nothing to play
  encoder.stdout.end();
  encoder.emit("close", 0);
  await answered(res);
  assert.equal(ended(res), 200);
  assert.equal(res.body.ok, true);
  assert.ok(!talking.has("CAM1"), "the next talker gets the camera");
});

test("a released talk button kills the PCM encoder", async () => {
  const encoder = fakeEncoder();
  const req = fakeReq();
  const res = fakeRes();
  await serveTalkback(req, res, "CAM1", {
    eufy: fakeEufy(fakeHandle()),
    talking: new Set(),
    query: new URLSearchParams("format=s16le&rate=16000"),
    spawn: () => encoder,
  });
  req.destroy();
  await answered(res);
  assert.equal(ended(res), 499);
  assert.equal(encoder.killed, "SIGKILL");
});

test("an encoder that fails ends the talk with its error", async () => {
  const encoder = fakeEncoder();
  const res = fakeRes();
  await serveTalkback(fakeReq(), res, "CAM1", {
    eufy: fakeEufy(fakeHandle()),
    talking: new Set(),
    query: new URLSearchParams("format=s16le&rate=16000"),
    spawn: () => encoder,
  });
  encoder.stderr.write("Invalid data found when processing input");
  encoder.emit("close", 1);
  await answered(res);
  assert.equal(ended(res), 500);
  assert.match(res.body.reason, /Invalid data/);
});

test("a bad format is refused before the camera is touched", async () => {
  const talking = new Set();
  const res = fakeRes();
  await serveTalkback(fakeReq(), res, "CAM1", {
    eufy: fakeEufy(fakeHandle()),
    talking,
    query: new URLSearchParams("format=opus"),
  });
  assert.equal(res.code, 400);
  assert.equal(talking.size, 0);
});
