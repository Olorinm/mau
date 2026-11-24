import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { ACCESS_ROW_CAP, accessBatchDue, accessBatchKey, accessRecord, accessRecorded, backupDueFor, recordAccess } from "../src/policy.mjs";

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

test("the liveness probe is not recorded; everything else is, with a bounded path", () => {
  assert.equal(accessRecorded(new Request("https://mau.example.test/health/live")), false);
  assert.equal(accessRecorded(new Request("https://mau.example.test/health/live?probe=1", { method: "HEAD" })), false);
  for (const path of ["/", "/health", "/health/live/", "/health/live/x", "/_mau/v1/info", "/_mau/v1/agents", "/oauth/callback"])
    assert.equal(accessRecorded(new Request("https://mau.example.test" + path)), true, path);
  assert.equal(accessRecord(new Request("https://mau.example.test/" + "a".repeat(5000)), 404, 0, 0).path.length, 1024);
});

const table = () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE access (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, record TEXT NOT NULL)");
  const exec = (query, ...bindings) => db.prepare(query).run(...bindings);
  const ids = () => db.prepare("SELECT id FROM access ORDER BY id").all().map((row) => row.id);
  return { db, exec, ids };
};

test("access records beyond the cap drop the oldest, whatever the rate and whatever was already written out", () => {
  const { db, exec, ids } = table();
  for (let i = 1; i <= 12; i++) recordAccess(exec, i, { n: i }, 5);
  assert.deepEqual(ids(), [8, 9, 10, 11, 12]);
  assert.deepEqual(JSON.parse(db.prepare("SELECT record FROM access WHERE id = 12").get().record), { n: 12 });
  // After a batch was written to the bucket and deleted, the cap still counts from the newest record.
  db.exec("DELETE FROM access WHERE id <= 10");
  for (let i = 13; i <= 15; i++) recordAccess(exec, i, { n: i }, 5);
  assert.deepEqual(ids(), [11, 12, 13, 14, 15]);
  recordAccess(exec, 16, { n: 16 }, 5);
  assert.deepEqual(ids(), [12, 13, 14, 15, 16]);
  assert.equal(ACCESS_ROW_CAP, 50_000);
  const full = table();
  for (let i = 0; i < 3; i++) recordAccess(full.exec, i, {});
  assert.equal(full.ids().length, 3);
});

// The real object with the Cloudflare runtime replaced: SQLite in memory and a container that answers every request.
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const runtime = moduleUrl("export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint extends DurableObject {}");
const ownerModule = moduleUrl(stripTypeScriptTypes(await readFile(new URL("../src/replica-owner.ts", import.meta.url), "utf8")));
const { Mau } = await import(moduleUrl(stripTypeScriptTypes(await readFile(new URL("../src/index.ts", import.meta.url), "utf8"), { mode: "transform" })
  .replace('from "./replica-owner.js"', `from "${ownerModule}"`).replace('from "cloudflare:workers"', `from "${runtime}"`).replace('from "./policy.mjs"', `from "${new URL("../src/policy.mjs", import.meta.url)}"`)));
function object() {
  const { db, exec, ids } = table(), sql = { broken: false, exec: (query, ...bindings) => { if (sql.broken) throw new Error("SQLITE_FULL"); return exec(query, ...bindings); } };
  const container = { running: true, async setInactivityTimeout() {}, getTcpPort: () => ({ fetch: async () => new Response("ok") }) };
  const mau = new Mau({ container, storage: { sql, async setAlarm() {} }, blockConcurrencyWhile: (work) => work(), waitUntil() {} }, {});
  return { mau, sql, db, ids };
}

test("a request is answered when its access record cannot be written, and liveness probes leave none", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const f = object();
  for (let i = 0; i < 100; i++) assert.equal((await f.mau.fetch(new Request("https://mau.example.test/health/live"))).status, 200);
  assert.deepEqual(f.ids(), []);
  assert.equal((await f.mau.fetch(new Request("https://mau.example.test/_mau/v1/agents?x=1", { headers: { "CF-Connecting-IP": "203.0.113.7" } }))).status, 200);
  const [row] = f.db.prepare("SELECT record FROM access").all();
  assert.deepEqual({ ...JSON.parse(row.record), time: "", ms: 0 }, { time: "", method: "GET", path: "/_mau/v1/agents", status: 200, ms: 0, ip: "203.0.113.7" });
  f.sql.broken = true;
  for (let i = 0; i < 3; i++) {
    const response = await f.mau.fetch(new Request("https://mau.example.test/_mau/v1/agents"));
    assert.equal(response.status, 200); assert.equal(await response.text(), "ok");
  }
  // One line a minute says the records are failing; it is not one per request.
  assert.equal(errors.mock.calls.length, 1);
  assert.match(errors.mock.calls[0].arguments[0], /"event":"mau_access_record_failed"/);
  f.sql.broken = false;
  await f.mau.fetch(new Request("https://mau.example.test/"));
  assert.equal(f.ids().length, 2);
});

