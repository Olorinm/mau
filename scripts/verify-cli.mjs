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
let requests = 0;
const server = createServer((req, res) => {
  assert.equal(req.url, "/_mau/v1/account");
  assert.equal(req.headers.authorization, "Bearer test-owner");
  requests++; res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ owner: "@alice:example.test" }));
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
  console.log("PASS: fresh global CLI install without registry dependencies, executable command, version/help and login persistence.");
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
