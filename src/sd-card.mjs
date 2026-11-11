// The recordings a camera that is its own station keeps on its own card: listed from its `history_record_info`
// table, brought down on request (or by themselves after a detection, when switched on) into the folder of the live
// recordings, `<dir>/<sn>/<YYYY-MM-DD>/<HHMMSS>-<HHMMSS>.mp4`, so a host shows them on the same line of time.
// Nothing on the card is removed. LOCAL — the download by the table's `storage_path` needs the SDK patched for it.
//
// WS `sd_recordings {sn, refresh, thumbnails}`, `sd_sync {sn, files}`, `sd_auto {sn, on}`; HTTP
// `/sd_thumbnail/<sn>/<day>/<file>.jpg`. The same shape as the Neolink bridge's, so a host speaks to both alike.
import fs from "node:fs";
import path from "node:path";
import { normalizePushImage } from "@mega-yfue/eufy-sdk";

import { muxMp4 } from "./clip.mjs";
import { recordingFile } from "./live-recorder.mjs";

/** The file in the data dir that keeps which cameras copy their recordings by themselves. */
export const SD_STATE_FILE = "sd-card.json";
/** How long after a detection the camera's newest recording is copied: it is still being written before. */
export const SD_AUTO_DELAY_MS = 5 * 60_000;
/** How far back the card is read, and in pages of how many rows. */
export const SD_DAYS = 365;
const PAGE_ROWS = 50;
const MAX_PAGES = 60;
/** The newest recordings whose pictures are fetched without being asked: each wakes the camera. */
const AUTO_THUMBNAILS = 48;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
// What a row's `trigger_type` says happened, where it is known.
const KINDS = { 1: "motion", 2: "motion", 4: "person", 8: "pet", 16: "vehicle", 32: "sound", 64: "crying" };

const pad = (n) => String(n).padStart(2, "0");
const ymd = (date) => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;

