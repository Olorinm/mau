#!/usr/bin/env node
// Run in a disposable process/container: an old parser may terminate the process.
// All requests stay on loopback; this must never target the production listener.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { gzipSync, deflateSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
const require = createRequire(import.meta.url);
const qs = require("qs");
const { fetch: clientFetch } = require("undici");

const app = express();
app.use(express.json({ limit: "16kb" }));
app.post("/echo", (req, res) => res.json(req.body));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: "invalid_body" }));
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const versions = Object.fromEntries(["body-parser", "qs", "undici"].map(name => [name, require(`${name}/package.json`).version]));
try {
  for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync]]) {
    const valid = await fetch(origin + "/echo", { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": encoding }, body: compress('{"ok":true}') });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { ok: true });
  }
  const invalid = await fetch(origin + "/echo", { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: Buffer.from("not-gzip") });
  assert.equal(invalid.status, 400);
  await invalid.arrayBuffer();

  // GHSA-27r3-jxmh-p828: trailing bytes arrive after a complete deflate frame.
  // The old parser leaves the decoder attached after delivering the response.
  const trailing = await new Promise((resolve, reject) => {
    const req = request(origin + "/echo", { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "deflate" } }, res => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.write(deflateSync('{"ok":true}'));
    setTimeout(() => req.end(Buffer.from("trailing-invalid-compressed-data")), 30);
  });
  assert.equal(trailing, 200);
  await delay(80);
  assert.equal((await fetch(origin + "/health")).status, 200);

  // GHSA-6pq8-jhm2-2vcw: an own, non-callable toString must not crash serialization.
  assert.doesNotThrow(() => qs.stringify(JSON.parse('{"a":[{"toString":"x"}]}'), { arrayFormat: "comma" }));

  // GHSA-xjj6-f33q-929c: refuse excessive encodings without an orphaned stream.
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "Content-Encoding": "gzip, gzip, gzip, gzip, gzip, gzip", "Content-Length": "100" });
    res.flushHeaders();
    setTimeout(() => res.destroy(), 20);
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  try {
    const url = `http://127.0.0.1:${upstream.address().port}`;
    for (const fetcher of [clientFetch, globalThis.fetch]) {
      await assert.rejects(async () => { const response = await fetcher(url); await response.arrayBuffer(); });
      await delay(60);
    }
  } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  console.log(JSON.stringify({ status: "passed", node: process.version, bundledUndici: process.versions.undici, versions, checks: ["valid-compressed-json", "invalid-compressed-json", "trailing-compressed-data", "qs-comma-array", "undici-excess-encodings", "builtin-fetch-excess-encodings"] }));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
