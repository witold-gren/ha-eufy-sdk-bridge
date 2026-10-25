// Per-model fixes for properties the SDK maps to the wrong raw param on some camera.
//
// T8151 — "audio recording": the SDK reads/writes 1288 (`record_mute`, inverted; verified only on a T8425),
// which a T8151 never moves (it stays 1, so the switch always read "off"). The eufy app toggles 6012 instead
// (CMD_INDOOR_SET_RECORD_AUDIO_ENABLE; 1 = on, not inverted) — found with PARAM_WATCH on Iwiny Tył,
// 2026-10-23: 6012 went 1→0→1→0 with the app's off/on/off while 1288 stayed 1. The SDK's dictionary calls
// 6012 "statusInLock" (a lock param of another device family), so the value is there, just under that name.
//
// Read: the overridden property takes the raw param's value from `dev.getProperties()` (every param the SDK
// holds, schema or not, carries its paramType). Write: the raw param is sent the way the SDK sends the
// microphone switch (set-param, direct-binary), then applied locally so the switch does not bounce back
// until the next cloud read.

/** model → { property: { param, invert? } } */
export const PARAM_OVERRIDES = {
  T8151: { audioRecording: { param: 6012 } },
};

const asBool = (v) => v === true || v === 1 || v === "1" || v === "true";

/** The override of `name` on `model`, or undefined. */
export function overrideFor(model, name) {
  return PARAM_OVERRIDES[model]?.[name];
}

/**
 * Apply the read overrides of `model` to a `{ name: value }` map built from `props`
 * (`dev.getProperties()`: name → `{ value, paramType }`). Returns `out` for chaining.
 */
export function applyReadOverrides(model, props, out, report) {
  for (const [name, o] of Object.entries(PARAM_OVERRIDES[model] ?? {})) {
    const hit = Object.values(props ?? {}).find((p) => p?.paramType === o.param);
    report?.(name, o.param, hit);
    if (!hit) continue;
    const on = asBool(hit.value);
    out[name] = o.invert ? !on : on;
  }
  return out;
}

/**
 * Write `name` = `value` on `sn` through its raw param when `model` overrides it. Returns true when it did
 * (the caller then skips the SDK's own setProperty), false when there is no override.
 */
export async function writeOverride(eufy, sn, model, name, value) {
  const o = overrideFor(model, name);
  if (!o) return false;
  const on = asBool(value) !== !!o.invert;
  const ctx = await eufy.commandContext(sn);
  await eufy.commandSinkFor(sn).dispatch({
    kind: "set-param",
    param: o.param,
    value: on ? 1 : 0,
    form: "direct-binary",
    channel: ctx.channel,
  });
  // Show the new value at once; the next cloud read confirms it.
  const dev = await eufy.getDevice(sn).catch(() => undefined);
  dev?.applyParams?.({ [o.param]: on ? "1" : "0" });
  return true;
}
