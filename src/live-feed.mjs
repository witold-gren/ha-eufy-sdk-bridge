// Open a camera's live video as a node:stream Readable of Annex-B access units — like the SDK's
// openReadable(), but without losing the battery-budget notice.
//
// The SDK bounds a battery camera's stream to a budget (45 s by default) and then emits `budget` on each
// consumer, with an `extend()` handle and a 10 s grace before it stops the stream. openReadable() wraps the
// consumer in a Readable and drops that event, so a watched battery stream always ended after ~55 s: the
// viewer froze, the "streaming" sensor went off, and only reopening the view (while the camera was still
// awake) brought the picture back. live() hands over the consumer itself, so the bridge builds the Readable
// here and passes `budget` on to the route, which decides whether someone is still watching.
import { Readable } from "node:stream";

/**
 * The live feed of `cam` as a byte Readable. `onBudget(notice)` is called for each battery-budget notice
 * (`notice.extend(ms?)` keeps the stream going). A camera without live() falls back to openReadable(),
 * which never reports the budget.
 */
export async function openLiveFeed(cam, opts, { onBudget } = {}) {
  if (typeof cam.live !== "function") return cam.openReadable(opts);
  const consumer = await cam.live(opts);
  const feed = new Readable({
    read() {
      consumer.resume();
    },
    destroy(err, cb) {
      consumer.stop(); // detaches this consumer from the shared source (refcount--)
      cb(err);
    },
  });
  consumer.on("video", (frame) => {
    // A full buffer pauses the consumer; its bounded queue drops to the next keyframe if the sink stays slow.
    if (!feed.push(frame.data)) consumer.pause();
  });
  consumer.on("stop", () => feed.push(null)); // the pull ended → EOF
  consumer.on("error", (err) => feed.destroy(err));
  if (onBudget) consumer.on("budget", onBudget);
  return feed;
}
