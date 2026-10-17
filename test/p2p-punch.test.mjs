// P2P_PUNCH_SPREAD: the SDK's ±3 punch is repeated in blocks to cover ±spread, once a second per address.
import { test } from "node:test";
import assert from "node:assert/strict";

import { installWidePunch, punchCentres } from "../src/p2p-punch.mjs";

test("punchCentres tiles ±spread in ±3 blocks around the reported port", () => {
  const centres = punchCentres(37009, 10);
  assert.deepEqual(centres, [37002, 37016]);
  const covered = new Set([37009, ...centres].flatMap((c) => [c - 3, c - 2, c - 1, c, c + 1, c + 2, c + 3]));
  for (let p = 37000; p <= 37019; p++) assert.ok(covered.has(p), `port ${p} covered`);
  assert.ok(covered.has(37015), "the port the camera punched from in the field log");
});

test("punchCentres stays inside the port range", () => {
  assert.ok(punchCentres(5, 20).every((p) => p - 3 > 0));
  assert.ok(punchCentres(65530, 20).every((p) => p + 3 < 65536));
});

function fakeProto() {
  const calls = [];
  return {
    calls,
    beginCheckCam(addr) {
      calls.push(addr.port);
    },
  };
}

test("the widened punch sweeps public addresses once a second and leaves private ones alone", () => {
  const proto = fakeProto();
  let t = 0;
  assert.equal(
    installWidePunch(10, proto, () => t),
    true,
  );
  const session = Object.create(proto);
  const socket = { address: () => ({ port: 5000 }) };
  session.beginCheckCam({ host: "188.33.26.50", port: 8601 }, socket);
  assert.deepEqual(proto.calls, [8601, 8594, 8608]);
  session.beginCheckCam({ host: "188.33.26.50", port: 8601 }, socket);
  assert.equal(proto.calls.length, 4, "a repeat within a second only gets the SDK's own punch");
  t = 1000;
  session.beginCheckCam({ host: "188.33.26.50", port: 8601 }, socket);
  assert.equal(proto.calls.length, 7, "swept again a second later");
  session.beginCheckCam({ host: "192.168.225.99", port: 21441 }, socket);
  assert.equal(proto.calls.length, 8, "a private address gets only the SDK's punch");
});

test("a spread of 3 or less, or a second install, changes nothing", () => {
  const proto = fakeProto();
  const original = proto.beginCheckCam;
  assert.equal(installWidePunch(3, proto), false);
  assert.equal(proto.beginCheckCam, original);
  assert.equal(installWidePunch(20, proto), true);
  assert.equal(installWidePunch(20, proto), false);
});
