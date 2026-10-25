// The param watch is how a wrongly mapped setting gets found: toggle it in the app and the log names the
// raw param that moved. It must log the full list once, then only real changes.
import { test } from "node:test";
import assert from "node:assert/strict";

import { paramChanges, paramMap, startParamWatch } from "../src/param-watch.mjs";

test("paramChanges reports changed, new and gone params, nothing for equal ones", () => {
  const a = paramMap([
    { paramType: 1288, value: "1", name: "audioRecording" },
    { paramType: 1240, value: "1", name: "microphone" },
    { paramType: 99, value: "x", name: "param99" },
  ]);
  const b = paramMap([
    { paramType: 1288, value: "1", name: "audioRecording" },
    { paramType: 1240, value: "0", name: "microphone" },
    { paramType: 6255, value: "0", name: "param6255" },
  ]);
  assert.deepEqual(paramChanges(a, b), [
    "param 99 (param99) gone (was x)",
    "param 1240 (microphone): 1 → 0",
    "param 6255 (param6255) new = 0",
  ]);
  assert.deepEqual(paramChanges(a, a), []);
});

test("logs the full list on the first read, then only changes; off without a spec", async () => {
  let value = "1";
  const logs = [];
  const stop = startParamWatch({
    spec: "CAM1",
    intervalMs: 20,
    inspect: async () => ({ params: [{ paramType: 1288, value, name: "audioRecording" }] }),
    log: (m) => logs.push(m),
  });
  await new Promise((r) => setTimeout(r, 30));
  value = "0";
  await new Promise((r) => setTimeout(r, 60));
  stop();
  const text = logs.join("\n");
  assert.match(text, /CAM1: 1 params\n {2}param 1288 \(audioRecording\) = 1/);
  assert.match(text, /CAM1: param 1288 \(audioRecording\): 1 → 0/);
  assert.equal(text.match(/1 → 0/g).length, 1, "a change is logged once");

  const quiet = [];
  startParamWatch({ spec: "", inspect: async () => ({}), log: (m) => quiet.push(m) })();
  assert.deepEqual(quiet, []);
});
