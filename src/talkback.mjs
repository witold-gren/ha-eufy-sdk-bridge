// Talkback: POST /talk/<sn> plays the request body on the camera's speaker, streamed. The body is either
// ADTS AAC-LC at the camera's rate (16 kHz mono on eufy cameras), or - with `?format=s16le&rate=<Hz>` -
// raw 16-bit little-endian mono PCM straight from a browser microphone, which the bundled ffmpeg encodes to
// that AAC on the fly. A dashboard streams the microphone through its Home Assistant integration into this
// route, and a file can be posted the same way. The SDK paces the frames to the camera at their playback
// rate (`camera().talkback()`), so a file plays at speed and a live microphone keeps the queue near empty.
//
// Once the camera takes the talk (a camera on a battery or on Wi-Fi takes seconds to wake) the answer starts at
// once, as lines of JSON: `{"state":"connected"}`, then the outcome last - `{"ok":true,...}`, or an `error` with the
// `status` it would have had - so a dashboard can show the wait. A refusal before that is a plain JSON answer with
// its HTTP status.
//
// One talker per camera: a second POST while the first is still talking is refused with 409, because the
// camera has one speaker and two interleaved sources would be noise. The talkback ends with the request -
// the body finishing (a file), the client going away (a released talk button), or the camera's session
// closing - and the camera is never left holding an open media session.
import { spawn as spawnProcess } from "node:child_process";

const PCM_RATES = { min: 8000, max: 48000 };
// How long a microphone's last frames may take to play once the talker stopped, before the talk ends anyway.
export const SETTLE_MS = 10_000;

function json(res, code, body) {
  if (res.headersSent) return res.end();
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * The body's format from the query: `null` for ADTS AAC (no `format`), `{ rate }` for s16le PCM, or
 * `{ error }` for a format or rate this route does not take.
 */
export function talkFormat(query) {
  const format = query?.get("format");
  if (!format) return null;
  if (format !== "s16le") return { error: `unknown format "${format}" (s16le, or none for ADTS AAC)` };
  const rate = Number(query.get("rate"));
  if (!Number.isInteger(rate) || rate < PCM_RATES.min || rate > PCM_RATES.max) {
    return { error: `rate must be a whole number of Hz from ${PCM_RATES.min} to ${PCM_RATES.max}` };
  }
  return { rate };
}

/** ffmpeg arguments: s16le mono PCM at `rate` on stdin → ADTS AAC-LC 16 kHz mono on stdout, low latency. */
export function pcmEncoderArgs(rate) {
  return [
    "-hide_banner", "-loglevel", "error",
    "-f", "s16le", "-ar", String(rate), "-ch_layout", "mono", "-i", "pipe:0",
    "-ar", "16000", "-ac", "1", "-c:a", "aac", "-b:a", "32k",
    "-flush_packets", "1", "-f", "adts", "pipe:1",
  ]; // prettier-ignore
}

/**
 * Serve one talkback request. `eufy` answers `getDevice(sn)`; `talking` is the set of cameras with a talker
 * now (shared across requests); `query` is the request's search params; `log` gets one line per talk;
 * `spawn` starts the PCM encoder (a test passes a fake).
 */
export async function serveTalkback(
  req,
  res,
  sn,
  { eufy, talking, query, log = () => {}, spawn = spawnProcess, ffmpeg = "ffmpeg", settleMs = SETTLE_MS },
) {
  if (req.method !== "POST") return json(res, 405, { error: "POST the audio to /talk/<sn>" });
  const format = talkFormat(query);
  if (format?.error) return json(res, 400, { error: format.error });
  if (talking.has(sn)) return json(res, 409, { error: "someone is already talking on this camera" });
  talking.add(sn);

  let handle;
  try {
    const talkback = (await eufy.getDevice(sn)).camera?.()?.talkback;
    if (typeof talkback !== "function") {
      talking.delete(sn);
      return json(res, 404, { error: "this camera has no speaker for talkback" });
    }
    handle = await talkback();
  } catch (e) {
    talking.delete(sn);
    log(`/talk ${sn} → 502 ${e?.message ?? e}`);
    return json(res, 502, { error: "talkback could not start", reason: String(e?.message ?? e) });
  }
  if (handle.codec !== "aac-lc") {
    // AAC-ELD speakers take raw access units, not ADTS; there is no encoder for them here yet.
    talking.delete(sn);
    await handle.stop();
    return json(res, 415, { error: "this camera's speaker plays another codec", codec: handle.codec });
  }

  const started = Date.now();
  let errors = 0;
  let done = false;
  let encoder = null;
  log(`/talk ${sn} → talking (${handle.codec}${format ? `, from s16le ${format.rate} Hz` : ""})`);
  // The camera listens now: say so at once, the outcome follows as the last line.
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  res.write(`${JSON.stringify({ state: "connected" })}\n`);
  const finish = async (status, body) => {
    if (done) return;
    done = true;
    talking.delete(sn);
    encoder?.kill("SIGKILL");
    await handle.stop();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    log(`/talk ${sn} → ${status} after ${seconds}s${errors ? `, ${errors} frame error(s)` : ""}`);
    if (!res.writableEnded) res.end(`${JSON.stringify({ ...body, status, seconds: Number(seconds) })}\n`);
  };
  handle.on("error", (e) => {
    errors += 1;
    if (errors === 1) log(`/talk ${sn} frame error: ${e?.message ?? e}`);
  });
  // The camera closed its session (or someone stopped it): the rest of the body has nowhere to go.
  handle.on("stop", () => void finish(503, { error: "the camera ended the talkback" }));
  // A finite body (a file) is complete once every frame reached the camera.
  handle.on("finished", () => void finish(200, { ok: true }));
  // The talker went away (released button, closed browser) - stop at once.
  req.on("close", () => {
    if (!req.complete) void finish(499, { error: "the talker went away" });
  });

  if (!format) {
    req.pipe(handle.writable());
    return;
  }
  // PCM: the request feeds ffmpeg, whose ADTS output feeds the camera; ffmpeg's end ends the talk.
  encoder = spawn(ffmpeg, pcmEncoderArgs(format.rate), { stdio: ["pipe", "pipe", "pipe"] });
  let encoderError = "";
  encoder.stderr?.on("data", (chunk) => (encoderError = (encoderError + chunk).slice(-300)));
  encoder.on("error", (e) => void finish(500, { error: "the audio encoder could not start", reason: e.message }));
  encoder.on("close", (code) => {
    if (code) return void finish(500, { error: "the audio encoder failed", reason: encoderError.trim() });
    // The talker stopped. The speaker says "finished" once the last frames played - but with no frames at all
    // (a button tapped and released at once) it never does, and the camera would stay taken; so not for long.
    setTimeout(() => void finish(200, { ok: true }), settleMs).unref?.();
  });
  encoder.stdin.on("error", () => {}); // the encoder quitting first is reported by its close
  req.pipe(encoder.stdin);
  encoder.stdout.pipe(handle.writable());
}