/** A row's time (`YYYY-MM-DD HH:mm:ss` or `YYYYMMDDHHmmss`, the camera's local time) in ms, or NaN. */
export function rowTime(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length < 14) return Number.NaN;
  const [y, mo, d, h, mi, s] = [0, 4, 6, 8, 10, 12].map((at, i) => Number(digits.slice(at, at + (i ? 2 : 4))));
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** A row's recording as the host sees it: its file under the camera's folder, or null for a row with none. */
export function rowClip(row) {
  const startMs = rowTime(row?.start_time);
  const endMs = rowTime(row?.end_time);
  if (!row?.storage_path || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const file = recordingFile("", "", startMs, Math.max(endMs, startMs)).split(path.sep).filter(Boolean).join("/");
  return { file, startMs, endMs, kinds: KINDS[row.trigger_type] ?? "", size: Number(row.folder_size) || 0 };
}

const iso = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export function createSdCard(ctx) {
  const { cfg, eufy } = ctx;
  const dir = cfg.liveRecordingDir;
  const dataDir = ctx.eventImageDir;
  const mux = ctx.muxSdRecording ?? ((input, out) => muxMp4(input, out, { timeoutMs: 10 * 60_000 }));
  const now = ctx.now ?? Date.now;
  const setTimer = ctx.setTimer ?? setTimeout;
  const log = (line) => ctx.eventLog?.(line);
  const stateFile = dataDir ? path.join(dataDir, SD_STATE_FILE) : null;

  const auto = loadAuto();
  const lists = new Map(); // sn -> { updated, error, rows: Map(file -> row) }
  const reading = new Map(); // sn -> the read of the card in progress
  const queue = []; // { sn, file } waiting to come down, one at a time
  const coming = new Set(); // `${sn}/${file}` queued or coming down
  const autoTimers = new Map(); // sn -> the copy waiting for a detection's recording to be written
  const stations = new Map(); // camera sn -> the station whose table and card hold its recordings
  const stationReads = new Map(); // station sn -> the last read of its table: one read per session at a time
  let downloading = null;

  function loadAuto() {
    if (!stateFile) return new Set();
    try {
      return new Set(JSON.parse(fs.readFileSync(stateFile, "utf8"))?.auto ?? []);
    } catch {
      return new Set();
    }
  }

  function saveAuto() {
    if (!stateFile) return;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ auto: [...auto] }));
  }

  const listFile = (sn) => dataDir && path.join(dataDir, "sd-card", sn, "list.json");
  const thumbFile = (sn, file) => dataDir && path.join(dataDir, "sd-card", sn, file.replace(/\.mp4$/, ".jpg"));
  const localFile = (sn, file) => path.join(dir, sn, file);
  const exists = (file) => !!file && fs.existsSync(file);

  /**
   * Whether a device can list and bring down the recordings its station keeps: a camera behind a station whose
   * recordings the SDK downloads (a HomeBase 2). A camera that is its own station is left out until its download
   * is confirmed.
   */
  function canSdRecordings(m, stationSn, dev) {
    if (!dir || m?.codec !== "camera" || !stationSn || stationSn === m.sn) return false;
    if (typeof dev?.camera?.()?.downloadRecording !== "function") return false;
    stations.set(m.sn, stationSn);
    return true;
  }

  function listOf(sn) {
    if (lists.has(sn)) return lists.get(sn);
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(listFile(sn), "utf8"));
    } catch {
      // not read yet
    }
    const list = { updated: saved?.updated ?? null, error: null, rows: new Map(saved?.rows ?? []) };
    lists.set(sn, list);
    return list;
  }

  async function sessionOf(sn) {
    await eufy.p2p?.ensureStation?.(sn);
    const session = eufy.p2p?.getSessions?.().get(sn) ?? eufy.getP2pSessions?.().get(sn);
    if (typeof session?.queryRecordPage !== "function") throw new Error(`no station session for ${sn}`);
    const devices = await eufy.getDevices();
    const accountId =
      devices.find((d) => d.raw?.member?.admin_user_id)?.raw?.member?.admin_user_id ?? eufy.api?.auth?.userId;
    const p2pDid = devices.find((d) => (d.sn ?? d.serialNumber) === sn);
    return { session, accountId, p2pDid: p2pDid?.p2pDid ?? p2pDid?.raw?.p2p_did };
  }

  /**
   * Read the station's table, newest pages first, keeping this camera's rows, into the remembered list. One read per
   * camera at a time, and the reads of one station one after another.
   */
  function refresh(sn) {
    if (reading.has(sn)) return reading.get(sn);
    const list = listOf(sn);
    const stationSn = stations.get(sn) ?? sn;
    const previous = stationReads.get(stationSn) ?? Promise.resolve();
    const run = previous
      .then(async () => {
        const { session, accountId } = await sessionOf(stationSn);
        const rows = new Map();
        const today = new Date(now());
        const since = ymd(new Date(now() - SD_DAYS * 86_400_000));
        let cursor = "0";
        for (let page = 0; page < MAX_PAGES; page++) {
          const groups = await session.queryRecordPage({
            accountId,
            startDate: since,
            endDate: ymd(today),
            startTime: cursor,
            count: PAGE_ROWS,
          });
          const found = groups
            .filter((group) => group?.table_name === "history_record_info")
            .flatMap((group) => (Array.isArray(group.payload) ? group.payload : []));
          let oldest = null;
          for (const row of found) {
            if (row?.device_sn && row.device_sn !== sn) continue; // another camera of the station
            const clip = rowClip(row);
            if (clip) rows.set(clip.file, row);
            const stamp = String(row?.start_time ?? "").replace(/\D/g, "");
            if (stamp && (!oldest || stamp < oldest)) oldest = stamp;
          }
          if (found.length < PAGE_ROWS || !oldest || oldest === cursor) break;
          cursor = oldest;
        }
        list.rows = rows;
        list.updated = new Date(now()).toISOString();
        list.error = null;
        if (listFile(sn)) {
          await fs.promises.mkdir(path.dirname(listFile(sn)), { recursive: true });
          await fs.promises.writeFile(listFile(sn), JSON.stringify({ updated: list.updated, rows: [...rows] }));
        }
        log(`sd ${sn}: ${rows.size} recordings on the card`);
        fetchThumbnails(sn, [...rows.keys()].sort().slice(-AUTO_THUMBNAILS));
      })
      .catch((e) => {
        list.error = String(e?.message ?? e);
        log(`sd ${sn}: reading the card failed: ${list.error}`);
      })
      .finally(() => reading.delete(sn));
    reading.set(sn, run);
    stationReads.set(stationSn, run);
    return run;
  }

  // Pictures one at a time, in the background: each is a request to the camera.
  const thumbQueue = [];
  let thumbing = false;
  function fetchThumbnails(sn, files) {
    for (const file of files) {
      const row = listOf(sn).rows.get(file);
      if (row?.thumb_path && !exists(thumbFile(sn, file)) && !thumbQueue.some((t) => t.sn === sn && t.file === file))
        thumbQueue.push({ sn, file, row });
    }
    if (!thumbing) void nextThumbnail();
  }

  async function nextThumbnail() {
    const next = thumbQueue.shift();
    if (!next) return void (thumbing = false);
    thumbing = true;
    try {
      const { session, accountId, p2pDid } = await sessionOf(stations.get(next.sn) ?? next.sn);
      const image = await new Promise((resolve) => {
        const onImage = ({ file, data }) => {
          if (file !== next.row.thumb_path || !data) return;
          const jpeg = normalizePushImage(data, p2pDid);
          if (jpeg?.[0] === 0xff && jpeg?.[1] === 0xd8) done(jpeg);
        };
        const done = (value) => {
          clearTimeout(timer);
          session.off?.("image", onImage);
          resolve(value);
        };
        const timer = setTimer(() => done(null), 8000);
        session.on("image", onImage);
        session.requestImage(next.row.thumb_path, { accountId });
      });
      if (image) {
        const file = thumbFile(next.sn, next.file);
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, image);
      }
    } catch (e) {
      log(`sd ${next.sn}: picture of ${next.file} failed: ${e?.message ?? e}`);
    }
    void nextThumbnail();
  }

  /** Queue recordings to come down; the ones already on the disk or coming are left out. */
  function sync(sn, files) {
    const list = listOf(sn);
    let queued = 0;
    for (const file of files ?? []) {
      const key = `${sn}/${file}`;
      if (!list.rows.has(file) || coming.has(key) || exists(localFile(sn, file))) continue;
      coming.add(key);
      queue.push({ sn, file });
      queued++;
    }
    if (!downloading) void nextDownload();
    return queued;
  }

  async function nextDownload() {
    const next = queue.shift();
    if (!next) return void (downloading = null);
    downloading = next;
    const row = listOf(next.sn).rows.get(next.file);
    const out = localFile(next.sn, next.file);
    try {
      const cam = (await eufy.getDevice(next.sn)).camera?.();
      if (typeof cam?.downloadRecording !== "function") throw new Error("this SDK downloads no recording here");
      const recording = path.basename(row.storage_path).replace(/\.[^.]*$/, "");
      const clip = await cam.downloadRecording({
        recording,
        cipherId: row.cipher_id,
        path: row.storage_path,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      });
      await fs.promises.mkdir(path.dirname(out), { recursive: true });
      const tmp = `${out}.part.mp4`;
      await mux(clip, tmp);
      await fs.promises.rename(tmp, out);
      log(
        `sd ${next.sn}: ${next.file} copied (${clip.frames} frames, ${clip.missingFrames} missing, ${clip.durationMs} ms)`,
      );
    } catch (e) {
      log(`sd ${next.sn}: copying ${next.file} failed: ${e?.reason ?? ""} ${e?.message ?? e}`);
    } finally {
      coming.delete(`${next.sn}/${next.file}`);
    }
    void nextDownload();
  }

  /** The answer to `sd_recordings`: what is remembered, at once; `refresh` reads the card in the background. */
  function recordings(sn, { refresh: again = false, thumbnails = [] } = {}) {
    const list = listOf(sn);
    if (again) void refresh(sn);
    if (thumbnails.length) fetchThumbnails(sn, thumbnails);
    const clips = [...list.rows.entries()]
      .map(([file, row]) => {
        const clip = rowClip(row);
        return {
          file,
          start: iso(clip.startMs),
          end: iso(clip.endMs),
          kinds: clip.kinds,
          size: clip.size,
          local: exists(localFile(sn, file)),
          downloading: coming.has(`${sn}/${file}`),
          thumbnail: exists(thumbFile(sn, file)),
        };
      })
      .sort((a, b) => a.start.localeCompare(b.start));
    return { updated: list.updated, refreshing: reading.has(sn), error: list.error, recordings: clips };
  }

  function setAuto(sn, on) {
    if (on) auto.add(sn);
    else auto.delete(sn);
    saveAuto();
    return { on: auto.has(sn) };
  }

  /** `push` listener: a detection on a camera that copies by itself brings its newest recording down later. */
  function notePush(ev) {
    const sn = ev?.deviceSn;
    if (!sn || !auto.has(sn) || autoTimers.has(sn)) return; // several detections in a row: one copy
    autoTimers.set(
      sn,
      setTimer(async () => {
        autoTimers.delete(sn);
        await refresh(sn);
        const newest = [...listOf(sn).rows.keys()].sort().at(-1);
        if (newest) sync(sn, [newest]);
      }, SD_AUTO_DELAY_MS),
    );
  }

  /** The picture of a recording for `/sd_thumbnail/<sn>/<day>/<file>.jpg`, or null. */
  async function thumbnail(sn, day, name) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{6}-\d{6}\.jpg$/.test(name)) return null;
    try {
      return await fs.promises.readFile(thumbFile(sn, `${day}/${name.replace(/\.jpg$/, ".mp4")}`));
    } catch {
      return null;
    }
  }

  return {
    sdCanList: canSdRecordings,
    sdAutoOn: (sn) => auto.has(sn),
    sdRecordings: recordings,
    sdSync: sync,
    sdSetAuto: setAuto,
    sdNotePush: notePush,
    sdThumbnail: thumbnail,
  };
}
