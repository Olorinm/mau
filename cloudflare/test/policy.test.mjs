import assert from "node:assert/strict";
import test from "node:test";
import { accessBatchDue, accessBatchKey, accessRecord, backupDueFor } from "../src/policy.mjs";

test("an access record has the path without its query and nothing of the headers but the client address", () => {
  const request = new Request("https://mau.example.test/_mau/v1/agents?token=secret", {
    method: "POST", headers: { "CF-Connecting-IP": "203.0.113.7", Authorization: "Bearer secret", Cookie: "a=b" } });
  assert.deepEqual(accessRecord(request, 201, Date.parse("2026-01-10T03:04:05.000Z"), Date.parse("2026-01-10T03:04:05.042Z")),
    { time: "2026-01-10T03:04:05.000Z", method: "POST", path: "/_mau/v1/agents", status: 201, ms: 42, ip: "203.0.113.7" });
  assert.equal(accessRecord(new Request("https://mau.example.test/"), 200, 0, 0).ip, "");
});

test("access records are written when a thousand wait or the oldest has waited ten minutes", () => {
  const now = Date.parse("2026-01-10T00:00:00Z");
  assert.equal(accessBatchDue(0, 0, now), false);
  assert.equal(accessBatchDue(1, now - 9 * 60_000, now), false);
  assert.equal(accessBatchDue(1, now - 10 * 60_000, now), true);
  assert.equal(accessBatchDue(1000, now, now), true);
  assert.equal(accessBatchKey(42, Date.parse("2026-01-10T03:04:05Z")), "2026-01-10/030405-000000000042.jsonl");
});

test("a backup is due once per UTC day from the configured hour, and never without one", () => {
  const at = (time) => Date.parse(`2026-01-10T${time}Z`);
  assert.equal(backupDueFor("19", "2026-01-09", at("18:59:59")), null);
  assert.equal(backupDueFor("19", "2026-01-09", at("19:00:00")), "2026-01-10");
  assert.equal(backupDueFor("19", "2026-01-10", at("23:00:00")), null);
  assert.equal(backupDueFor("0", undefined, at("00:00:00")), "2026-01-10");
  for (const hour of [undefined, "", "24", "-1", "1.5", "soon"]) assert.equal(backupDueFor(hour, undefined, at("23:00:00")), null);
});
