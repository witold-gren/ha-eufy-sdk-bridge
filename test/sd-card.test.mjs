// The recordings on a camera's own card: read from its table, brought down into the folder of the live recordings.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SD_AUTO_DELAY_MS, createSdCard, rowClip, rowTime } from "../src/sd-card.mjs";

const row = (start, end, extra = {}) => ({
  start_time: start,
  end_time: end,
  storage_path: `/media/mmcblk0p1/Camera00/${start.replace(/\D/g, "")}.dat`,
  thumb_path: `/media/mmcblk0p1/Camera00/${start.replace(/\D/g, "")}n.jpg`,
  cipher_id: 7,
  trigger_type: 4,
  folder_size: 1234,
  ...extra,
});

function setup({ pages = [[row("2026-11-10 12:25:59", "2026-11-10 12:26:09")]], download } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sd-card-"));
  const asked = [];
  const images = [];
  const listeners = new Map();
  const session = {
    queryRecordPage: async (opts) => {
      asked.push(opts);
      const payload = pages[asked.length - 1] ?? [];
      return [{ table_name: "history_record_info", payload }];
    },
    requestImage: (file) => {
      images.push(file);
      listeners.get("image")?.({ file, data: Buffer.from([0xff, 0xd8, 1, 2]) });
    },
    on: (name, fn) => listeners.set(name, fn),
    off: (name) => listeners.delete(name),
  };
  const downloads = [];
  const camera = {
    downloadRecording:
      download ??
      (async (opts) => (
        downloads.push(opts),
        { video: Buffer.from("v"), frames: 3, missingFrames: 0, durationMs: 1000 }
      )),
  };
  const timers = [];
  const ctx = {
    cfg: { liveRecordingDir: path.join(root, "rec") },
    eventImageDir: path.join(root, "data"),
    eufy: {
      p2p: { ensureStation: async () => {}, getSessions: () => new Map([["T8410X", session]]) },
      getDevices: async () => [{ sn: "T8410X", raw: { member: { admin_user_id: "acct" } } }],
      getDevice: async () => ({ camera: () => camera }),
    },
    muxSdRecording: async (_clip, out) => fs.promises.writeFile(out, "mp4"),
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    now: () => new Date(2026, 10, 11, 12).getTime(),
  };
  return { root, ctx, sd: createSdCard(ctx), asked, images, downloads, timers };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a row's time and file follow the live recordings' naming", () => {
  assert.equal(rowTime("2026-11-10 12:25:59"), new Date(2026, 10, 10, 12, 25, 59).getTime());
  assert.equal(rowTime("20261110122559"), new Date(2026, 10, 10, 12, 25, 59).getTime());
  assert.ok(Number.isNaN(rowTime("")));
  const clip = rowClip(row("2026-11-10 12:25:59", "2026-11-10 12:26:09"));
  assert.equal(clip.file, "2026-11-10/122559-122609.mp4");
  assert.equal(clip.kinds, "person");
  // A row the card keeps no file for (a cloud one) is left out.
  assert.equal(rowClip(row("2026-11-10 12:25:59", "2026-11-10 12:26:09", { storage_path: "" })), null);
});

test("the remembered list answers at once and a refresh reads the card in the background", async () => {
  const { sd, asked } = setup();
  const first = sd.sdRecordings("T8410X", { refresh: true });
  assert.equal(first.refreshing, true);
  assert.deepEqual(first.recordings, []);
  await settle();
  const after = sd.sdRecordings("T8410X");
  assert.equal(after.refreshing, false);
  assert.deepEqual(after.recordings, [
    {
      file: "2026-11-10/122559-122609.mp4",
      start: "2026-11-10T12:25:59",
      end: "2026-11-10T12:26:09",
      kinds: "person",
      size: 1234,
      local: false,
      downloading: false,
      thumbnail: true,
    },
  ]);
  assert.deepEqual(asked[0], {
    accountId: "acct",
    startDate: "20251111",
    endDate: "20261111",
    startTime: "0",
    count: 50,
  });
});

test("a full page reads the next one from the oldest row", async () => {
  const full = Array.from({ length: 50 }, (_, i) =>
    row(`2026-11-10 12:${String(59 - i).padStart(2, "0")}:00`, "2026-11-10 13:00:00"),
  );
  const { sd, asked } = setup({ pages: [full, [row("2026-11-09 08:00:00", "2026-11-09 08:00:30")]] });
  sd.sdRecordings("T8410X", { refresh: true });
  await settle();
  assert.equal(asked.length, 2);
  assert.equal(asked[1].startTime, "20261110121000");
  assert.equal(sd.sdRecordings("T8410X").recordings.length, 51);
});

