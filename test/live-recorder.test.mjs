// The opt-in live-view recorder (live-recorder.mjs): off until switched on per camera, the setting survives a
// restart, one recording per camera however many requests overlap, it starts at a keyframe, a short viewing
// is dropped, the file is named by local start/end time, a long viewing is split into parts at keyframes, old
// recordings are deleted when retention is on, and a failing mux or folder never throws. A fake muxer stands
// in for ffmpeg; muxMp4 itself is driven against a stand-in ffmpeg script.
process.env.TZ = "Asia/Kolkata"; // UTC+05:30 all year: local names differ from UTC ones, before any Date use

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import assert from "node:assert/strict";

import {
  createLiveRecorder,
  oldestKeptDay,
  recordingFile,
  PRUNE_EVERY_MS,
  RECORDING_STATE_FILE,
} from "../src/live-recorder.mjs";
import { muxMp4 } from "../src/clip.mjs";

const SC = [0x00, 0x00, 0x00, 0x01]; // Annex-B start code
const au = (...nals) => Buffer.from(nals.flatMap((n) => [...SC, ...n]));
const H264_KEY = au([0x67, 0x64, 0x00, 0x1f], [0x68, 0xee, 0x3c], [0x65, 0x88, 0x84]);
const H264_DELTA = au([0x41, 0x9a, 0x02]);
const HEVC_KEY = au([0x40, 0x01, 0x0c], [0x42, 0x01, 0x01], [0x44, 0x01, 0xc1], [0x26, 0x01, 0xaf]);
const HEVC_DELTA = au([0x02, 0x01, 0xd0]);

// 2026-11-09 18:29:58 UTC is 23:59:58 in Kolkata: the day folder must be the LOCAL start day.
const T0 = Date.UTC(2026, 10, 9, 18, 29, 58);

/** A recorder over fresh temp dirs, a settable clock, and a fake muxer that keeps what it was given. */
function setup({ mux, data, recordings, minRecordingMs, splitMs, keepDays } = {}) {
  const dataDir = data ?? fs.mkdtempSync(path.join(os.tmpdir(), "rec-data-"));
  const dir = recordings ?? fs.mkdtempSync(path.join(os.tmpdir(), "rec-media-"));
  const t = { now: T0, muxed: [], events: [], warnings: [], log: [], info: [], dataDir, dir };
  const ctx = {
    cfg: { liveRecordingDir: dir, liveRecordingSplitMs: splitMs, liveRecordingKeepDays: keepDays },
    eventImageDir: dataDir,
    now: () => t.now,
    eventLog: (line) => void t.log.push(line),
    warn: (line) => void t.warnings.push(line),
    info: (line) => void t.info.push(line),
    broadcast: (msg) => void t.events.push(msg),
    ...(minRecordingMs != null ? { minRecordingMs } : {}),
    muxRecording:
      mux ??
      (async (input, out) => {
        t.muxed.push({ ...input, video: fs.readFileSync(input.videoFile), out });
        fs.writeFileSync(out, "MP4");
      }),
  };
  t.rec = createLiveRecorder(ctx).liveRecorder;
  return t;
}

/** Every file under `dir`, relative, sorted (dot-files included). */
function filesIn(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
}

/** Feed `frames` through a tap, the clock advancing `stepMs` before each. */
function play(t, tap, frames, stepMs = 500) {
  for (const f of frames) {
    t.now += stepMs;
    tap.onChunk(f);
  }
}

test("nothing is recorded until a camera is switched on", () => {
  const t = setup();
  assert.deepEqual(t.rec.list(), []);
  assert.equal(t.rec.enabled("CAM1"), false);
  assert.equal(t.rec.tap("CAM1"), null);
  assert.deepEqual(filesIn(t.dir), []);
});

