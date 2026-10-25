// A setting written while the camera is streaming goes through the stream's own P2P session (connected,
// camera awake) — the control client's session to a T8151 usually fails with "did not connect within 15 s".
// The T8151 audio-recording fix (raw param 6012) rides the same route.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createWsServer } from "../src/ws-server.mjs";
import { createState } from "../src/state.mjs";

const sn = "T8151X";

function client(session, calls, model = "T8151") {
  return {
    getDevice: async () => ({
      describe: () => ({ sn, model }),
      applyParams: (p) => calls.push(`${session}:apply ${JSON.stringify(p)}`),
    }),
    setProperty: async (s, name, value) => void calls.push(`${session}:set ${name}=${value}`),
    commandContext: async () => ({ channel: 0 }),
    commandSinkFor: () => ({ dispatch: async (cmd) => void calls.push(`${session}:param ${cmd.param}=${cmd.value}`) }),
  };
}

function setup({ streaming = false, model = "T8151" } = {}) {
  const calls = [];
  const state = createState();
  state.flags.ready = true;
  if (streaming) state.activeStreams.set(sn, { lease: Promise.resolve(client("live", calls, model)) });
  const ctx = {
    cfg: {},
    eufy: { ...client("control", calls, model), getDevices: async () => [{ sn }] },
    state,
    SCHEMA_VERSION: 1,
    DEBUG: false,
    dbg: () => {},
    authStatus: () => ({ state: "ok" }),
  };
  const server = http.createServer();
  Object.assign(ctx, createWsServer(ctx, server));
  const set = async (name, value) => {
    const sent = [];
    await ctx.handleMessage(
      { readyState: 1, OPEN: 1, send: (s) => sent.push(JSON.parse(s)) },
      Buffer.from(JSON.stringify({ id: 1, cmd: "device.set", sn, name, value })),
    );
    return sent[0];
  };
  return { calls, set, close: () => server.close() };
}

test("T8151 audioRecording while streaming: param 6012 via the live session, applied to the bridge's view", async () => {
  const t = setup({ streaming: true });
  try {
    assert.equal((await t.set("audioRecording", true)).ok, true);
    assert.ok(t.calls.includes("live:param 6012=1"), t.calls.join(" | "));
    assert.ok(!t.calls.some((c) => c.startsWith("control:param")), "not through the control session");
    assert.ok(t.calls.includes('control:apply {"6012":"1"}'), t.calls.join(" | "));
  } finally {
    t.close();
  }
});

test("not streaming: the control session takes it; another property goes to the SDK's setProperty", async () => {
  const t = setup();
  try {
    assert.equal((await t.set("audioRecording", false)).ok, true);
    assert.ok(t.calls.includes("control:param 6012=0"));
    assert.equal((await t.set("microphone", true)).ok, true);
    assert.ok(t.calls.includes("control:set microphone=true"));
  } finally {
    t.close();
  }
});

test("another model keeps the SDK's write even while streaming (through the live session)", async () => {
  const t = setup({ streaming: true, model: "T8425" });
  try {
    assert.equal((await t.set("audioRecording", true)).ok, true);
    assert.ok(t.calls.includes("live:set audioRecording=true"), t.calls.join(" | "));
  } finally {
    t.close();
  }
});
