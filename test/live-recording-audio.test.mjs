// The live-view recorder keeps the camera's sound where the live view carries it: the /audio request hands it
// the camera's ADTS frames, they go to a temporary .aac file beside the video, and the part is muxed with the
// sound offset by when it started after the part's first keyframe. A gap in the sound is filled with silence,
// a split gives each part its own sound, overlapping /audio requests record each frame once, and anything
// that goes wrong with the sound still keeps the video. A fake muxer stands in for ffmpeg.
process.env.TZ = "Asia/Kolkata"; // file names are local time: pin it, before any Date use

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";

import { AUDIO_GAP_MS, createLiveRecorder } from "../src/live-recorder.mjs";
import { muxMp4 } from "../src/clip.mjs";
import { SILENT_AAC_FRAME, serveLiveAudio } from "../src/live-audio.mjs";
import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";

process.env.BRIDGE_STREAM_CONSUMER_LOG_MS = "0"; // no real HTTP at :1984 from the consumer probe
const { createHttpHandler } = await import("../src/http-routes.mjs");

const SC = [0x00, 0x00, 0x00, 0x01];
const au = (...nals) => Buffer.from(nals.flatMap((n) => [...SC, ...n]));
const KEY = au([0x67, 0x64, 0x00, 0x1f], [0x68, 0xee, 0x3c], [0x65, 0x88, 0x84]);
const DELTA = au([0x41, 0x9a, 0x02]);
// AAC-LC 16 kHz mono ADTS frames (the camera's format), told apart by their last byte.
const aac = (n) => Buffer.concat([SILENT_AAC_FRAME.subarray(0, 10), Buffer.from([n])]);
const AAC_44K = Buffer.from("fff15080017ffc01", "hex"); // AAC-LC 44.1 kHz stereo header
const T0 = Date.UTC(2026, 10, 9, 10, 0, 0);

function setup({ splitMs, mux } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-audio-"));
  const t = { now: T0, muxed: [], warnings: [], log: [], dir };
  const ctx = {
    cfg: { liveRecordingDir: dir, liveRecordingSplitMs: splitMs },
    eventImageDir: fs.mkdtempSync(path.join(os.tmpdir(), "rec-audio-data-")),
    now: () => t.now,
    eventLog: (line) => void t.log.push(line),
    warn: (line) => void t.warnings.push(line),
    muxRecording:
      mux ??
      (async (input, out) => {
        t.muxed.push({ ...input, audio: input.audioFile ? fs.readFileSync(input.audioFile) : null, out });
        fs.writeFileSync(out, "MP4");
      }),
  };
  t.rec = createLiveRecorder(ctx).liveRecorder;
  return t;
}

/** Every file under `dir`, relative, sorted (dot-files included). */
const filesIn = (dir) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();

const frame = (data) => ({ codec: "aac-lc", data });

test("the camera's sound is recorded with the video, offset by when it started", async () => {
  const t = setup();
  await t.rec.setEnabled("CAM1", true);
  const video = t.rec.tap("CAM1");
  const audio = t.rec.audioTap("CAM1");
  audio.onAudio(frame(aac(0))); // before the first keyframe: no recording yet, not kept
  video.onChunk(KEY);
  t.now += 300;
  audio.onAudio(frame(aac(1)));
  for (let i = 2; i < 6; i++) {
    t.now += 64;
    audio.onAudio(frame(aac(i)));
    video.onChunk(DELTA);
  }
  t.now += 2_000;
  video.onChunk(DELTA);
  await video.finish();
  audio.finish();

  assert.equal(t.muxed.length, 1);
  assert.equal(t.muxed[0].audioDelayMs, 300);
  assert.ok(t.muxed[0].audio.equals(Buffer.concat([1, 2, 3, 4, 5].map(aac))), "each frame once, in order");
  assert.match(t.muxed[0].audioFile, /\.recording-\d+\.aac$/);
  assert.deepEqual(filesIn(t.dir), [path.join("CAM1", "2026-11-09", "153000-153002.mp4")], "temp files gone");
  assert.match(t.log.join("\n"), /recording the sound too \(AAC 16 kHz, 1 ch\)/);
});

