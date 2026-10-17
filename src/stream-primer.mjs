// Answer /stream at once, before a sleeping camera has woken.
//
// go2rtc serves each camera from `ffmpeg:<this bridge's /stream>`, and its RTSP server answers DESCRIBE only
// once that ffmpeg has probed the codec — i.e. once the first frames arrived. A battery camera on 4G/P2P needs
// 6-20 s to wake and send them, but the RTSP client on the other end (Home Assistant's own go2rtc) waits a
// FIXED 5 s for the DESCRIBE response (`Conn.ReadResponse`, not covered by `#timeout`) and gives up with
// "i/o timeout". The picture then only appears on a second try, while the camera is still awake.
//
// So /stream starts with the camera's last live keyframe (kept by live-still.mjs from the previous viewing)
// and repeats it until the live feed takes over: ffmpeg learns the codec in well under a second, DESCRIBE is
// answered, and the repeats keep the consumer's frame-read deadline (also 5 s) from expiring meanwhile. The
// viewer sees the last picture, then the live one. A keyframe carries its own parameter sets, so each repeat
// decodes on its own; go2rtc's `#async` re-stamps frames from the wall clock, so repeats need no timestamps.
import fs from "node:fs";
import { keyframeCodec, lastLiveKeyframeFile } from "./live-still.mjs";

/** The kept keyframe of a camera as `{ au, codec }`, or null when there is none (or it is not a keyframe). */
export async function loadPrimer(dir, sn) {
  if (!dir) return null;
  try {
    const au = await fs.promises.readFile(lastLiveKeyframeFile(dir, sn));
    const codec = keyframeCodec(au);
    return codec ? { au, codec } : null;
  } catch {
    return null; // never watched yet — the stream starts the old way
  }
}

/**
 * Write `au` to `res` now and every `intervalMs` until the returned stop() is called. Writes stop by
 * themselves once the response is gone. The response's headers must already be sent.
 */
export function startPrimer(res, au, { intervalMs = 500 } = {}) {
  const write = () => {
    if (!res.destroyed && !res.writableEnded) res.write(au);
  };
  write();
  const timer = setInterval(write, intervalMs);
  timer.unref?.();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
