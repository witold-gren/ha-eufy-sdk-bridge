// Record what a viewer watches: an opt-in, per-camera recording of the live view. It is PASSIVE — it never
// opens a stream or wakes a camera; it only copies the access units a /stream request already pipes to its
// consumer, so a battery camera pays nothing extra for it. Whoever opens the live view (a dashboard card,
// Home Assistant's more-info dialog, HomeKit) is recorded the same way, because they all reach the camera
// through go2rtc pulling /stream.
//
// Off for every camera until it is switched on (WS `recording.set`); the switched-on set is kept in the data
// dir so it survives a restart. While a camera streams, its access units go to a temporary Annex-B file
// (minutes of video are never held in memory); when the stream ends, a recording of at least
// MIN_RECORDING_MS is muxed (stream copy, no re-encode) to
//
//   <LIVE_RECORDING_DIR>/<sn>/<YYYY-MM-DD>/<HHMMSS>-<HHMMSS>.mp4
//
// named by its start and end in the container's local time (TZ), and the temporary file is removed.
//
// A long viewing is cut into parts of LIVE_RECORDING_SPLIT_MS: once a part has run that long, the next
// keyframe closes it (it is muxed and kept like a whole recording) and opens the next one, so every file
// starts on a keyframe and plays on its own. The stream is not interrupted and the camera stays "recording"
// (no `recordingState` in between); each part is named by its own start and end and filed under the day it
// started.
//
// Requests for one camera overlap briefly when go2rtc reconnects before the old connection has closed. Both
// carry the same frames, so one camera has ONE recording: one request writes, and when it ends while another
// is still streaming, that one carries on from its next keyframe — the viewing stays one file.
//
// With LIVE_RECORDING_KEEP_DAYS set, recordings are deleted once their day is that many days past: at start
// and every hour after. Only files named the way this recorder names them, in day folders named the way it
// names them, are ever deleted, and a day a recording is still being written to is left alone.
//
// Recording must never affect the stream: a write or mux failure is logged and the stream goes on.
import fs from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { muxMp4 } from "./clip.mjs";
import { keyframeCodec } from "./live-still.mjs";

/** A shorter viewing (a stream that died at once, a reconnect blip) is not kept. */
export const MIN_RECORDING_MS = 2_000;
// The parameter sets lead an access unit: this much of its start is read to find them.
const PARAMETER_HEAD_BYTES = 1024;

/**
 * The sequence parameter set of a keyframe access unit, as hex (H.264 type 7, H.265 type 33), else null. A
 * camera that changes its picture (e.g. a 720p start, then 4K) sends a new one; an MP4 holds only the first,
 * and Apple's players decode every frame by it, so a recording must not run on across such a change.
 */
export function sequenceParameterSet(au) {
  const head = au.subarray(0, Math.min(au.length, PARAMETER_HEAD_BYTES));
  const codec = keyframeCodec(head);
  if (!codec) return null;
  const startsAt = (i) => head[i] === 0 && head[i + 1] === 0 && head[i + 2] === 1;
  for (let i = 0; i + 4 < head.length; i++) {
    if (!startsAt(i)) continue;
    const b = head[i + 3];
    if (codec === "h264" ? (b & 0x1f) !== 7 : ((b >> 1) & 0x3f) !== 33) continue;
    let end = i + 3;
    while (end + 2 < head.length && !startsAt(end)) end++;
    if (end + 2 >= head.length) end = head.length;
    while (end > i + 4 && head[end - 1] === 0) end--; // the leading zero of a 4-byte start code is not the SPS
    return Buffer.from(head.subarray(i + 3, end)).toString("hex");
  }
  return null;
}

/** The file in the data dir that keeps which cameras record. */
export const RECORDING_STATE_FILE = "live-recording.json";

/** How often old recordings are looked for when LIVE_RECORDING_KEEP_DAYS is set. */
export const PRUNE_EVERY_MS = 60 * 60_000;

// What retention may delete: a recording's own name, in a day folder's own name. Anything else is left alone.
const RECORDING_NAME = /^\d{6}-\d{6}\.mp4$/;
const DAY_NAME = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n) => String(n).padStart(2, "0");

/** `{ day: "YYYY-MM-DD", time: "HHMMSS" }` of a moment, in the process's local time zone (TZ). */
export function localStamp(ms) {
  const d = new Date(ms);
  return {
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
  };
}

/** Where a recording from `startMs` to `endMs` is kept: `<dir>/<sn>/<YYYY-MM-DD>/<HHMMSS>-<HHMMSS>.mp4`. */
export function recordingFile(dir, sn, startMs, endMs) {
  const start = localStamp(startMs);
  return path.join(dir, sn, start.day, `${start.time}-${localStamp(endMs).time}.mp4`);
}

