// The shape of a station's recording rows: field names and kinds, never the values.
import { test } from "node:test";
import assert from "node:assert/strict";

import { recordFields, shapeOf } from "../src/record-fields.mjs";

test("the shape keeps names and kinds and drops every value", () => {
  const rows = [
    { table_name: "history_record_info", payload: [{ storage_path: "/mnt/x.mp4", channel: 0, cipher_id: null }] },
  ];
  assert.deepEqual(shapeOf(rows), [
    { payload: [{ channel: "number", cipher_id: "null", storage_path: "string" }], table_name: "string" },
  ]);
  assert.equal(JSON.stringify(shapeOf(rows)).includes("/mnt"), false);
});

test("one page of the last days is read on the station's own session", async () => {
  const asked = [];
  const session = { queryRecordPage: async (opts) => (asked.push(opts), [{ table_name: "t", payload: [] }]) };
  const eufy = {
    p2p: { ensureStation: async () => {}, getSessions: () => new Map([["T8410X", session]]) },
    getDevices: async () => [{ raw: { member: { admin_user_id: "acct" } } }],
  };
  const answer = await recordFields(eufy, { sn: "T8410X" }, { now: new Date(2026, 10, 11) });
  assert.deepEqual(asked, [{ accountId: "acct", startDate: "20261012", endDate: "20261111", count: 3 }]);
  assert.deepEqual(answer, {
    sn: "T8410X",
    groups: 1,
    tables: ["t"],
    paths: [],
    rows: [],
    shape: [{ payload: [], table_name: "string" }],
  });
});

test("the paths come back as patterns, every digit hidden", async () => {
  const row = { storage_path: "/mnt/T8410P2021/20261110/1225.mp4", thumb_path: "" };
  const session = { queryRecordPage: async () => [{ table_name: "history_record_info", payload: [row] }] };
  const eufy = { p2p: { getSessions: () => new Map([["S", session]]) }, getDevices: async () => [] };
  const answer = await recordFields(eufy, { sn: "S" });
  assert.deepEqual(answer.paths, ["/mnt/T####P####/########/####.mp4", ""]);
});
