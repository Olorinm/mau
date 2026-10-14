#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), "mau-cli-consumer-"));
const version = JSON.parse(await readFile(new URL("package.json", root))).version;
let requests = 0, recovered = false;
const failed = { id: "recovery", kind: "feishu", state: "failed", error: "feishu_creation_outcome_unknown",
  recovery: { action: "authorize_existing_app", appId: "cli_fixture", domain: "lark", personalTools: false } };
const server = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, "Bearer test-owner");
  requests++; res.setHeader("Content-Type", "application/json");
  if (req.url === "/_mau/v1/account") res.end(JSON.stringify({ owner: "@alice:example.test" }));
  else if (req.url === "/_mau/v1/agents") res.end(JSON.stringify({ data: [{ agent: { id: "helper", name: "helper" } }] }));
  else if (req.url === "/_agent-router/v1/agents/helper/connections") {
    let raw = ""; for await (const chunk of req) raw += chunk;
    assert.deepEqual(JSON.parse(raw), { kind: "feishu", appId: "cli_fixture", domain: "lark", personalTools: false });
    recovered = true;
    res.end(JSON.stringify({ id: "recovering", kind: "feishu", state: "binding", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  } else if (req.url === "/_agent-router/v1/agents/helper/connection-jobs/recovering") res.end(JSON.stringify({ id: "recovering", state: "ready" }));
  else if (req.url === "/_agent-router/v1/agents/helper/connection-jobs/recovery") res.end(JSON.stringify(failed));
  else if (req.url === "/_agent-router/v1/agents/helper/connection-jobs") res.end(JSON.stringify({ data: [failed] }));
  else { res.writeHead(404); res.end("{}"); }
});
try {
  const [archive] = JSON.parse(execFileSync(process.execPath,
    [fileURLToPath(new URL("scripts/pack-cli.mjs", root)), "--pack-destination", temporary], { encoding: "utf8" }));
  assert.deepEqual(archive.files.map(f => f.path).sort(),
    ["LICENSE", "NOTICE", "README.md", "dist/cli.js", "dist/files.js", "dist/ssh-client.js", "dist/ssh-transport.js", "package.json"].sort());
  // A fresh cache and unreachable registry prove no server/private peer is fetched.
  execFileSync("npm", ["install", "--global", "--prefix", temporary,
    "--cache", join(temporary, "cache"), "--registry", "http://127.0.0.1:9",
    "--ignore-scripts", "--no-audit", "--no-fund", join(temporary, archive.filename)], { stdio: "pipe" });
  const binary = join(temporary, "bin/mau");
  const environment = { ...process.env, MAU_CONFIG_DIR: join(temporary, "config") };
  const cli = async (...args) => (await promisify(execFile)(binary, args, { env: environment })).stdout;
  assert.deepEqual(JSON.parse(await cli("--version")), { product: "mau", version });
  assert.match(await cli("--help"), /mau setup/);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { writeFile } = await import("node:fs/promises");
  const token = join(temporary, "token"); await writeFile(token, "test-owner", { mode: 0o600 });
  const base = "http://127.0.0.1:" + server.address().port;
  await cli("login", "--allow-http", "--url", base, "--token-file", token);
  const session = JSON.parse(await readFile(join(temporary, "config/session.json"), "utf8"));
  assert.equal(session.owner, "@alice:example.test"); assert.equal(requests, 1);
  await cli("use", "helper", "--allow-http");
  assert.equal(JSON.parse(await cli("channel-connect", "feishu", "--app-id", "cli_fixture", "--domain", "lark", "--messaging-only", "--allow-http")).state, "ready");
  assert.equal(recovered, true);
  assert.deepEqual(JSON.parse(await cli("channel-jobs", "--allow-http")).data, [failed]);
  await assert.rejects(cli("channel-job", "recovery", "--allow-http"), error => {
    assert.deepEqual(JSON.parse(error.stdout), failed);
    assert.match(error.stderr, /mau channel-connect feishu --app-id cli_fixture --domain lark --messaging-only/);
    assert.match(error.stderr, /feishu_creation_outcome_unknown/); return true;
  });
  await assert.rejects(cli("channel-connect", "matrix", "--app-id", "cli_fixture"), /app_id_requires_feishu_channel_connect/);
  await assert.rejects(cli("channel-connect", "feishu", "--app-id", "bad id"), /invalid_feishu_app_id/);
  console.log("PASS: independent CLI install, login/selection, existing app recovery, binding polling and durable job recovery instructions.");
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