test("without sound the recording is video-only", async () => {
  const t = setup();
  await t.rec.setEnabled("CAM1", true);
  const video = t.rec.tap("CAM1");
  video.onChunk(KEY);
  t.now += 3_000;
  video.onChunk(DELTA);
  await video.finish();
  assert.equal(t.muxed.length, 1);
  assert.equal(t.muxed[0].audioFile, undefined);
  assert.equal(t.muxed[0].audioDelayMs, undefined);
});

test("a camera not switched on gets no audio tap", () => {
  const t = setup();
  assert.equal(t.rec.audioTap("CAM1"), null);
});

test("sound in another format than ADTS AAC is not recorded; the video still is", async () => {
  const t = setup();
  await t.rec.setEnabled("CAM1", true);
  const video = t.rec.tap("CAM1");
  const audio = t.rec.audioTap("CAM1");
  video.onChunk(KEY);
  audio.onAudio({ codec: "g711a", data: Buffer.alloc(160, 0xd5) });
  audio.onAudio({ codec: "aac-lc", data: Buffer.from([1, 2, 3]) }); // not an ADTS frame
  t.now += 3_000;
  video.onChunk(DELTA);
  await video.finish();
  assert.equal(t.muxed[0].audioFile, undefined);
});

test("a format change mid-recording keeps the sound up to it", async () => {
  const t = setup();
  await t.rec.setEnabled("CAM1", true);
  const video = t.rec.tap("CAM1");
  const audio = t.rec.audioTap("CAM1");
  video.onChunk(KEY);
  audio.onAudio(frame(aac(1)));
  audio.onAudio(frame(AAC_44K));
  audio.onAudio(frame(aac(2)));
  t.now += 3_000;
  video.onChunk(DELTA);
  await video.finish();
  assert.ok(t.muxed[0].audio.equals(aac(1)));
});

test("a gap in the sound longer than AUDIO_GAP_MS is filled with silence; jitter is not", async () => {
  const t = setup();
  await t.rec.setEnabled("CAM1", true);
  const video = t.rec.tap("CAM1");
  const audio = t.rec.audioTap("CAM1");
  video.onChunk(KEY);
  audio.onAudio(frame(aac(1)));
  t.now += AUDIO_GAP_MS - 100; // late, but within the jitter allowance: nothing added
  audio.onAudio(frame(aac(2)));
  t.now = T0 + 64 * 2 + 2_000; // two seconds of sound lost (the clock is past the two frames written)
  audio.onAudio(frame(aac(3)));
  video.onChunk(DELTA);
  await video.finish();

  const filled = Math.round(2_000 / 64); // 31 silent frames: frame 3 lands where the clock says
  assert.ok(t.muxed[0].audio.equals(Buffer.concat([aac(1), aac(2), ...Array(filled).fill(SILENT_AAC_FRAME), aac(3)])));
  assert.match(t.log.join("\n"), /31 silent frame\(s\) filling gaps/);
});

test("each part of a split viewing has its own sound, offset from its own first keyframe", async () => {
  const t = setup({ splitMs: 2_000 });
  await t.rec.setEnabled("CAM1", true);
  const video = t.rec.tap("CAM1");
  const audio = t.rec.audioTap("CAM1");
  video.onChunk(KEY);
  t.now += 100;
  audio.onAudio(frame(aac(1)));
  t.now += 1_900;
  video.onChunk(DELTA); // the 2 s are up, but a part ends on a keyframe
  t.now += 100;
  video.onChunk(KEY); // the split
  t.now += 40;
  audio.onAudio(frame(aac(2)));
  t.now += 500;
  video.onChunk(DELTA);
  await video.finish();

  assert.equal(t.muxed.length, 2);
  assert.ok(t.muxed[0].audio.equals(aac(1)));
  assert.equal(t.muxed[0].audioDelayMs, 100);
  assert.ok(t.muxed[1].audio.equals(aac(2)));
  assert.equal(t.muxed[1].audioDelayMs, 40);
  assert.notEqual(t.muxed[0].audioFile, t.muxed[1].audioFile);
});