test("the switched-on set is persisted in the data dir and survives a restart", async () => {
  const t = setup();
  await t.rec.setEnabled("CAM2", true);
  await t.rec.setEnabled("CAM1", true);
  assert.deepEqual(t.rec.list(), ["CAM1", "CAM2"]);
  const saved = JSON.parse(fs.readFileSync(path.join(t.dataDir, RECORDING_STATE_FILE), "utf8"));
  assert.deepEqual(saved, { enabled: ["CAM1", "CAM2"] });

  await t.rec.setEnabled("CAM2", false);
  const again = setup({ data: t.dataDir });
  assert.deepEqual(again.rec.list(), ["CAM1"]);
  assert.equal(again.rec.enabled("CAM2"), false);
});

test("an unreadable settings file means every camera off, and says so", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-data-"));
  fs.writeFileSync(path.join(dataDir, RECORDING_STATE_FILE), "{ not json");
  const t = setup({ data: dataDir });
  assert.deepEqual(t.rec.list(), []);
  assert.equal(t.warnings.length, 1);
});

test("a setting that cannot be saved is refused and left as it was", async () => {
  const t = setup();
  fs.mkdirSync(path.join(t.dataDir, `${RECORDING_STATE_FILE}.tmp`)); // the write target is a directory
  await assert.rejects(t.rec.setEnabled("CAM1", true));
  assert.equal(t.rec.enabled("CAM1"), false);
});

test("a recording starts at the first keyframe and is muxed when the stream ends", async () => {
  const t = setup();
  await t.rec.setEnabled("CAM1", true);
  const tap = t.rec.tap("CAM1");
  play(t, tap, [H264_DELTA, H264_DELTA]); // joined mid-GOP: not decodable, not kept
  assert.deepEqual(t.events, []);
  play(t, tap, [H264_KEY, H264_DELTA, H264_DELTA, H264_DELTA, H264_DELTA]);
  assert.deepEqual(t.events, [{ event: "recordingState", deviceSn: "CAM1", active: true }]);
  assert.deepEqual(t.rec.active(), ["CAM1"]);

  const file = await tap.finish();

  assert.equal(t.muxed.length, 1);
  assert.equal(t.muxed[0].codec, "h264");
  assert.equal(t.muxed[0].fps, 2); // 5 frames over 2 s, one every 500 ms
  assert.ok(t.muxed[0].video.equals(Buffer.concat([H264_KEY, ...Array(4).fill(H264_DELTA)])));
  assert.deepEqual(t.events.at(-1), { event: "recordingState", deviceSn: "CAM1", active: false });
  assert.deepEqual(t.rec.active(), []);
  // Started 23:59:59 local (T0 + 1.5 s), last frame 00:00:01 the next day: the start day names the folder.
  assert.equal(file, path.join(t.dir, "CAM1", "2026-11-09", "235959-000001.mp4"));
  assert.deepEqual(filesIn(t.dir), [path.join("CAM1", "2026-11-09", "235959-000001.mp4")]); // temp file gone
});

test("recordingFile names a recording by its local start and end", () => {
  const start = T0 + 2_000; // 00:00:00 Kolkata, 2026-11-10
  assert.equal(
    recordingFile("/media/eufy", "SN", start, start + 61_000),
    "/media/eufy/SN/2026-11-10/000000-000101.mp4",
  );
});

test("an H.265 camera's recording is muxed as hevc", async () => {
  const t = setup();
  await t.rec.setEnabled("CAM1", true);
  const tap = t.rec.tap("CAM1");
  play(t, tap, [HEVC_KEY, HEVC_DELTA, HEVC_DELTA, HEVC_DELTA, HEVC_DELTA, HEVC_DELTA]);
  await tap.finish();
  assert.equal(t.muxed[0].codec, "hevc");
});