test("a recording comes down by the path its row names, into the folder of the line of time", async () => {
  const { sd, root, downloads } = setup();
  sd.sdRecordings("T8410X", { refresh: true });
  await settle();
  assert.equal(sd.sdSync("T8410X", ["2026-11-10/122559-122609.mp4", "2026-11-10/000000-000001.mp4"]), 1);
  assert.equal(sd.sdRecordings("T8410X").recordings[0].downloading, true);
  await settle();
  assert.deepEqual(downloads, [
    {
      recording: "20261110122559",
      cipherId: 7,
      path: "/media/mmcblk0p1/Camera00/20261110122559.dat",
      timeoutMs: 600000,
    },
  ]);
  assert.ok(fs.existsSync(path.join(root, "rec", "T8410X", "2026-11-10", "122559-122609.mp4")));
  const [clip] = sd.sdRecordings("T8410X").recordings;
  assert.equal(clip.local, true);
  assert.equal(clip.downloading, false);
  // On the disk already: not asked for again.
  assert.equal(sd.sdSync("T8410X", ["2026-11-10/122559-122609.mp4"]), 0);
});

test("a failed download leaves no file and frees the recording to be asked again", async () => {
  const { sd, root } = setup({ download: async () => Promise.reject(new Error("no-data")) });
  sd.sdRecordings("T8410X", { refresh: true });
  await settle();
  sd.sdSync("T8410X", ["2026-11-10/122559-122609.mp4"]);
  await settle();
  assert.equal(fs.existsSync(path.join(root, "rec", "T8410X", "2026-11-10", "122559-122609.mp4")), false);
  assert.equal(sd.sdRecordings("T8410X").recordings[0].downloading, false);
});

test("copying by itself waits after a detection, once for several in a row, and survives a restart", async () => {
  const { sd, ctx, timers, downloads } = setup();
  assert.deepEqual(sd.sdSetAuto("T8410X", true), { on: true });
  sd.sdNotePush({ deviceSn: "T8410X" });
  sd.sdNotePush({ deviceSn: "T8410X" });
  sd.sdNotePush({ deviceSn: "OTHER" });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, SD_AUTO_DELAY_MS);
  await timers[0].fn();
  await settle();
  assert.equal(downloads.length, 1);
  assert.equal(createSdCard(ctx).sdAutoOn("T8410X"), true);
  assert.deepEqual(sd.sdSetAuto("T8410X", false), { on: false });
});

test("a camera behind a station the SDK downloads from lists its card; one that is its own station not yet", () => {
  const { sd } = setup();
  const downloads = { camera: () => ({ downloadRecording: async () => {} }) };
  assert.equal(sd.sdCanList({ sn: "C", codec: "camera" }, "HOMEBASE", downloads), true);
  assert.equal(sd.sdCanList({ sn: "C", codec: "camera" }, "C", downloads), false);
  assert.equal(sd.sdCanList({ sn: "C", codec: "camera" }, "HOMEBASE", { camera: () => ({}) }), false);
  assert.equal(sd.sdCanList({ sn: "S", codec: "sensor" }, "HOMEBASE", downloads), false);
});

test("behind a station its table is read and only this camera's rows are kept", async () => {
  const mine = row("2026-11-10 12:25:59", "2026-11-10 12:26:09", { device_sn: "CAM1" });
  const other = row("2026-11-10 13:00:00", "2026-11-10 13:00:20", { device_sn: "CAM2" });
  const { sd, asked } = setup({ pages: [[mine, other]] });
  sd.sdCanList({ sn: "CAM1", codec: "camera" }, "T8410X", { camera: () => ({ downloadRecording: async () => {} }) });
  sd.sdRecordings("CAM1", { refresh: true });
  await settle();
  assert.equal(asked.length, 1);
  assert.deepEqual(
    sd.sdRecordings("CAM1").recordings.map((clip) => clip.file),
    ["2026-11-10/122559-122609.mp4"],
  );
});

test("a picture is served by its day and name only", async () => {
  const { sd } = setup();
  sd.sdRecordings("T8410X", { refresh: true });
  await settle();
  assert.deepEqual([...(await sd.sdThumbnail("T8410X", "2026-11-10", "122559-122609.jpg"))], [0xff, 0xd8, 1, 2]);
  assert.equal(await sd.sdThumbnail("T8410X", "..", "122559-122609.jpg"), null);
  assert.equal(await sd.sdThumbnail("T8410X", "2026-11-10", "../../x.jpg"), null);
});