test("overlapping /audio requests record each frame once, the second carrying on when the first ends", async () => {
  const t = setup();
  await t.rec.setEnabled("CAM1", true);
  const video = t.rec.tap("CAM1");
  const a = t.rec.audioTap("CAM1");
  const b = t.rec.audioTap("CAM1");
  video.onChunk(KEY);
  for (const n of [1, 2]) {
    a.onAudio(frame(aac(n)));
    b.onAudio(frame(aac(n))); // the same frames reach both requests
  }
  a.finish();
  b.onAudio(frame(aac(3)));
  t.now += 3_000;
  video.onChunk(DELTA);
  await video.finish();
  assert.ok(t.muxed[0].audio.equals(Buffer.concat([aac(1), aac(2), aac(3)])));
});

test("a mux that fails with the sound keeps the video alone", async () => {
  const calls = [];
  const t = setup({
    mux: async (input, out) => {
      calls.push(input);
      if (input.audioFile) throw new Error("ffmpeg: bad audio");
      fs.writeFileSync(out, "MP4");
    },
  });
  await t.rec.setEnabled("CAM1", true);
  const video = t.rec.tap("CAM1");
  const audio = t.rec.audioTap("CAM1");
  video.onChunk(KEY);
  audio.onAudio(frame(aac(1)));
  t.now += 3_000;
  video.onChunk(DELTA);
  assert.ok(await video.finish(), "the recording is kept");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].audioFile, undefined);
  assert.match(t.warnings.join("\n"), /could not mux the sound \(ffmpeg: bad audio\) — keeping the video only/);
  assert.deepEqual(filesIn(t.dir), [path.join("CAM1", "2026-11-09", "153000-153003.mp4")]);
});