test("a viewing shorter than ~2 s is dropped without a file", async () => {
  const t = setup();
  await t.rec.setEnabled("CAM1", true);
  const tap = t.rec.tap("CAM1");
  play(t, tap, [H264_KEY, H264_DELTA, H264_DELTA]); // 1 s
  assert.equal(await tap.finish(), null);
  assert.equal(t.muxed.length, 0);
  assert.deepEqual(filesIn(t.dir), []); // the temp file is removed too
  assert.deepEqual(t.events.at(-1), { event: "recordingState", deviceSn: "CAM1", active: false });
});

test("a stream that never reached a keyframe records nothing and announces nothing", async () => {
  const t = setup();
  await t.rec.setEnabled("CAM1", true);
  const tap = t.rec.tap("CAM1");
  play(t, tap, [H264_DELTA, H264_DELTA]);
  assert.equal(await tap.finish(), null);
  assert.deepEqual(t.events, []);
  assert.deepEqual(filesIn(t.dir), []);
});

test("overlapping requests for one camera make ONE recording, carried on across the hand-over", async () => {
  const t = setup();
  await t.rec.setEnabled("CAM1", true);
  const a = t.rec.tap("CAM1");
  const b = t.rec.tap("CAM1"); // go2rtc reconnected before the old connection closed
  for (const f of [H264_KEY, H264_DELTA, H264_DELTA]) {
    t.now += 500;
    a.onChunk(f);
    b.onChunk(f); // the same frames reach both requests
  }
  assert.equal(await a.finish(), null); // b still streams: the recording goes on
  assert.equal(t.muxed.length, 0);
  t.now += 500;
  b.onChunk(H264_DELTA); // mid-GOP after the hand-over: skipped
  play(t, b, [H264_KEY, H264_DELTA, H264_DELTA]);
  await b.finish();

  assert.equal(t.muxed.length, 1);
  const expected = Buffer.concat([H264_KEY, H264_DELTA, H264_DELTA, H264_KEY, H264_DELTA, H264_DELTA]);
  assert.ok(t.muxed[0].video.equals(expected), "each frame once, the hand-over resumed at a keyframe");
  assert.equal(t.events.filter((e) => e.active).length, 1);
  assert.equal(t.events.filter((e) => !e.active).length, 1);
});

test("a new viewing after the last one ended is a new recording", async () => {
  const t = setup();
  await t.rec.setEnabled("CAM1", true);
  for (let i = 0; i < 2; i++) {
    const tap = t.rec.tap("CAM1");
    play(t, tap, [H264_KEY, H264_DELTA, H264_DELTA, H264_DELTA, H264_DELTA, H264_DELTA]);
    await tap.finish();
    t.now += 60_000;
  }
  assert.equal(t.muxed.length, 2);
  assert.notEqual(t.muxed[0].out, t.muxed[1].out);
});

test("switching a camera off ends its recording in progress and keeps it", async () => {
  const t = setup();
  await t.rec.setEnabled("CAM1", true);
  const tap = t.rec.tap("CAM1");
  play(t, tap, [H264_KEY, H264_DELTA, H264_DELTA, H264_DELTA, H264_DELTA, H264_DELTA]);
  await t.rec.setEnabled("CAM1", false);
  play(t, tap, [H264_KEY, H264_DELTA]); // the stream goes on, unrecorded
  assert.ok(await tap.finish(), "the recording made before switching off is kept");
  assert.equal(t.muxed.length, 1);
  assert.equal(t.muxed[0].video.length, H264_KEY.length + 5 * H264_DELTA.length);
  assert.equal(t.rec.tap("CAM1"), null);
});

test("a failing mux is logged, leaves no file behind, and the next viewing still records", async () => {
  let calls = 0;
  const t = setup({
    mux: async (input, out) => {
      calls++;
      if (calls === 1) {
        fs.writeFileSync(out, "half");
        throw new Error("ffmpeg: boom");
      }
      fs.writeFileSync(out, "MP4");
    },
  });
  await t.rec.setEnabled("CAM1", true);
  const first = t.rec.tap("CAM1");
  play(t, first, [H264_KEY, H264_DELTA, H264_DELTA, H264_DELTA, H264_DELTA, H264_DELTA]);
  assert.equal(await first.finish(), null);
  assert.match(t.warnings.join("\n"), /could not save \(ffmpeg: boom\)/);
  assert.deepEqual(filesIn(t.dir), [], "neither the half-written file nor the temp file is left");

  const second = t.rec.tap("CAM1");
  play(t, second, [H264_KEY, H264_DELTA, H264_DELTA, H264_DELTA, H264_DELTA, H264_DELTA]);
  assert.ok(await second.finish());
});

