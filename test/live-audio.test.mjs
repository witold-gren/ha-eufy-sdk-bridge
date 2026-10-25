// Live audio rides on the video's session: it must never open (wake) a camera, prime silence while the
// camera wakes so go2rtc keeps the source, hand over to the camera's AAC, and end on a format it cannot
// splice into the silent ADTS stream.
import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";

import { SILENT_AAC_FRAME, adtsHeader, matchesPrimer, serveLiveAudio } from "../src/live-audio.mjs";

const AAC = Buffer.from("fff16040017ffc01182007", "hex"); // AAC-LC 16 kHz mono
const AAC_44K_STEREO = Buffer.from("fff15080017ffc", "hex"); // AAC-LC 44.1 kHz stereo header

function fakeRes() {
  const res = new EventEmitter();
  res.chunks = [];
  res.ended = false;
  res.writableEnded = false;
  res.headersSent = false;
  res.writeHead = (code, headers) => {
    res.code = code;
    res.headers = headers;
    res.headersSent = true;
  };
  res.write = (b) => {
    res.chunks.push(Buffer.from(b));
    return true;
  };
  res.end = () => {
    res.ended = res.writableEnded = true;
    res.emit("close");
  };
  res.destroy = () => res.end();
  return res;
}

function fakeCamera() {
  const consumer = new EventEmitter();
  consumer.stopped = false;
  consumer.stop = () => (consumer.stopped = true);
  let lives = 0;
  const cam = { live: async () => (lives++, consumer) };
  const client = { getDevice: async () => ({ camera: () => cam }) };
  return { consumer, client, livesCalled: () => lives };
}

test("adtsHeader reads profile, rate and channels; matchesPrimer only takes AAC-LC 16 kHz mono", () => {
  assert.deepEqual(adtsHeader(AAC), { profile: 2, frequencyIndex: 8, channels: 1 });
  assert.equal(adtsHeader(Buffer.from([1, 2, 3])), null);
  assert.equal(matchesPrimer({ codec: "aac-lc", data: AAC }), true);
  assert.equal(matchesPrimer({ codec: "aac-lc", data: AAC_44K_STEREO }), false);
  assert.equal(matchesPrimer({ codec: "g711a", data: Buffer.alloc(160) }), false);
});

test("primes silence, joins the live video's session, then streams the camera's AAC", async () => {
  const { consumer, client, livesCalled } = fakeCamera();
  const res = fakeRes();
  let entry;
  const done = serveLiveAudio(res, "CAM1", { activeEntry: () => entry, pollMs: 20, waitMs: 5000 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(res.headers["content-type"], "audio/aac");
  assert.ok(res.chunks.length >= 2, "silence is written while waiting");
  assert.ok(res.chunks.every((c) => c.equals(SILENT_AAC_FRAME)));
  assert.equal(livesCalled(), 0, "no live() before the video is live");

  entry = { lease: Promise.resolve(client) };
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(livesCalled(), 1);
  const real = Buffer.concat([AAC, Buffer.from([0xaa])]);
  consumer.emit("audio", { codec: "aac-lc", data: real });
  const n = res.chunks.length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(res.chunks.length, n, "silence stops once the camera's sound arrives");
  assert.ok(res.chunks.at(-1).equals(real));

  consumer.emit("stop");
  await done;
  assert.equal(res.ended, true);
  assert.equal(consumer.stopped, true);
});

test("never opens the camera when its video does not go live", async () => {
  const { livesCalled } = fakeCamera();
  const res = fakeRes();
  const logs = [];
  await serveLiveAudio(res, "CAM1", { activeEntry: () => undefined, pollMs: 10, waitMs: 80, log: (m) => logs.push(m) });
  assert.equal(livesCalled(), 0);
  assert.equal(res.ended, true);
  assert.match(logs.join("\n"), /did not go live/);
});

test("a camera sending another audio format ends the response instead of splicing it in", async () => {
  const { consumer, client } = fakeCamera();
  const res = fakeRes();
  const logs = [];
  const done = serveLiveAudio(res, "CAM1", {
    activeEntry: () => ({ lease: Promise.resolve(client) }),
    pollMs: 10,
    log: (m) => logs.push(m),
  });
  await new Promise((r) => setTimeout(r, 50));
  consumer.emit("audio", { codec: "g711a", data: Buffer.alloc(160) });
  await done;
  assert.equal(res.ended, true);
  assert.equal(consumer.stopped, true);
  assert.match(logs.join("\n"), /g711a, not AAC-LC 16 kHz mono/);
});

test("the viewer leaving detaches the consumer", async () => {
  const { consumer, client } = fakeCamera();
  const res = fakeRes();
  const done = serveLiveAudio(res, "CAM1", { activeEntry: () => ({ lease: Promise.resolve(client) }), pollMs: 10 });
  await new Promise((r) => setTimeout(r, 50));
  res.emit("close");
  await done;
  assert.equal(consumer.stopped, true);
});
