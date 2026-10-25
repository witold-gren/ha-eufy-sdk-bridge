// Diagnostics: watch a device's RAW cloud params and log every change — to find which param the eufy
// app writes for a setting the SDK maps wrongly on some model (e.g. "audio recording" on a T8151, where
// the SDK's 1288 record_mute never moves). Off unless PARAM_WATCH names devices.
//
//   PARAM_WATCH=T8151P...,T8151Q...   serials to watch ("all" = every camera)
//   PARAM_WATCH_MS=20000              how often to re-read (default 20 s; each read is one cloud call)
//
// The first read logs the full list (`param <type> (<name>) = <value>`); later reads log only changes
// (`param <type> (<name>): <old> → <new>`). Toggle the setting in the app and read the add-on log.

/** Map `[{ paramType, value, name }]` → `{ [paramType]: { value, name } }`. */
export function paramMap(list) {
  const out = {};
  for (const p of list ?? []) out[p.paramType] = { value: String(p.value), name: p.name };
  return out;
}

/** Lines describing what changed between two param maps (added, removed, changed), sorted by type. */
export function paramChanges(before, after) {
  const types = [...new Set([...Object.keys(before), ...Object.keys(after)])].map(Number).sort((a, b) => a - b);
  const lines = [];
  for (const t of types) {
    const a = before[t];
    const b = after[t];
    const name = (b ?? a).name;
    if (!a) lines.push(`param ${t} (${name}) new = ${b.value}`);
    else if (!b) lines.push(`param ${t} (${name}) gone (was ${a.value})`);
    else if (a.value !== b.value) lines.push(`param ${t} (${name}): ${a.value} → ${b.value}`);
  }
  return lines;
}

/** Long values (JSON blobs) shortened for the log, so one param does not flood it. */
const short = (v) => (v.length > 160 ? `${v.slice(0, 157)}…` : v);

/**
 * Start watching. `inspect(sn)` → `{ params: [{ paramType, value, name }] }` (EufyMega.inspectDevice),
 * `cameras()` → serials for "all". Returns `stop()`.
 */
export function startParamWatch({ spec, intervalMs = 20_000, inspect, cameras = () => [], log = console.log }) {
  if (!spec) return () => {};
  const wanted = () =>
    spec.trim().toLowerCase() === "all"
      ? cameras()
      : spec
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  const last = new Map();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const sn of wanted()) {
        let now;
        try {
          now = paramMap((await inspect(sn))?.params);
        } catch (e) {
          log(`[param-watch] ${sn}: read failed — ${e?.message ?? e}`);
          continue;
        }
        const before = last.get(sn);
        last.set(sn, now);
        if (!before) {
          const all = Object.entries(now).map(([t, p]) => `param ${t} (${p.name}) = ${short(p.value)}`);
          log(`[param-watch] ${sn}: ${all.length} params\n  ${all.join("\n  ")}`);
          continue;
        }
        for (const line of paramChanges(before, now)) log(`[param-watch] ${sn}: ${short(line)}`);
      }
    } finally {
      busy = false;
    }
  };
  log(`[param-watch] watching ${spec} every ${Math.round(intervalMs / 1000)}s`);
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
