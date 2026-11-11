// A bounded try-out of a siren wire on a camera that is its own station (no HomeBase), whose `siren` the SDK does
// not grant yet: no verified command for that family. LOCAL TEST ONLY — not for upstream.
//
// The "self-station" form is the one wire-confirmed on a self-station Wall Light Cam (T84A1) in
// mega-yfue/eufy-sdk#569: CMD_SET_TONE_FILE 1201, level-1 int-plus-string, channel 0, value = seconds, valueSub 23
// to sound and value 0 / valueSub 4 to stop. The "camera" form is the attached-camera wire (1202) on channel 0, the
// fallback to compare. The "integrated" form is eufy-security-client 3.1.1's station alarm for the integrated
// indoor cameras (T8400, T8401, T8410, T8411, T8414, T8420, T820x), whose siren is the station's own, not the
// camera's: 1201 on the station channel 255, value 2, valueSub = seconds to sound and valueSub 0 to stop. Read from
// that library, not seen on the wire here yet. Whatever the camera does with the duration, the stop always follows after `seconds`, so a
// try-out never sounds longer than asked: at most SIREN_PROBE_MAX_S.

export const SIREN_PROBE_MAX_S = 5;
export const SIREN_PROBE_CONFIRM = "SIREN";

const STATION_CHANNEL = 255;

const intString = (cmd, value, valueSub, channel = 0) => ({ kind: "p2p-int-string", cmd, value, valueSub, channel });

export const SIREN_PROBE_FORMS = {
  "self-station": { sound: (s) => intString(1201, s, 23), stop: () => intString(1201, 0, 4) },
  camera: { sound: (s) => intString(1202, s, 0), stop: () => intString(1202, 0, 0) },
  integrated: {
    sound: (s) => intString(1201, 2, s, STATION_CHANNEL),
    stop: () => intString(1201, 2, 0, STATION_CHANNEL),
  },
};

/**
 * Sound the siren of `sn` for `seconds` (1-5) with one `form`, then stop it. Resolves once the sound command went
 * out; the stop follows by itself. `{ confirm: "SIREN" }` must be passed: a siren is loud and outdoors.
 */
export async function sirenProbe(eufy, msg, { log = () => {}, setTimer = setTimeout } = {}) {
  if (msg?.confirm !== SIREN_PROBE_CONFIRM) throw new Error(`siren.probe needs confirm: "${SIREN_PROBE_CONFIRM}"`);
  const form = SIREN_PROBE_FORMS[msg.form ?? "self-station"];
  if (!form) throw new Error(`siren.probe form must be one of ${Object.keys(SIREN_PROBE_FORMS).join(", ")}`);
  const seconds = Number(msg.seconds);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > SIREN_PROBE_MAX_S) {
    throw new Error(`siren.probe seconds must be a whole number from 1 to ${SIREN_PROBE_MAX_S}`);
  }
  if (typeof msg.sn !== "string" || !msg.sn) throw new Error("siren.probe needs sn");
  const sink = eufy.commandSinkFor?.(msg.sn);
  if (!sink?.dispatch) throw new Error("siren.probe: this SDK has no command sink to reach the camera");
  const name = msg.form ?? "self-station";
  log(`siren.probe ${msg.sn} → sound (${name}, ${seconds} s)`);
  await sink.dispatch(form.sound(seconds));
  setTimer(() => {
    sink.dispatch(form.stop()).then(
      () => log(`siren.probe ${msg.sn} → stop sent (${name})`),
      (e) => log(`siren.probe ${msg.sn} → stop FAILED (${name}): ${e?.message ?? e}`),
    );
  }, seconds * 1000);
  return { sn: msg.sn, form: name, seconds, stopsAfterMs: seconds * 1000 };
}

// ── The siren of a camera that is its own station, where it is confirmed ───────────────────────────────────────
//
// The SDK grants `siren` to a camera only behind a HomeBase. The self-station wire above was confirmed here on a
// T8151 (Działka Poddasze, 2026-11-11 00:48): 1201 / valueSub 23 sounded it, 1201 / value 0 / valueSub 4 stopped
// it after 5 s. Until the SDK carries it (mega-yfue/eufy-sdk#569), the bridge adds `siren` for these models and
// answers the integration's `trigger(seconds)` / `stop` with that wire. A model joins only once confirmed.

// The model -> the form its siren answers to.
// T8151: Działka Poddasze sounded and stopped (2026-11-11 00:48). T86P2: Iwiny Słup sounded and stopped twice
// (00:54, 00:55; it took a second or two to start, so it sounded about 3 s of the 5). T8400, an integrated indoor
// camera: the "integrated" form sounded Pokój Adama for 3 s and stopped it (2026-11-11 11:49). T8410: the same form
// sounded Korytarz for 3 s and stopped it (13:21). T8410C is the newer T8410 (its serial starts T8410 too, which is
// what eufy-security-client tells the integrated cameras by); not sounded on its own.
export const SELF_STATION_SIREN_MODELS = new Map([
  ["T8151", "self-station"],
  ["T86P2", "self-station"],
  ["T8400", "integrated"],
  ["T8410", "integrated"],
  ["T8410C", "integrated"],
]);
// The longest alarm the app offers (15 min); the integration asks 30 s by default.
const SIREN_MAX_S = 900;

/** Whether `record` is a camera that is its own station, of a model whose siren wire is confirmed. */
export function hasSelfStationSiren(record, stationSn) {
  return Boolean(record && SELF_STATION_SIREN_MODELS.has(record.model) && (stationSn ?? record.sn) === record.sn);
}

/** The capabilities of a device, with `siren` added where the self-station wire stands in for the SDK's. */
export function withSelfStationSiren(record, stationSn) {
  const capabilities = record.capabilities ?? [];
  return hasSelfStationSiren(record, stationSn) && !capabilities.includes("siren")
    ? [...capabilities, "siren"]
    : capabilities;
}

/**
 * Answer `trigger(seconds)` or `stop` on a self-station siren, with the form of its `model`. Resolves with null, as
 * the SDK's actions do.
 */
export async function selfStationSirenAction(eufy, sn, action, args = [], model = undefined) {
  const sink = eufy.commandSinkFor?.(sn);
  if (!sink?.dispatch) throw new Error("this SDK has no command sink to reach the camera");
  const form = SIREN_PROBE_FORMS[SELF_STATION_SIREN_MODELS.get(model) ?? "self-station"];
  if (action === "stop") {
    await sink.dispatch(form.stop());
    return null;
  }
  const seconds = Number(args[0]);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > SIREN_MAX_S) {
    throw new Error(`trigger duration must be a whole number of seconds from 1 to ${SIREN_MAX_S}`);
  }
  await sink.dispatch(form.sound(seconds));
  return null;
}

/**
 * The facts the SDK decides a device's commands by: device type, model, codec, channel and whether it hangs off a
 * HomeBase. Read only. LOCAL TEST ONLY — to report what a self-station camera is, where no list shows it.
 */
export async function deviceContext(eufy, sn) {
  if (typeof eufy.commandContext !== "function") throw new Error("this SDK has no command context to read");
  const ctx = await eufy.commandContext(sn);
  return {
    sn,
    deviceType: ctx.deviceType ?? null,
    model: ctx.model ?? null,
    codec: ctx.codec ?? null,
    channel: ctx.channel ?? null,
    homeBaseAttached: ctx.homeBaseAttached ?? null,
    stationDeviceType: ctx.stationDeviceType ?? null,
  };
}
