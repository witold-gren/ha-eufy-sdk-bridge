// /stream records a watched live view for a camera switched on for it — from the frames it already pipes,
// starting with the camera's own first keyframe (never the instant-start picture), primary view only — and
// leaves every other camera alone. Drives the real handler and recorder against a fake camera and muxer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { createLiveRecorder } from "../src/live-recorder.mjs";
import { lastLiveKeyframeFile } from "../src/live-still.mjs";

process.env.BRIDGE_STREAM_CONSUMER_LOG_MS = "0"; // no real HTTP at :1984 from the consumer probe
const { createHttpHandler } = await import("../src/http-routes.mjs");

const SC = [0x00, 0x00, 0x00, 0x01];
const au = (...nals) => Buffer.from(nals.flatMap((n) => [...SC, ...n]));
const KEPT_KEY = au([0x67, 0x42, 0x00, 0x1e], [0x68, 0xce, 0x38, 0x80], [0x65, 0x88]); // the instant-start picture
const LIVE_KEY = au([0x67, 0x64, 0x00, 0x1f], [0x68, 0xee, 0x3c], [0x65, 0x88, 0x84]);
const DELTA = au([0x41, 0x9a, 0x02]);

async function until(cond, what) {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/** A bridge HTTP server over a fake two-view camera, with the real recorder and a fake muxer. */
async function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-route-data-"));
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-route-media-"));
  fs.writeFileSync(lastLiveKeyframeFile(dataDir, "CAM1"), KEPT_KEY); // instant start answers with this
  const config = loadConfig({
    EUFY_EMAIL: "x@y.z",
    EUFY_PASSWORD: "pw",
    STREAM_PRIMER_MS: "20",
    LIVE_RECORDING_DIR: mediaDir,
  });
  const state = createState();
  state.flags.ready = true;
  const t = { feeds: [], muxed: [], events: [] };
  const ctx = {
    ...config,
    state,
    eventImageDir: dataDir,
    eventLog: () => {},
    broadcast: (msg) => void t.events.push(msg),
    noteStreamOpened: () => {},
    noteStreamFailure: () => {},
    streamBackoffMs: () => 0,
    dropStreamClient: () => {},
    minRecordingMs: 0,
    muxRecording: async (input, out) => {
      t.muxed.push({ ...input, video: fs.readFileSync(input.videoFile) });
      fs.writeFileSync(out, "MP4");
    },
    streamClientFor: async () => ({
      getDevice: async () => ({
        camera: () => ({
          views: () => [0, 1],
          openReadable: async () => {
            const feed = new PassThrough();
            t.feeds.push(feed);
            return feed;
          },
        }),
      }),
    }),
  };
  Object.assign(ctx, createLiveRecorder(ctx));
  t.recorder = ctx.liveRecorder;
  const server = http.createServer((req, res) => void createHttpHandler(ctx)(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.port = server.address().port;
  t.close = () => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  };
  return t;
}

/** Watch `url` while the camera sends a keyframe and two deltas, then end the feed. */
async function watch(t, url) {
  const opened = t.feeds.length;
  const done = new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: t.port, path: url }, (res) => {
      res.resume();
      res.on("end", resolve);
      res.on("aborted", resolve);
      res.on("error", resolve);
    });
  });
  await until(() => t.feeds.length > opened, "live feed opened");
  const feed = t.feeds.at(-1);
  for (const f of [LIVE_KEY, DELTA, DELTA]) {
    feed.write(f);
    await new Promise((r) => setTimeout(r, 15));
  }
  feed.end();
  await done;
}

test("a switched-on camera's live view is recorded from its own first keyframe", async () => {
  const t = await setup();
  try {
    await t.recorder.setEnabled("CAM1", true);
    await watch(t, "/stream/CAM1");
    await until(() => t.muxed.length === 1, "recording muxed");
    assert.ok(
      t.muxed[0].video.equals(Buffer.concat([LIVE_KEY, DELTA, DELTA])),
      "the live frames only — not the instant-start picture",
    );
    assert.equal(t.muxed[0].codec, "h264");
    assert.deepEqual(
      t.events.filter((e) => e.event === "recordingState"),
      [
        { event: "recordingState", deviceSn: "CAM1", active: true },
        { event: "recordingState", deviceSn: "CAM1", active: false },
      ],
    );
  } finally {
    await t.close();
  }
});

test("a camera that is not switched on is not recorded", async () => {
  const t = await setup();
  try {
    await watch(t, "/stream/CAM1");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.muxed.length, 0);
    assert.equal(
      t.events.some((e) => e.event === "recordingState"),
      false,
    );
  } finally {
    await t.close();
  }
});

test("only the primary view is recorded", async () => {
  const t = await setup();
  try {
    await t.recorder.setEnabled("CAM1", true);
    await watch(t, "/stream/CAM1?view=1");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.muxed.length, 0);
  } finally {
    await t.close();
  }
});
