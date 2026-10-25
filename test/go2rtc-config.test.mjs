// The generated go2rtc config is what every consumer ends up pulling, so its source line carries the
// flags that decide whether a stream is usable. `#async` re-stamps frames from the wall clock: without
// it the eufy feed's own timestamps (dts 0, then a jump) make Home Assistant abort a picture that is
// already flowing — "Timestamp discontinuity detected: last dts = 0, dts = 4219155056".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { writeGo2rtcConfig } from "../go2rtc-config.mjs";

const cams = [
  { sn: "CAM1", stream: "/stream/CAM1" },
  { sn: "SENSOR1" }, // no stream path → not a camera, must not appear
];

async function generate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go2rtc-"));
  const file = path.join(dir, "go2rtc.yaml");
  const sns = await writeGo2rtcConfig({ go2rtcConfig: file, selfHost: "127.0.0.1", port: 3000 }, cams);
  return { yaml: fs.readFileSync(file, "utf8"), sns };
}

test("every camera stream is generated with #async", async () => {
  const { yaml, sns } = await generate();
  assert.deepEqual(sns, ["CAM1"]);
  assert.match(yaml, /CAM1: ffmpeg:http:\/\/127\.0\.0\.1:3000\/stream\/CAM1#video=copy#async/);
});

test("a device without a stream path is left out", async () => {
  const { yaml } = await generate();
  assert.ok(!yaml.includes("SENSOR1"), "non-camera devices must not become go2rtc streams");
});

test("with live audio a camera gets a second, audio-only source joined to the same stream", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go2rtc-"));
  const file = path.join(dir, "go2rtc.yaml");
  await writeGo2rtcConfig({ go2rtcConfig: file, selfHost: "127.0.0.1", port: 3000, streamAudio: true }, cams);
  const yaml = fs.readFileSync(file, "utf8");
  assert.match(yaml, /\n {2}CAM1:\n {4}- ffmpeg:http:\/\/127\.0\.0\.1:3000\/stream\/CAM1#video=copy#async\n/);
  assert.match(yaml, /\n {4}- ffmpeg:http:\/\/127\.0\.0\.1:3000\/audio\/CAM1#input=eufy_audio#audio=aac#audio=opus\n/);
  // the audio input template: format named, no analysis (else go2rtc drops the producer before it publishes)
  assert.match(yaml, /\nffmpeg:\n {2}eufy_audio: "[^"]*-f aac -i \{input\}"\n/);
  // copied ADTS has no AAC config and go2rtc's RTSP refuses it — the audio must be re-encoded
  assert.ok(!yaml.includes("#audio=copy"), "the audio source must not copy raw ADTS");
});