test("a replacement drains the previous writer and isolates an unacknowledged handoff", async () => {
  const { prepareReplica, parseHead, temporaryKey } = await import(ownerModule);
  const first = crypto.randomUUID(), next = crypto.randomUUID();
  const owner = {};
  const initial = prepareReplica(owner, undefined, first, 0);
  assert.equal(initial.source, "");
  const head = parseHead(JSON.stringify({ id: first, prefix: initial.target }));
  Object.assign(owner, { active: head, pending: undefined });
  assert.equal(prepareReplica(owner, head, next, 1000), undefined);
  assert.equal(prepareReplica(owner, head, next, 90000), undefined);
  const isolated = prepareReplica(owner, head, next, 91000);
  assert.equal(isolated.source, head.prefix);
  assert.notEqual(isolated.target, head.prefix);
  owner.released = true;
  assert.equal(prepareReplica(owner, head, next, 92000).target, head.prefix);
  const env = { R2_ENDPOINT: "https://account.r2.cloudflarestorage.com", R2_ACCESS_KEY_ID: "parent", R2_SECRET_ACCESS_KEY: "secret" };
  for (const writable of [false, true]) {
    const key = await temporaryKey(env, "state", isolated.target, writable, 1000);
    const jwt = atob(key.SessionToken).slice(4);
    const [header, body, signature] = jwt.split(".");
    const hmac = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    assert.ok(await crypto.subtle.verify("HMAC", hmac, Buffer.from(signature,"base64url"), Buffer.from(header+"."+body)));
    const claims = JSON.parse(Buffer.from(body, "base64url"));
    assert.equal(claims.scope, writable ? "object-read-write" : "object-read-only");
    assert.deepEqual(claims.paths.prefixPaths, [isolated.target]);
    assert.equal(claims.exp - claims.iat, 900);
    assert.equal(key.SecretAccessKey, Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(jwt))).toString("hex"));
  }
});

test("only the published writer can renew write credentials or release the active replica", async () => {
  const { prepareReplica } = await import(ownerModule);
  const store = new Map();
  const storage = { sql: { exec() {} }, async setAlarm() {}, async get(k) {return structuredClone(store.get(k));},
    async put(k,v) {store.set(k,structuredClone(v));} };
  const heads = [];
  const env = { STATE_REPLICA: { async put(key,value) {heads.push(JSON.parse(value));} }, CONFIG_BUCKET:"config", STATE_BUCKET:"state",
    R2_ENDPOINT:"https://account.r2.cloudflarestorage.com", R2_ACCESS_KEY_ID:"parent", R2_SECRET_ACCESS_KEY:"secret" };
  const mau = new Mau({storage,blockConcurrencyWhile:task=>task()},env);
  const old = crypto.randomUUID(), next = crypto.randomUUID(), owner={};
  prepareReplica(owner,undefined,old,0);
  await storage.put("replicaOwner",owner);
  const rpc=(id,method,path)=>mau.replicaControl(id,method,path);
  assert.equal((await rpc(old,"GET","/credentials/restore")).status,200);
  assert.equal((await rpc(old,"POST","/publish")).status,200);
  const replaced=await storage.get("replicaOwner");
  assert.equal(prepareReplica(replaced,heads[0],next,10),undefined);
  await storage.put("replicaOwner",replaced);
  assert.equal((await rpc(old,"GET","/status")).status,409);
  const boot=prepareReplica(replaced,heads[0],next,90010);
  await storage.put("replicaOwner",replaced);
  const source=await (await rpc(next,"GET","/credentials/restore")).json();
  const scope=JSON.parse(Buffer.from(atob(source.SessionToken).slice(4).split(".")[1],"base64url"));
  assert.equal(scope.scope,"object-read-only");
  assert.deepEqual(scope.paths.prefixPaths,[heads[0].prefix]);
  assert.equal((await rpc(next,"POST","/publish")).status,200);
  assert.equal(heads[1].prefix,boot.target);
  assert.equal((await rpc(old,"GET","/credentials/state")).status,409);
  assert.equal((await rpc(old,"POST","/released")).status,409);
  assert.equal((await rpc(next,"GET","/status")).status,200);
  assert.equal((await rpc(next,"POST","/released")).status,200);
  assert.equal((await rpc(next,"GET","/credentials/state")).status,409);
});
