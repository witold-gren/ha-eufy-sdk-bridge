// The WS side of live-view recording: `recording.list` / `recording.set` drive the recorder and persist, a
// bad request is refused, and a camera summary advertises `canRecordLive` only where the bridge can record —
// so a host offers the switch on this bridge and not on an older one.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { createDeviceView } from "../src/device-view.mjs";
import { createLiveRecorder, RECORDING_STATE_FILE } from "../src/live-recorder.mjs";
import { createWsServer } from "../src/ws-server.mjs";

const devices = {
  CAM1: {
    describe: () => ({
      sn: "CAM1",
      name: "Garden",
      model: "T8160",
      modelName: "eufyCam 3",
      codec: "camera",
      capabilities: ["camera", "video", "battery"],
    }),
    getProperties: () => ({}),
    camera: () => ({}),
  },
  SENSOR1: {
    describe: () => ({ sn: "SENSOR1", name: "Door", model: "T8900", codec: "sensor", capabilities: ["contact"] }),
    getProperties: () => ({}),
  },
};

function buildCtx({ recorder = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-ws-data-"));
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-ws-media-"));
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", LIVE_RECORDING_DIR: mediaDir });
  const state = createState();
  state.flags.ready = true;
  const eufy = { getDevice: async (sn) => devices[sn], unobservableMembers: () => new Set() };
  const ctx = { ...config, eufy, state, eventImageDir: dataDir, unobservableMembers: () => [] };
  Object.assign(ctx, createDeviceView(ctx));
  if (recorder) Object.assign(ctx, createLiveRecorder(ctx));
  const httpServer = http.createServer();
  Object.assign(ctx, createWsServer(ctx, httpServer));
  return { ctx, dataDir, httpServer };
}

async function wsCall(ctx, msg) {
  const sent = [];
  const ws = { readyState: 1, OPEN: 1, send: (s) => sent.push(JSON.parse(s)) };
  await ctx.handleMessage(ws, Buffer.from(JSON.stringify(msg)));
  return sent[0];
}

test("recording.list answers with no camera switched on by default", async () => {
  const { ctx, httpServer } = buildCtx();
  assert.deepEqual(await wsCall(ctx, { id: 1, cmd: "recording.list" }), {
    id: 1,
    ok: true,
    enabled: [],
    active: [],
  });
  httpServer.close();
});

test("recording.set switches a camera on and off, persisted, and recording.list follows", async () => {
  const { ctx, dataDir, httpServer } = buildCtx();
  assert.deepEqual(await wsCall(ctx, { id: 1, cmd: "recording.set", deviceSn: "CAM1", enabled: true }), {
    id: 1,
    ok: true,
    deviceSn: "CAM1",
    enabled: true,
  });
  assert.deepEqual((await wsCall(ctx, { id: 2, cmd: "recording.list" })).enabled, ["CAM1"]);
  const saved = () => JSON.parse(fs.readFileSync(path.join(dataDir, RECORDING_STATE_FILE), "utf8")).enabled;
  assert.deepEqual(saved(), ["CAM1"]);

  const off = await wsCall(ctx, { id: 3, cmd: "recording.set", deviceSn: "CAM1", enabled: false });
  assert.equal(off.enabled, false);
  assert.deepEqual((await wsCall(ctx, { id: 4, cmd: "recording.list" })).enabled, []);
  assert.deepEqual(saved(), []);
  httpServer.close();
});

test("recording.set refuses a request without a serial or a boolean", async () => {
  const { ctx, httpServer } = buildCtx();
  for (const bad of [{ enabled: true }, { deviceSn: "CAM1" }, { deviceSn: "CAM1", enabled: "yes" }]) {
    const reply = await wsCall(ctx, { id: 1, cmd: "recording.set", ...bad });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /recording\.set needs/);
  }
  assert.deepEqual(ctx.liveRecorder.list(), []);
  httpServer.close();
});

test("without a recorder the commands fail cleanly and no camera advertises recording", async () => {
  const { ctx, httpServer } = buildCtx({ recorder: false });
  const reply = await wsCall(ctx, { id: 1, cmd: "recording.list" });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /not available/);
  assert.equal((await ctx.describeDevice("CAM1")).canRecordLive, undefined);
  httpServer.close();
});

test("a camera summary advertises canRecordLive; a sensor does not", async () => {
  const { ctx, httpServer } = buildCtx();
  assert.equal((await ctx.describeDevice("CAM1")).canRecordLive, true);
  assert.equal((await ctx.describeDevice("SENSOR1")).canRecordLive, undefined);
  httpServer.close();
});