/**
 * The oldest day folder (`YYYY-MM-DD`, local time) kept when recordings are kept `keepDays` days at `nowMs`;
 * every older one is deleted. A day goes once all of it is more than `keepDays` days past, so every
 * recording is kept at least that long — with 1, today's and yesterday's stay.
 */
export function oldestKeptDay(nowMs, keepDays) {
  const d = new Date(nowMs);
  // Noon, so a daylight-saving change can never move it to another day.
  return localStamp(new Date(d.getFullYear(), d.getMonth(), d.getDate() - keepDays, 12).getTime()).day;
}

/**
 * The live-view recorder. Reads off ctx: `cfg.liveRecordingDir` (where recordings go),
 * `cfg.liveRecordingSplitMs` (the longest part, 0 = never split), `cfg.liveRecordingKeepDays` (0 = keep for
 * good), `eventImageDir` (the data dir, where the switched-on set is kept), `eventLog`, and `broadcast` at
 * call time. Tests may supply `now`, `muxRecording` (in place of ffmpeg), `minRecordingMs`, `pruneEveryMs`,
 * `info` and `warn`.
 */
export function createLiveRecorder(ctx) {
  const dir = ctx.cfg.liveRecordingDir;
  const splitMs = ctx.cfg.liveRecordingSplitMs ?? 0;
  const keepDays = ctx.cfg.liveRecordingKeepDays ?? 0;
  const stateFile = ctx.eventImageDir ? path.join(ctx.eventImageDir, RECORDING_STATE_FILE) : null;
  const now = ctx.now ?? Date.now;
  // A long viewing is still a stream copy, but give ffmpeg more than a detection clip's minute.
  const mux = ctx.muxRecording ?? ((input, out) => muxMp4(input, out, { timeoutMs: 10 * 60_000 }));
  const minMs = ctx.minRecordingMs ?? MIN_RECORDING_MS;
  const log = (line) => ctx.eventLog?.(line);
  const info = ctx.info ?? ((line) => console.log(`[bridge] ${line}`));
  const warn = ctx.warn ?? ((line) => console.warn(`[bridge] ${line}`));

  const enabledSet = loadEnabled();
  const sessions = new Map(); // sn -> the camera's recording in progress
  const unsaved = new Set(); // parts opened and not yet kept or dropped: retention leaves their day alone
  let saving = Promise.resolve();
  let pruning = null;
  let dirWarned = false;

  function loadEnabled() {
    if (!stateFile) return new Set();
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return new Set((saved?.enabled ?? []).filter((sn) => typeof sn === "string" && sn));
    } catch (e) {
      if (e?.code !== "ENOENT") warn(`live recording: could not read ${stateFile} (${e?.message ?? e}) — none on`);
      return new Set();
    }
  }

  /** Persist the switched-on set (write + rename, one save at a time). */
  function saveEnabled() {
    if (!stateFile) return Promise.resolve();
    const body = JSON.stringify({ enabled: list() }, null, 2) + "\n";
    const run = saving.then(async () => {
      const tmp = `${stateFile}.tmp`;
      await fs.promises.writeFile(tmp, body);
      await fs.promises.rename(tmp, stateFile);
    });
    saving = run.catch(() => {});
    return run;
  }

  /** Whether recordings can be written now; says why not once, until it works again. */
  function dirWritable() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      dirWarned = false;
      return true;
    } catch (e) {
      if (!dirWarned) {
        dirWarned = true;
        warn(
          `live recording: ${dir} is not writable (${e?.message ?? e}) — not recording; map the folder ` +
            "read-write or point LIVE_RECORDING_DIR elsewhere",
        );
      }
      return false;
    }
  }

  const announce = (sn, active) => ctx.broadcast?.({ event: "recordingState", deviceSn: sn, active });

  function fail(part, e) {
    if (part.error) return;
    part.error = e;
    warn(`live recording ${part.sn}: write failed (${e?.message ?? e}) — this recording is not kept`);
  }

  /**
   * At a keyframe: open a part's temporary file. The first part says the camera is recording; a later one
   * (after a split) carries on without a word.
   */
  function openPart(s, codec, continued) {
    s.codec = codec;
    const part = { sn: s.sn, codec, startedAt: now(), frames: 0, continued };
    part.lastAt = part.startedAt;
    s.part = part;
    unsaved.add(part);
    try {
      const camDir = path.join(dir, s.sn);
      fs.mkdirSync(camDir, { recursive: true });
      part.tmp = path.join(camDir, `.recording-${part.startedAt}.annexb`);
      part.out = fs.createWriteStream(part.tmp);
      part.out.on("error", (e) => fail(part, e));
    } catch (e) {
      fail(part, e);
      return;
    }
    if (!s.announced) {
      s.announced = true;
      announce(s.sn, true);
      log(`/stream ${s.sn} → recording the live view (${codec})`);
    }
  }

  /** Close the current part; it is kept (muxed) once the parts before it are. */
  function closePart(s) {
    const part = s.part;
    if (!part) return;
    s.part = null;
    part.out?.end();
    s.saved = s.saved.then(() => keep(part));
  }

  function onChunk(s, handle, chunk) {
    if (s.stopped) return;
    if (s.owner && s.owner !== handle) return; // an overlapping request: its frames are the owner's too
    const resume = !s.owner;
    // A keyframe with other parameters (the camera changed its picture) starts a new file.
    const sps = s.part ? sequenceParameterSet(chunk) : null;
    const changed = !!sps && !!s.part.sps && sps !== s.part.sps;
    const due = !!s.part && ((splitMs > 0 && now() - s.part.startedAt >= splitMs) || changed);
    if (resume || due) {
      // Start, split, or carry on after the writing request ended — always at a keyframe, so each file
      // decodes on its own.
      const codec = keyframeCodec(chunk);
      const usable = !!codec && (!s.codec || codec === s.codec);
      if (resume) {
        if (!usable) return;
        s.owner = handle;
      }
      if (usable && (!s.part || due)) {
        const continued = !!s.part || !!s.announced;
        if (s.part) {
          // Cut by the camera, not by the viewer: kept however short, the next file goes on where it ends.
          if (changed) s.part.cut = true;
          const why = changed ? "the camera changed its picture" : "the split";
          log(`/stream ${s.sn} → recording split after ${Math.round((now() - s.part.startedAt) / 1000)} s (${why})`);
        }
        closePart(s);
        openPart(s, codec, continued);
      }
    }
    const part = s.part;
    if (part && !part.sps) part.sps = sps ?? sequenceParameterSet(chunk);
    if (!part?.out || part.error) return;
    part.out.write(Buffer.from(chunk)); // a copy: the feed may reuse its buffers
    part.frames++;
    part.lastAt = now();
  }

  /** Stop recording a camera and keep what was recorded. Resolves with the last file written, or null. */
  function stop(s) {
    if (s.done) return s.done;
    s.stopped = true;
    if (sessions.get(s.sn) === s) sessions.delete(s.sn);
    if (s.announced) announce(s.sn, false);
    closePart(s);
    s.done = s.saved;
    return s.done;
  }

  /** Mux a closed part into its file. Resolves with the file, or null when it is not kept. */
  async function keep(part) {
    let mp4;
    try {
      if (!part.out) return null; // its file could not be opened: already said so
      await finished(part.out).catch(() => {}); // a failed write already said so
      if (part.error) return null;
      const durationMs = part.lastAt - part.startedAt;
      // A part after a split is the rest of a viewing already kept, however short it is.
      if (!part.continued && !part.cut && durationMs < minMs) {
        log(`/stream ${part.sn} → recording dropped: only ${durationMs} ms`);
        return null;
      }
      const file = recordingFile(dir, part.sn, part.startedAt, part.lastAt);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      mp4 = `${file}.part`; // never a half-written .mp4 in the media browser
      // The Annex-B file carries no timestamps: give ffmpeg the rate the frames actually came at, so the
      // recording lasts as long as the viewing did.
      const fps = part.frames > 1 && durationMs > 0 ? Math.round(((part.frames - 1) * 100_000) / durationMs) / 100 : 0;
      await mux({ videoFile: part.tmp, codec: part.codec, fps }, mp4);
      await fs.promises.rename(mp4, file);
      log(`/stream ${part.sn} → recording kept: ${file} (${part.frames} frames, ${Math.round(durationMs / 1000)} s)`);
      return file;
    } catch (e) {
      warn(`live recording ${part.sn}: could not save (${e?.message ?? e})`);
      if (mp4) await fs.promises.rm(mp4, { force: true }).catch(() => {});
      return null;
    } finally {
      if (part.tmp) await fs.promises.rm(part.tmp, { force: true }).catch(() => {});
      unsaved.delete(part);
    }
  }

  /**
   * Delete the recordings whose day is more than `keepDays` days past, and the day folders that leaves
   * empty. Touches nothing but `<dir>/<sn>/<YYYY-MM-DD>/<HHMMSS>-<HHMMSS>.mp4`, and never the day of a
   * recording in progress (or still being muxed). Resolves with how many files were deleted.
   */
  function prune() {
    if (!(keepDays > 0)) return Promise.resolve(0);
    if (pruning) return pruning; // one run at a time
    pruning = pruneOnce().finally(() => (pruning = null));
    return pruning;
  }

  async function pruneOnce() {
    const oldest = oldestKeptDay(now(), keepDays);
    const busy = new Set([...unsaved].map((p) => `${p.sn}/${localStamp(p.startedAt).day}`));
    const subdirs = async (p) => (await fs.promises.readdir(p, { withFileTypes: true })).filter((e) => e.isDirectory());
    let cameras;
    try {
      cameras = await subdirs(dir);
    } catch (e) {
      if (e?.code !== "ENOENT") warn(`live recording: could not list ${dir} for old recordings (${e?.message ?? e})`);
      return 0;
    }
    let removed = 0;
    for (const cam of cameras) {
      const days = await subdirs(path.join(dir, cam.name)).catch(() => []);
      for (const day of days) {
        if (!DAY_NAME.test(day.name) || day.name >= oldest || busy.has(`${cam.name}/${day.name}`)) continue;
        const dayDir = path.join(dir, cam.name, day.name);
        try {
          for (const f of await fs.promises.readdir(dayDir, { withFileTypes: true })) {
            if (!f.isFile() || !RECORDING_NAME.test(f.name)) continue;
            await fs.promises.rm(path.join(dayDir, f.name));
            removed++;
          }
          await fs.promises.rmdir(dayDir).catch(() => {}); // left alone while anything else is in it
        } catch (e) {
          warn(`live recording: could not delete old recordings in ${dayDir} (${e?.message ?? e})`);
        }
      }
    }
    if (removed)
      info(
        `live recording: deleted ${removed} recording(s) from before ${oldest} (LIVE_RECORDING_KEEP_DAYS=${keepDays})`,
      );
    return removed;
  }

  if (keepDays > 0) {
    const run = () => void prune().catch((e) => warn(`live recording: retention failed (${e?.message ?? e})`));
    run();
    setInterval(run, ctx.pruneEveryMs ?? PRUNE_EVERY_MS).unref?.();
  }

  function list() {
    return [...enabledSet].sort();
  }

  return {
    liveRecorder: {
      /** Whether the live view of `sn` is recorded. */
      enabled: (sn) => enabledSet.has(sn),
      /** The cameras whose live view is recorded. */
      list,
      /** The cameras being recorded right now. */
      active: () => [...sessions.values()].filter((s) => s.part?.out && !s.part.error).map((s) => s.sn),
      /** Delete the recordings LIVE_RECORDING_KEEP_DAYS no longer keeps (it also runs by itself). */
      prune,
      /**
       * Switch recording on or off for a camera and persist it. Switching off ends a recording in progress
       * (what was recorded so far is kept). Rejects, leaving the setting as it was, when it cannot be saved.
       */
      async setEnabled(sn, on) {
        if (enabledSet.has(sn) === on) return;
        if (on) enabledSet.add(sn);
        else enabledSet.delete(sn);
        try {
          await saveEnabled();
        } catch (e) {
          if (on) enabledSet.delete(sn);
          else enabledSet.add(sn);
          throw e;
        }
        const s = sessions.get(sn);
        if (!on && s) void stop(s);
      },
      /**
       * A tap for one /stream request of `sn`: `{ onChunk, finish }`, or null when the camera is not
       * recorded (or the folder cannot be written). `onChunk` takes every access unit the request pipes;
       * `finish` is called once it ends and resolves when the recording, if this ended it, is saved.
       * Neither ever throws.
       */
      tap(sn) {
        if (!enabledSet.has(sn)) return null;
        let s = sessions.get(sn);
        if (!s) {
          if (!dirWritable()) return null;
          s = { sn, handles: new Set(), owner: null, part: null, saved: Promise.resolve(null) };
          sessions.set(sn, s);
        }
        const session = s;
        const handle = {
          onChunk: (chunk) => {
            try {
              onChunk(session, handle, chunk);
            } catch (e) {
              if (session.part) fail(session.part, e);
            }
          },
          finish: () => {
            if (!session.handles.delete(handle)) return session.done ?? Promise.resolve(null);
            if (session.owner === handle) session.owner = null;
            if (session.handles.size && !session.stopped) return Promise.resolve(null);
            return stop(session);
          },
        };
        session.handles.add(handle);
        return handle;
      },
    },
  };
}