test("a folder that cannot be written is reported once and nothing is tapped", async () => {
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rec-media-")), "a-file");
  fs.writeFileSync(blocker, "");
  const t = setup({ recordings: path.join(blocker, "eufy") }); // a path under a file: never creatable
  await t.rec.setEnabled("CAM1", true);
  assert.equal(t.rec.tap("CAM1"), null);
  assert.equal(t.rec.tap("CAM1"), null);
  assert.equal(t.warnings.length, 1);
  assert.match(t.warnings[0], /not writable/);
});

test("muxMp4 reads a recording from disk and muxes H.265 with the hevc demuxer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-"));
  const argsFile = path.join(dir, "args");
  const ffmpeg = path.join(dir, "ffmpeg");
  // A stand-in ffmpeg: records its arguments and writes its last one (the output) as the "mp4".
  fs.writeFileSync(
    ffmpeg,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nfor a; do out="$a"; done\necho mp4 > "$out"\n`,
    { mode: 0o755 },
  );
  const input = path.join(dir, "rec.annexb");
  fs.writeFileSync(input, HEVC_KEY);
  const out = path.join(dir, "out.mp4");

  await muxMp4({ videoFile: input, codec: "hevc", fps: 15 }, out, { ffmpeg });

  const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
  const at = args.indexOf("-i");
  assert.deepEqual(args.slice(at - 2, at + 2), ["-f", "hevc", "-i", input]);
  assert.deepEqual(args.slice(args.indexOf("-framerate"), args.indexOf("-framerate") + 2), ["-framerate", "15"]);
  assert.equal(fs.readFileSync(out, "utf8"), "mp4\n");
  assert.ok(fs.existsSync(input), "a file passed in stays for its owner to remove");
});

test("muxMp4 defaults to H.264 from a Buffer and removes its temporary copy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-"));
  const ffmpeg = path.join(dir, "ffmpeg");
  const argsFile = path.join(dir, "args");
  fs.writeFileSync(ffmpeg, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 1\n`, { mode: 0o755 });
  const out = path.join(dir, "out.mp4");

  await assert.rejects(muxMp4({ video: H264_KEY }, out, { ffmpeg }), /ffmpeg/);

  const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
  assert.deepEqual(args.slice(args.indexOf("-i") - 2, args.indexOf("-i") + 2), ["-f", "h264", "-i", `${out}.h264`]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["args", "ffmpeg"], "no temporary input or output left");
});

// ── splitting a long viewing ──

test("a viewing longer than the split is cut at the next keyframe into files that each start on one", async () => {
  const t = setup({ splitMs: 3_000 });
  await t.rec.setEnabled("CAM1", true);
  const tap = t.rec.tap("CAM1");
  // Key at T0+0.5 s, deltas to T0+3.5 s: the 3 s are up at the last delta, but the part ends on a keyframe.
  play(t, tap, [H264_KEY, ...Array(6).fill(H264_DELTA)]);
  assert.equal(t.muxed.length, 0);
  play(t, tap, [H264_KEY, H264_DELTA, H264_DELTA]); // T0+4 s: the second part starts here
  await new Promise((r) => setTimeout(r, 20)); // the first part is muxed while the stream goes on
  assert.equal(t.muxed.length, 1);
  assert.deepEqual(t.rec.active(), ["CAM1"], "still recording after the split");

  const last = await tap.finish();

  assert.equal(t.muxed.length, 2);
  assert.ok(t.muxed[0].video.equals(Buffer.concat([H264_KEY, ...Array(6).fill(H264_DELTA)])));
  assert.ok(t.muxed[1].video.equals(Buffer.concat([H264_KEY, H264_DELTA, H264_DELTA])));
  // Each part is named by its own start and end, under the day IT started: the second began after midnight.
  assert.deepEqual(filesIn(t.dir), [
    path.join("CAM1", "2026-11-09", "235958-000001.mp4"),
    path.join("CAM1", "2026-11-10", "000002-000003.mp4"),
  ]);
  assert.equal(last, path.join(t.dir, "CAM1", "2026-11-10", "000002-000003.mp4"));
  // One "recording" from the first keyframe to the end: no false/true flicker at the split.
  assert.deepEqual(
    t.events.map((e) => e.active),
    [true, false],
  );
});