test("muxMp4 takes the sound from a file and starts it after the video", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-"));
  const argsFile = path.join(dir, "args");
  const ffmpeg = path.join(dir, "ffmpeg");
  fs.writeFileSync(
    ffmpeg,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nfor a; do out="$a"; done\necho mp4 > "$out"\n`,
    { mode: 0o755 },
  );
  const videoFile = path.join(dir, "rec.annexb");
  const audioFile = path.join(dir, "rec.aac");
  fs.writeFileSync(videoFile, KEY);
  fs.writeFileSync(audioFile, aac(1));
  const out = path.join(dir, "out.mp4");

  await muxMp4({ videoFile, audioFile, audioDelayMs: 1234, fps: 15 }, out, { ffmpeg });

  const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
  const at = args.indexOf("-itsoffset");
  assert.deepEqual(args.slice(at, at + 8), ["-itsoffset", "1.234", "-f", "aac", "-i", audioFile, "-map", "0:v"]);
  assert.ok(args.indexOf("-i") < at, "the offset applies to the sound, the second input");
  assert.deepEqual(args.slice(args.indexOf("-c"), args.indexOf("-c") + 2), ["-c", "copy"], "stream copy");
  assert.ok(fs.existsSync(audioFile), "a file passed in stays for its owner to remove");

  await muxMp4({ videoFile, audioFile }, out, { ffmpeg });
  assert.equal(fs.readFileSync(argsFile, "utf8").includes("-itsoffset"), false, "no offset when none is due");
});

test("serveLiveAudio hands the recorder the camera's frames, not the silent primer", async () => {
  const consumer = new EventEmitter();
  consumer.stop = () => {};
  const client = { getDevice: async () => ({ camera: () => ({ live: async () => consumer }) }) };
  const res = new EventEmitter();
  Object.assign(res, {
    writeHead() {},
    write: () => true,
    end() {
      res.writableEnded = true;
      res.emit("close");
    },
    destroy() {
      res.end();
    },
  });
  const got = [];
  let entry;
  const done = serveLiveAudio(res, "CAM1", { activeEntry: () => entry, pollMs: 10, onAudio: (f) => got.push(f) });
  await new Promise((r) => setTimeout(r, 150)); // silence primed meanwhile
  assert.deepEqual(got, []);
  entry = { lease: Promise.resolve(client) };
  await new Promise((r) => setTimeout(r, 50));
  consumer.emit("audio", frame(aac(1)));
  consumer.emit("audio", frame(aac(2)));
  consumer.emit("stop");
  await done;
  assert.deepEqual(
    got.map((f) => f.data.at(-1)),
    [1, 2],
  );
});

test("/audio of a recorded camera feeds the recording of its /stream", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-route-data-"));
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-route-media-"));
  const config = loadConfig({
    EUFY_EMAIL: "x@y.z",
    EUFY_PASSWORD: "pw",
    STREAM_INSTANT_START: "0",
    LIVE_RECORDING_DIR: mediaDir,
  });
  const state = createState();
  state.flags.ready = true;
  const feeds = [];
  const consumers = [];
  const muxed = [];
  const cam = {
    views: () => [0],
    openReadable: async () => {
      const feed = new PassThrough();
      feeds.push(feed);
      return feed;
    },
    live: async () => {
      const c = new EventEmitter();
      c.stop = () => {};
      consumers.push(c);
      return c;
    },
  };
  const ctx = {
    ...config,
    state,
    eventImageDir: dataDir,
    eventLog: () => {},
    broadcast: () => {},
    noteStreamOpened: () => {},
    noteStreamFailure: () => {},
    streamBackoffMs: () => 0,
    dropStreamClient: () => {},
    minRecordingMs: 0,
    muxRecording: async (input, out) => {
      muxed.push({ ...input, audio: input.audioFile ? fs.readFileSync(input.audioFile) : null });
      fs.writeFileSync(out, "MP4");
    },
    streamClientFor: async () => ({
      getDevice: async () => ({ describe: () => ({ model: "T8410", capabilities: [] }), camera: () => cam }),
    }),
  };
  Object.assign(ctx, createLiveRecorder(ctx));
  await ctx.liveRecorder.setEnabled("CAM1", true);
  const server = http.createServer((req, res) => void createHttpHandler(ctx)(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const get = (p) =>
    new Promise((resolve) =>
      http.get({ host: "127.0.0.1", port: server.address().port, path: p }, (res) => {
        res.resume();
        res.on("end", resolve);
        res.on("aborted", resolve);
        res.on("error", resolve);
      }),
    );
  const until = async (cond, what) => {
    for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond(), `timed out waiting for: ${what}`);
  };
  try {
    const streamDone = get("/stream/CAM1");
    await until(() => feeds.length === 1, "live video opened");
    assert.equal(consumers.length, 0, "the video came through openReadable");
    feeds[0].write(KEY);
    const audioDone = get("/audio/CAM1");
    await until(() => consumers.length === 1, "the audio joined the video's session");
    consumers[0].emit("audio", frame(aac(1)));
    consumers[0].emit("audio", frame(aac(2)));
    await new Promise((r) => setTimeout(r, 20));
    feeds[0].write(DELTA);
    await new Promise((r) => setTimeout(r, 20));
    consumers[0].emit("stop");
    feeds[0].end();
    await Promise.all([streamDone, audioDone]);
    await until(() => muxed.length === 1, "recording muxed");
    assert.ok(muxed[0].audio.equals(Buffer.concat([aac(1), aac(2)])));
    assert.ok(muxed[0].audioDelayMs >= 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
