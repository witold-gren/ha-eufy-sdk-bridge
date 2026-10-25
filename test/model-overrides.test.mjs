// T8151 keeps "audio recording" in raw param 6012, not the SDK's 1288: the switch must read 6012 and a
// write must go to 6012 — and a model without an override must be left to the SDK.
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyReadOverrides, overrideFor, writeOverride } from "../src/model-overrides.mjs";

const props = (v6012, v1288 = true) => ({
  audioRecording: { value: false, paramType: 1288 }, // the SDK's (wrong) reading on a T8151
  statusInLock: { value: v6012, paramType: 6012 },
  microphone: { value: v1288, paramType: 1240 },
});

test("T8151 audioRecording is read from param 6012", () => {
  assert.equal(applyReadOverrides("T8151", props(true), { audioRecording: false }).audioRecording, true);
  assert.equal(applyReadOverrides("T8151", props("0"), { audioRecording: true }).audioRecording, false);
});

test("other models and a missing 6012 keep the SDK's value", () => {
  assert.equal(applyReadOverrides("T8425", props(true), { audioRecording: false }).audioRecording, false);
  const noParam = { audioRecording: { value: false, paramType: 1288 } };
  assert.equal(applyReadOverrides("T8151", noParam, { audioRecording: false }).audioRecording, false);
  assert.equal(overrideFor("T8425", "audioRecording"), undefined);
});

test("a T8151 write sends param 6012 on the device channel and applies it locally", async () => {
  const sent = [];
  const applied = [];
  const eufy = {
    commandContext: async () => ({ channel: 2 }),
    commandSinkFor: () => ({ dispatch: async (cmd) => sent.push(cmd) }),
    getDevice: async () => ({ applyParams: (p) => applied.push(p) }),
  };
  assert.equal(await writeOverride(eufy, "T8151X", "T8151", "audioRecording", true), true);
  assert.deepEqual(sent, [{ kind: "set-param", param: 6012, value: 1, form: "direct-binary", channel: 2 }]);
  assert.deepEqual(applied, [{ 6012: "1" }]);
  await writeOverride(eufy, "T8151X", "T8151", "audioRecording", false);
  assert.equal(sent[1].value, 0);
});

test("no override → the caller falls back to the SDK's setProperty", async () => {
  const eufy = { commandContext: async () => assert.fail("must not dispatch") };
  assert.equal(await writeOverride(eufy, "X", "T8425", "audioRecording", true), false);
  assert.equal(await writeOverride(eufy, "X", "T8151", "microphone", true), false);
});

test("describeDevice puts the override in decodedState too (the HA integration reads that first)", async () => {
  const { createDeviceView } = await import("../src/device-view.mjs");
  const dev = {
    describe: () => ({
      sn: "T8151X",
      model: "T8151",
      capabilities: ["camera"],
      details: [{ accessor: "audio", reads: [{ accessor: "audioRecording" }] }],
    }),
    getProperties: () => props(true),
    audio: () => ({ audioRecording: false }),
  };
  const view = createDeviceView({ eufy: { getDevice: async () => dev }, state: { streaming: new Set() } });
  const d = await view.describeDevice("T8151X");
  assert.equal(d.state.audioRecording, true);
  assert.equal(d.decodedState.audio.audioRecording, true);
});