test("the part after a split is kept however short it is", async () => {
  const t = setup({ splitMs: 2_500 });
  await t.rec.setEnabled("CAM1", true);
  const tap = t.rec.tap("CAM1");
  play(t, tap, [H264_KEY, ...Array(5).fill(H264_DELTA), H264_KEY]); // the viewing ends right after the split
  await tap.finish();
  assert.equal(t.muxed.length, 2);
  assert.ok(t.muxed[1].video.equals(H264_KEY), "a one-frame tail is still the end of the viewing");
});

test("a long viewing splits again and again, each part about as long as the split", async () => {
  const t = setup({ splitMs: 2_000 });
  await t.rec.setEnabled("CAM1", true);
  const tap = t.rec.tap("CAM1");
  for (let i = 0; i < 3; i++) play(t, tap, [H264_KEY, H264_DELTA, H264_DELTA, H264_DELTA, H264_DELTA]);
  await tap.finish();
  assert.equal(t.muxed.length, 3);
  for (const m of t.muxed) assert.equal(m.fps, 2);
  assert.equal(new Set(t.muxed.map((m) => m.out)).size, 3);
  assert.deepEqual(
    filesIn(t.dir).filter((f) => f.includes(".recording-")),
    [],
    "no temporary file left",
  );
});

test("a split of 0 (and none configured) keeps a long viewing in one file", async () => {
  const t = setup({ splitMs: 0 });
  await t.rec.setEnabled("CAM1", true);
  const tap = t.rec.tap("CAM1");
  for (let i = 0; i < 10; i++) play(t, tap, [H264_KEY, H264_DELTA, H264_DELTA], 60_000);
  await tap.finish();
  assert.equal(t.muxed.length, 1);
});

test("a hand-over between overlapping requests does not split by itself", async () => {
  const t = setup({ splitMs: 60_000 });
  await t.rec.setEnabled("CAM1", true);
  const a = t.rec.tap("CAM1");
  const b = t.rec.tap("CAM1");
  play(t, a, [H264_KEY, H264_DELTA, H264_DELTA]);
  await a.finish();
  play(t, b, [H264_KEY, H264_DELTA, H264_DELTA]);
  await b.finish();
  assert.equal(t.muxed.length, 1);
});

// ── retention ──

/** Write `files` (relative paths) under `dir`. */
function plant(dir, files) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), "x");
  }
}

test("oldestKeptDay keeps today and the last N whole days, in local time", () => {
  assert.equal(oldestKeptDay(T0, 1), "2026-11-08"); // 23:59:58 on the 9th in Kolkata
  assert.equal(oldestKeptDay(T0 + 2_000, 1), "2026-11-09"); // two seconds later it is the 10th there
  assert.equal(oldestKeptDay(Date.UTC(2026, 2, 1, 12), 30), "2026-01-30"); // across a month end
});

