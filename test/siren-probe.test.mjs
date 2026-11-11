// The bounded siren try-out: it asks for a confirmation, keeps to 1-5 s, sends the chosen form and always stops.
import { test } from "node:test";
import assert from "node:assert/strict";

import { SIREN_PROBE_MAX_S, sirenProbe } from "../src/siren-probe.mjs";

function fakeEufy() {
  const sent = [];
  return { sent, commandSinkFor: (sn) => ({ dispatch: async (cmd) => void sent.push([sn, cmd]) }) };
}

const timers = () => {
  const pending = [];
  return { pending, setTimer: (fn, ms) => pending.push([fn, ms]) };
};

test("the self-station form sounds for the seconds asked and stops after them", async () => {
  const eufy = fakeEufy();
  const clock = timers();
  const result = await sirenProbe(eufy, { sn: "T86P", seconds: 5, confirm: "SIREN" }, { setTimer: clock.setTimer });
  assert.deepEqual(result, { sn: "T86P", form: "self-station", seconds: 5, stopsAfterMs: 5000 });
  assert.deepEqual(eufy.sent, [["T86P", { kind: "p2p-int-string", cmd: 1201, value: 5, valueSub: 23, channel: 0 }]]);
  assert.equal(clock.pending[0][1], 5000);
  clock.pending[0][0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(eufy.sent[1], ["T86P", { kind: "p2p-int-string", cmd: 1201, value: 0, valueSub: 4, channel: 0 }]);
});

test("the camera form uses 1202 on channel 0", async () => {
  const eufy = fakeEufy();
  const clock = timers();
  await sirenProbe(eufy, { sn: "T8151", form: "camera", seconds: 2, confirm: "SIREN" }, { setTimer: clock.setTimer });
  clock.pending[0][0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    eufy.sent.map(([, cmd]) => [cmd.cmd, cmd.value, cmd.valueSub, cmd.channel]),
    [
      [1202, 2, 0, 0],
      [1202, 0, 0, 0],
    ],
  );
});

test("the integrated form sounds the station alarm on channel 255 and stops it with valueSub 0", async () => {
  const eufy = fakeEufy();
  const clock = timers();
  await sirenProbe(
    eufy,
    { sn: "T8400", form: "integrated", seconds: 3, confirm: "SIREN" },
    { setTimer: clock.setTimer },
  );
  assert.equal(clock.pending[0][1], 3000);
  clock.pending[0][0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    eufy.sent.map(([, cmd]) => [cmd.cmd, cmd.value, cmd.valueSub, cmd.channel]),
    [
      [1201, 2, 3, 255],
      [1201, 2, 0, 255],
    ],
  );
});

test("nothing is sent without the confirmation, past the limit or with an unknown form", async () => {
  const eufy = fakeEufy();
  await assert.rejects(sirenProbe(eufy, { sn: "X", seconds: 5 }), /confirm/);
  await assert.rejects(sirenProbe(eufy, { sn: "X", seconds: SIREN_PROBE_MAX_S + 1, confirm: "SIREN" }), /1 to 5/);
  await assert.rejects(sirenProbe(eufy, { sn: "X", seconds: 0, confirm: "SIREN" }), /1 to 5/);
  await assert.rejects(sirenProbe(eufy, { sn: "X", seconds: 2.5, confirm: "SIREN" }), /1 to 5/);
  await assert.rejects(sirenProbe(eufy, { sn: "X", form: "loud", seconds: 2, confirm: "SIREN" }), /form/);
  assert.deepEqual(eufy.sent, []);
});

import { hasSelfStationSiren, selfStationSirenAction, withSelfStationSiren } from "../src/siren-probe.mjs";

test("a self-station T8151 gets the siren capability, one behind a HomeBase or another model does not", () => {
  const own = { sn: "T8151A", model: "T8151", capabilities: ["camera", "light"] };
  assert.deepEqual(withSelfStationSiren(own, "T8151A"), ["camera", "light", "siren"]);
  assert.equal(hasSelfStationSiren(own, "T8010HOMEBASE"), false);
  assert.equal(hasSelfStationSiren({ ...own, model: "T86P2" }, own.sn), true);
  assert.equal(hasSelfStationSiren({ ...own, model: "T8400" }, own.sn), true);
  assert.equal(hasSelfStationSiren({ ...own, model: "T8410" }, own.sn), true);
  assert.equal(hasSelfStationSiren({ ...own, model: "T8410C" }, own.sn), true);
  assert.equal(hasSelfStationSiren({ ...own, model: "T8411" }, own.sn), false);
  assert.deepEqual(withSelfStationSiren({ ...own, capabilities: ["siren"] }, own.sn), ["siren"]);
});

test("trigger sounds for the seconds asked and stop sends the stop wire", async () => {
  const eufy = fakeEufy();
  await selfStationSirenAction(eufy, "T8151A", "trigger", [30]);
  await selfStationSirenAction(eufy, "T8151A", "stop");
  assert.deepEqual(
    eufy.sent.map(([, cmd]) => [cmd.cmd, cmd.value, cmd.valueSub, cmd.channel]),
    [
      [1201, 30, 23, 0],
      [1201, 0, 4, 0],
    ],
  );
  await assert.rejects(selfStationSirenAction(eufy, "T8151A", "trigger", [0]), /1 to 900/);
});

test("a T8400 sounds and stops with the integrated form on the station channel", async () => {
  const eufy = fakeEufy();
  await selfStationSirenAction(eufy, "T8400A", "trigger", [30], "T8400");
  await selfStationSirenAction(eufy, "T8400A", "stop", [], "T8400");
  assert.deepEqual(
    eufy.sent.map(([, cmd]) => [cmd.cmd, cmd.value, cmd.valueSub, cmd.channel]),
    [
      [1201, 2, 30, 255],
      [1201, 2, 0, 255],
    ],
  );
});

import { deviceContext } from "../src/siren-probe.mjs";

test("the device context reports what the SDK decides commands by, and nothing else", async () => {
  const eufy = {
    commandContext: async () => ({
      deviceType: 111,
      model: "T0000",
      codec: "camera",
      channel: 0,
      homeBaseAttached: false,
      key: "x",
    }),
  };
  assert.deepEqual(await deviceContext(eufy, "T0000P0000000000"), {
    sn: "T0000P0000000000",
    deviceType: 111,
    model: "T0000",
    codec: "camera",
    channel: 0,
    homeBaseAttached: false,
    stationDeviceType: null,
  });
});
