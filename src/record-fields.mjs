// What a station's recording rows hold: one page of `history_record_info` read over the station's own P2P session,
// answered as its shape only (table names, field names and the kind of each value), never the values, which carry
// paths, serials and account ids. Read only. LOCAL TEST ONLY — to learn where a camera that is its own station keeps
// its recordings, where no table of models says so.

const day = (date) =>
  `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;

/** The shape of a value: objects and arrays by their keys and first item, anything else by its type. */
export function shapeOf(value, depth = 0) {
  if (Array.isArray(value)) return value.length && depth < 4 ? [shapeOf(value[0], depth + 1)] : [];
  if (value && typeof value === "object") {
    if (depth >= 4) return "object";
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, shapeOf(value[key], depth + 1)]),
    );
  }
  return value === null ? "null" : typeof value;
}

export async function recordFields(eufy, msg, { now = new Date() } = {}) {
  if (typeof msg?.sn !== "string" || !msg.sn) throw new Error("station.recordFields needs sn");
  await eufy.p2p?.ensureStation?.(msg.sn);
  const session = eufy.p2p?.getSessions?.().get(msg.sn) ?? eufy.getP2pSessions?.().get(msg.sn);
  if (typeof session?.queryRecordPage !== "function") throw new Error(`no station session for ${msg.sn}`);
  const devices = await eufy.getDevices();
  const accountId =
    devices.find((device) => device.raw?.member?.admin_user_id)?.raw?.member?.admin_user_id ?? eufy.api?.auth?.userId;
  const since = new Date(now.getTime() - (msg.days ?? 30) * 86_400_000);
  const groups = await session.queryRecordPage({
    accountId,
    startDate: day(since),
    endDate: day(now),
    count: msg.count ?? 3,
  });
  // Where the files lie, as a pattern: every digit a #, so no serial, date or id is answered.
  const rows = groups.flatMap((group) => (Array.isArray(group?.payload) ? group.payload : []));
  const pattern = (value) => {
    if (typeof value !== "string" || !value) return value;
    const extension = value.match(/\.[a-z][a-z0-9]*$/i)?.[0] ?? "";
    return value.slice(0, value.length - extension.length).replace(/[0-9]/g, "#") + extension;
  };
  return {
    sn: msg.sn,
    groups: groups.length,
    tables: groups.map((group) => group?.table_name ?? null),
    paths: [...new Set(rows.flatMap((row) => [pattern(row.storage_path), pattern(row.thumb_path)]))],
    // Per row, what tells where its file lies: the camera's model (not its serial), the path as a pattern, the key.
    rows: rows.slice(0, 12).map((row) => ({
      model: String(row.device_sn ?? "").slice(0, 5),
      path: pattern(row.storage_path),
      cipher: row.cipher_id,
      storageType: row.storage_type,
      cloud: row.storage_cloud,
      label: pattern(row.storage_label),
    })),
    shape: shapeOf(groups),
  };
}

/**
 * Which ways of asking the cloud for a recording's key answer one: the station's admin and the signed-in user, with
 * and without the station's serial. Answers only whether each key came, never a key. LOCAL TEST ONLY.
 */
export async function cipherProbe(eufy, msg) {
  if (typeof msg?.sn !== "string" || !Array.isArray(msg?.ids)) throw new Error("station.ciphers needs sn and ids");
  const mega = eufy.mega ?? eufy.api;
  if (typeof mega?.getCiphers !== "function") throw new Error("no cipher endpoint on this SDK");
  const devices = await eufy.getDevices();
  const own = devices.find((d) => (d.sn ?? d.serialNumber) === msg.sn);
  const users = {
    stationAdmin: own?.raw?.member?.admin_user_id,
    anyAdmin: devices.find((d) => d.raw?.member?.admin_user_id)?.raw?.member?.admin_user_id,
    signedIn: eufy.api?.auth?.userId ?? mega.auth?.userId,
  };
  const answers = [];
  for (const [who, user] of Object.entries(users)) {
    for (const station of [msg.sn, ""]) {
      try {
        const ciphers = await mega.getCiphers(msg.ids, user ?? "", station);
        answers.push({
          who,
          known: !!user,
          withStation: !!station,
          ciphers: ciphers.map((c) => ({ id: c.cipher_id, ecc: !!c.ecc_private_key, rsa: !!c.private_key })),
        });
      } catch (e) {
        answers.push({ who, known: !!user, withStation: !!station, error: String(e?.message ?? e).slice(0, 120) });
      }
    }
  }
  return { sn: msg.sn, answers };
}

/**
 * Send one form of the download request for `path` and count what comes back for 20 s: frames by command, data
 * type, channel and seal. Answers counts only. LOCAL TEST ONLY — to learn which form a camera that is its own
 * station answers.
 */
export async function downloadProbe(eufy, msg, { waitMs = 20_000 } = {}) {
  const { generateKeyPairSync } = await import("node:crypto");
  if (typeof msg?.sn !== "string" || typeof msg?.path !== "string") throw new Error("sd.probe needs sn and path");
  await eufy.p2p?.ensureStation?.(msg.sn);
  const session = eufy.p2p?.getSessions?.().get(msg.sn);
  if (!session) throw new Error(`no station session for ${msg.sn}`);
  const devices = await eufy.getDevices();
  const accountId =
    devices.find((d) => d.raw?.member?.admin_user_id)?.raw?.member?.admin_user_id ?? eufy.api?.auth?.userId;
  const channel = Number(msg.channel ?? 0);
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 65537 });
  const key = Buffer.from(publicKey.export({ format: "jwk" }).n, "base64url")
    .toString("hex")
    .toUpperCase();
  const json = JSON.stringify({
    account_id: accountId,
    cmd: 1024,
    mChannel: channel,
    mValue3: 1024,
    payload: { filepath: msg.path, key },
  });
  const counts = {};
  const replies = [];
  const onData = (frame) => {
    const k = `cmd${frame.commandId}/type${frame.dataType}/ch${frame.channel}/sign${frame.signCode}`;
    counts[k] = (counts[k] ?? 0) + 1;
    // The answer to the request itself: its first bytes hold the station's return code.
    if (frame.commandId === 1024 && replies.length < 3) {
      const raw = Buffer.from(frame.raw ?? []);
      replies.push({
        length: raw.length,
        head: raw.subarray(0, 24).toString("hex"),
        int0: raw.length >= 4 ? raw.readInt32LE(0) : null,
      });
    }
  };
  session.on("data", onData);
  let sent;
  try {
    if (msg.variant === "string-payload") sent = session.sendStringPayloadCommand(1024, json, channel);
    else if (msg.variant === "level2-1024") sent = session.sendRawLevel2(json, channel, 1024);
    else if (msg.variant === "level2-1350") sent = session.sendRawLevel2(json, channel, 1350);
    else if (msg.variant === "string-pair") sent = session.sendStringPairCommand(1024, msg.path, accountId, channel);
    else throw new Error("variant: string-payload | level2-1024 | level2-1350 | string-pair");
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  } finally {
    session.off("data", onData);
  }
  return { variant: msg.variant, sent: sent ?? null, level2: !!session.level2Key, counts, replies };
}
