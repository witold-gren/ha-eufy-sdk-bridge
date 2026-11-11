// Live audio for go2rtc: GET /audio/<sn> serves the camera's sound as a raw ADTS AAC stream, as a second
// go2rtc source next to the /stream video (go2rtc merges the tracks of a stream's sources). go2rtc reads it
// with `-f aac` and re-encodes it (go2rtc-config.mjs) — raw ADTS cannot be copied into RTSP.
//
// The audio never opens or wakes a camera by itself: it waits for the /stream request of the same camera
// to be live (activeStreams) and joins that request's session — the SDK shares one live source per camera,
// so this is one more consumer on it, not a second P2P session. The budget of a battery camera belongs to
// that shared source and the video request extends it, so this consumer ignores the notices.
//
// Until the camera's sound arrives (a battery camera takes ~20 s to wake), the response is primed with
// silence at the real-time rate: go2rtc's ffmpeg source gives up on a producer that sends nothing for a few
// seconds, and the audio track would then be missing from that viewing. The silence is AAC-LC 16 kHz mono,
// the format eufy cameras send; a camera that sends anything else ends the response with a log line instead
// of a stream go2rtc cannot decode (ADTS cannot change format mid-stream).

/** One silent ADTS frame: AAC-LC, 16 kHz, mono (1024 samples = 64 ms). Encoded once with ffmpeg's aac. */
export const SILENT_AAC_FRAME = Buffer.from("fff16040017ffc01182007", "hex");
export const AAC_FRAME_MS = 64;

/** `{ profile, frequencyIndex, channels }` of an ADTS header, or null when `buf` does not start with one. */
export function adtsHeader(buf) {
  if (!buf || buf.length < 7 || buf[0] !== 0xff || (buf[1] & 0xf0) !== 0xf0) return null;
  return {
    profile: (buf[2] >> 6) + 1, // 2 = AAC-LC
    frequencyIndex: (buf[2] >> 2) & 0x0f, // 8 = 16 kHz
    channels: ((buf[2] & 0x01) << 2) | (buf[3] >> 6),
  };
}

/** True when `frame` (an SDK `{ codec, data }` audio frame) can follow the silent primer in one ADTS stream. */
export function matchesPrimer(frame) {
  if (frame?.codec !== "aac-lc") return false;
  const h = adtsHeader(frame.data);
  return !!h && h.profile === 2 && h.frequencyIndex === 8 && h.channels === 1;
}

/**
 * Serve live audio of `sn` on `res`.
 *  - `activeEntry()` → the /stream entry `{ lease }` while the camera is being watched, else undefined
 *  - `waitMs` — how long to wait (priming silence) for the video to go live before ending
 *  - `log(msg)`
 *  - `onAudio(frame)` — optional, called with every frame of the camera's own sound that is served (never the
 *    silent primer), before a slow sink may drop it; the live-view recorder takes its sound from here
 * Resolves when the response is finished.
 */
export async function serveLiveAudio(
  res,
  sn,
  { activeEntry, waitMs = 120_000, log = () => {}, pollMs = 500, onAudio },
) {
  let closed = false;
  res.once("close", () => (closed = true));
  res.writeHead(200, { "content-type": "audio/aac", "cache-control": "no-cache" });

  // Silence at the real-time rate until the camera's own sound takes over.
  let priming = true;
  const silence = setInterval(() => {
    if (priming && !closed) res.write(SILENT_AAC_FRAME);
  }, AAC_FRAME_MS);
  const stopSilence = () => {
    priming = false;
    clearInterval(silence);
  };

  try {
    // 1. Wait for the video request to make the camera live — never open it from here.
    const until = Date.now() + waitMs;
    let entry = activeEntry();
    while (!entry && !closed && Date.now() < until) {
      await new Promise((r) => setTimeout(r, pollMs));
      entry = activeEntry();
    }
    if (closed) return;
    if (!entry) {
      log(`/audio ${sn} → the camera's video did not go live within ${Math.round(waitMs / 1000)}s — ending`);
      return;
    }

    // 2. Join the live source of that request's session.
    const client = await entry.lease;
    const cam = (await client.getDevice(sn)).camera?.();
    if (!cam?.live) {
      log(`/audio ${sn} → no live() on this camera — silence only`);
      return;
    }
    const consumer = await cam.live();
    if (closed) return consumer.stop();

    await new Promise((resolve) => {
      let first = true;
      let dropping = false;
      const finish = () => {
        stopSilence();
        consumer.stop();
        resolve();
      };
      res.once("close", finish);
      consumer.on("stop", () => {
        res.end();
        finish();
      });
      consumer.on("error", () => {
        res.destroy();
        finish();
      });
      consumer.on("audio", (frame) => {
        if (first) {
          first = false;
          if (!matchesPrimer(frame)) {
            const h = adtsHeader(frame.data);
            log(
              `/audio ${sn} → camera sends ${frame.codec}${h ? ` (profile ${h.profile}, rate index ${h.frequencyIndex}, ${h.channels} ch)` : ""}, not AAC-LC 16 kHz mono — no live audio for it`,
            );
            res.end();
            return finish();
          }
          stopSilence();
          log(`/audio ${sn} → live audio started (AAC-LC 16 kHz mono)`);
        }
        onAudio?.(frame);
        // Audio is tiny; on a slow sink drop frames until it drains rather than buffering seconds of lag.
        if (dropping) return;
        if (!res.write(frame.data)) {
          dropping = true;
          res.once("drain", () => (dropping = false));
        }
      });
    });
  } catch (e) {
    log(`/audio ${sn} → ${e?.message ?? e}`);
    res.destroy();
  } finally {
    stopSilence();
    if (!res.writableEnded && !closed) res.end();
  }
}
