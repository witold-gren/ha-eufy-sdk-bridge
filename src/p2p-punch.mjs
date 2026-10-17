// Wider P2P hole punching for cameras behind a mobile carrier's NAT (P2P_PUNCH_SPREAD).
//
// The SDK answers each cloud LOOKUP_ADDR by sending CHECK_CAM to the camera's reported public port ±3. That fits a
// home router, which keeps one public port per socket. A 4G camera sits behind carrier-grade NAT that gives every
// destination its own port, handed out in sequence: one camera registered with two lookup servers from :37009 and
// :37018, then punched towards the bridge from :37015 — and towards another server pair from :8601/:8603, where
// nothing within ±3 ever answered and the open timed out for 30 s. The bridge's own router only lets the camera's
// packets in from a port it has sent to, so the punch must cover the gap between those ports.
//
// This sweeps ±spread around every public address the cloud reports, in ±3 blocks through the SDK's own
// beginCheckCam (so the payload stays the SDK's), at most once a second per address and socket. Private
// addresses are left to the SDK. A workaround until the SDK punches wider itself.
import { P2PSession } from "@mega-yfue/eufy-sdk";

const INSTALLED = Symbol.for("eufy-bridge.p2p-punch");
const BLOCK = 7; // the SDK covers port-3 … port+3 per call
const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;

/** Ports to pass to the SDK's ±3 punch so that, together, they cover `port ± spread` (the centre excluded). */
export function punchCentres(port, spread) {
  const centres = [];
  for (let offset = BLOCK; offset - 3 <= spread; offset += BLOCK) {
    for (const p of [port - offset, port + offset]) if (p - 3 > 0 && p + 3 < 65536) centres.push(p);
  }
  return centres;
}

/** Widen `proto.beginCheckCam` (P2PSession's by default) to ±spread. spread ≤ 3 or a second install is a no-op. */
export function installWidePunch(spread, proto = P2PSession.prototype, now = Date.now) {
  if (!(spread > 3) || !proto?.beginCheckCam || proto[INSTALLED]) return false;
  proto[INSTALLED] = true;
  const original = proto.beginCheckCam;
  const swept = new WeakMap(); // session → Map(key → last sweep time)
  proto.beginCheckCam = function (addr, socket) {
    original.call(this, addr, socket);
    if (!addr?.host || PRIVATE.test(addr.host)) return;
    let seen = swept.get(this);
    if (!seen) swept.set(this, (seen = new Map()));
    const key = `${addr.host}:${addr.port}:${socket?.address?.().port ?? ""}`;
    const t = now();
    if (t - (seen.get(key) ?? -Infinity) < 1000) return;
    seen.set(key, t);
    for (const port of punchCentres(addr.port, spread)) original.call(this, { host: addr.host, port }, socket);
  };
  return true;
}