test("retention deletes only the recorder's own files from days past the limit, at start", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-media-"));
  plant(dir, [
    "CAM1/2026-11-05/120000-121000.mp4", // old: deleted, and the folder with it
    "CAM1/2026-11-06/100000-101000.mp4", // old: deleted
    "CAM1/2026-11-06/notes.txt", // not a recording: kept, so its folder stays
    "CAM1/2026-11-06/100000-101000.mp4.part", // not a finished recording: kept
    "CAM1/2026-11-07/080000-081000.mp4", // within 2 days: kept
    "CAM1/100000-101000.mp4", // not in a day folder: kept
    "CAM2/2026-11-01/090000-091000.mp4", // old: deleted
    "CAM2/old-stuff/090000-091000.mp4", // not a day folder: kept
    "CAM2/2026-11-01x/090000-091000.mp4", // not a day folder: kept
  ]);
  const t = setup({ recordings: dir, keepDays: 2 });

  assert.equal(await t.rec.prune(), 3); // the run at start (already going) counts them

  assert.deepEqual(filesIn(dir), [
    path.join("CAM1", "100000-101000.mp4"),
    path.join("CAM1", "2026-11-06", "100000-101000.mp4.part"),
    path.join("CAM1", "2026-11-06", "notes.txt"),
    path.join("CAM1", "2026-11-07", "080000-081000.mp4"),
    path.join("CAM2", "2026-11-01x", "090000-091000.mp4"),
    path.join("CAM2", "old-stuff", "090000-091000.mp4"),
  ]);
  assert.equal(fs.existsSync(path.join(dir, "CAM1", "2026-11-05")), false, "an emptied day folder is removed");
  assert.equal(fs.existsSync(path.join(dir, "CAM2", "2026-11-01")), false);
  assert.match(t.info.join("\n"), /deleted 3 recording\(s\) from before 2026-11-07/);
  assert.equal(await t.rec.prune(), 0, "nothing more to do");
  assert.equal(t.info.length, 1, "a run that deletes nothing says nothing");
});

test("retention off (0, the default) deletes nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-media-"));
  plant(dir, ["CAM1/2020-01-01/120000-121000.mp4"]);
  const t = setup({ recordings: dir });
  assert.equal(await t.rec.prune(), 0);
  assert.deepEqual(filesIn(dir), [path.join("CAM1", "2020-01-01", "120000-121000.mp4")]);
});

test("retention never touches the day of a recording still in progress", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-media-"));
  const t = setup({ recordings: dir, keepDays: 2 });
  await t.rec.prune(); // the run at start
  plant(dir, ["CAM1/2026-11-06/090000-091000.mp4"]);
  t.now = T0 - 3 * 86_400_000; // a viewing that started on the 6th...
  await t.rec.setEnabled("CAM1", true);
  const tap = t.rec.tap("CAM1");
  play(t, tap, [H264_KEY, ...Array(5).fill(H264_DELTA)]);
  t.now = T0; // ...and is still going three days later
  assert.equal(await t.rec.prune(), 0);
  assert.ok(fs.existsSync(path.join(dir, "CAM1", "2026-11-06", "090000-091000.mp4")));

  await tap.finish(); // kept into the 6th's folder
  assert.equal(await t.rec.prune(), 2, "once kept, the day goes like any other");
  assert.deepEqual(filesIn(dir), []);
});

test("retention runs again every hour", async (ctx) => {
  mock.timers.enable({ apis: ["setInterval"] });
  ctx.after(() => mock.timers.reset());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-media-"));
  const t = setup({ recordings: dir, keepDays: 1 });
  await t.rec.prune();
  plant(dir, ["CAM1/2026-11-01/090000-091000.mp4"]);

  mock.timers.tick(PRUNE_EVERY_MS - 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(filesIn(dir).length, 1, "not before the hour is up");
  mock.timers.tick(1);
  for (let i = 0; i < 300 && !t.info.length; i++) await new Promise((r) => setTimeout(r, 10)); // only setInterval is mocked
  assert.deepEqual(filesIn(dir), []);
  assert.match(t.info.join("\n"), /deleted 1 recording/);
});
