#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), "mau-cli-consumer-"));
const version = JSON.parse(await readFile(new URL("package.json", root))).version;
let recovered = false;
const requests = [];
const failed = { id: "recovery", kind: "feishu", state: "failed", error: "feishu_creation_outcome_unknown",
  recovery: { action: "authorize_existing_app", appId: "cli_fixture", domain: "lark" } };
// A stand-in for Mau behind Cloudflare Access (agent-router ADR 0005 18.3): Access credentials only, never a bearer.
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  assert.equal(req.headers.authorization, undefined);
  // Signing in first asks how the service signs owners in, and sends no credential with that question.
  if (req.url === "/_mau/v1/info") {
    for (const header of ["cf-access-client-id", "cf-access-client-secret", "cf-access-token"]) assert.equal(req.headers[header], undefined);
    res.end(JSON.stringify({ login: "edge", logoutUrl: "/cdn-cgi/access/logout" })); return;
  }
  assert.equal(req.headers.origin, "http://" + req.headers.host);
  const service = req.headers["cf-access-client-id"] === "edge.access" && req.headers["cf-access-client-secret"] === "edge-secret";
  const token = req.headers["cf-access-token"] === "edge-token";
  requests.push(`${req.method} ${req.url}`);
  const agent = "/_agent-router/v1/agents/helper";
  if (!service && !token) { res.writeHead(401); res.end(JSON.stringify({ error: "edge_identity_invalid" })); }
  else if (req.url === "/_mau/v1/account") res.end(JSON.stringify({ owner: "@alice:example.test", via: service ? "edge-service" : "edge" }));
  else if (req.url === "/_mau/v1/agents") res.end(JSON.stringify({ data: [{ agent: { id: "helper", name: "helper" } }] }));
  else if (req.url === agent + "/connections") {
    let raw = ""; for await (const chunk of req) raw += chunk;
    assert.deepEqual(JSON.parse(raw), { kind: "feishu", appId: "cli_fixture", domain: "lark" });
    recovered = true;
    res.end(JSON.stringify({ id: "recovering", kind: "feishu", state: "binding", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  } else if (req.url === agent + "/connection-jobs/recovering") res.end(JSON.stringify({ id: "recovering", state: "ready" }));
  else if (req.url === agent + "/connection-jobs/recovery") res.end(JSON.stringify(failed));
  else if (req.url === agent + "/connection-jobs") res.end(JSON.stringify({ data: [failed] }));
  else { res.writeHead(404); res.end(JSON.stringify({ error: "not_found" })); }
});
/** The failure a command reports: the JSON object on its last stderr line, with exit code 1 and nothing on stdout. */
const failure = async (run) => {
  const error = await run.then(() => assert.fail("the command succeeded"), error => error);
  assert.equal(error.code, 1); assert.equal(error.stdout, "");
  return JSON.parse(error.stderr.trimEnd().split("\n").at(-1));
};
try {
  const [archive] = JSON.parse(execFileSync(process.execPath,
    [fileURLToPath(new URL("scripts/pack-cli.mjs", root)), "--pack-destination", temporary], { encoding: "utf8" }));
  const modules = (await Promise.all(["cli", "deploy"].map(async directory =>
    (await readdir(new URL(`src/${directory}/`, root))).map(file => `dist/${directory}/` + file.replace(/\.ts$/, ".js"))))).flat();
  assert.ok(modules.includes("dist/cli/client.js") && modules.includes("dist/cli/local.js") && modules.includes("dist/deploy/doctor.js"));
  assert.deepEqual(archive.files.map(f => f.path).sort(),
    ["LICENSE", "NOTICE", "README.md", "dist/cli.js", "dist/files.js", "dist/ssh-client.js", "dist/ssh-transport.js", "package.json", ...modules].sort());
  // A fresh cache and unreachable registry prove no server/private peer is fetched.
  execFileSync("npm", ["install", "--global", "--prefix", temporary,
    "--cache", join(temporary, "cache"), "--registry", "http://127.0.0.1:9",
    "--ignore-scripts", "--no-audit", "--no-fund", join(temporary, archive.filename)], { stdio: "pipe" });
  const binary = join(temporary, "bin/mau");
  // PATH holds only node, so `cloudflared access token` is unavailable and credentials must come from files or env.
  await mkdir(join(temporary, "no-cloudflared")); await symlink(process.execPath, join(temporary, "no-cloudflared", "node"));
  const environment = { ...process.env, MAU_CONFIG_DIR: join(temporary, "config"), PATH: join(temporary, "no-cloudflared") };
  for (const name of ["CF_ACCESS_TOKEN", "CF_ACCESS_TOKEN_FILE", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_ID_FILE", "CF_ACCESS_CLIENT_SECRET", "CF_ACCESS_CLIENT_SECRET_FILE"]) delete environment[name];
  const run = (env, ...args) => promisify(execFile)(binary, args, { env: { ...environment, ...env } });
  const cli = async (env, ...args) => JSON.parse((await run(env, ...args)).stdout);
  assert.deepEqual(await cli({}, "--version"), { product: "mau", version });
  const help = (await run({}, "--help")).stdout;
  for (const line of ["mau local [--dir DIR]", "mau login URL", "mau partner create NAME", "mau chat send NAME TEXT", "mau connector assign ID NAME", "mau api [METHOD] [PATH]"]) assert.ok(help.includes(line), line);
  assert.match((await run({}, "channel", "--help")).stdout, /--app-id: feishu: authorize an app that already exists/);
  assert.deepEqual(await failure(run({}, "agents")), { error: "unknown_command", commands: ["local", "login", "logout", "whoami", "profiles", "partner", "env", "ssh", "chat", "card", "memory", "channel", "connector", "api", "deploy", "doctor"] });
  // The installed client has no server: running Mau on this machine needs the source checkout, and says so.
  assert.equal((await failure(run({}, "local"))).error, "local_requires_source_checkout");
  assert.deepEqual(await failure(run({}, "whoami")), { error: "login_required" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  // Sign in with an Access service token from files, then use an Access token from the environment.
  const id = join(temporary, "access-id"), secret = join(temporary, "access-secret");
  await writeFile(id, "edge.access\n", { mode: 0o600 }); await writeFile(secret, "edge-secret\n", { mode: 0o600 });
  assert.deepEqual(await failure(run({}, "login", base)), { error: "access_credentials_required" });
  assert.deepEqual(await failure(run({}, "login", "http://mau.example")), { error: "invalid_service_url" });
  assert.deepEqual(await cli({}, "login", base, "--access-client-id-file", id, "--access-client-secret-file", secret), { owner: "@alice:example.test", url: base });
  // Only the service and the owner are saved; the credentials are read on every run.
  assert.deepEqual(JSON.parse(await readFile(join(temporary, "config/session.json"), "utf8")), { url: base, owner: "@alice:example.test" });
  assert.equal((await cli({ CF_ACCESS_CLIENT_ID_FILE: id, CF_ACCESS_CLIENT_SECRET_FILE: secret }, "partner", "list")).data[0].agent.name, "helper");
  const access = { CF_ACCESS_TOKEN: "edge-token" };
  assert.equal((await cli(access, "whoami")).via, "edge");
  assert.deepEqual(await failure(run({}, "partner", "list")), { error: "access_credentials_required" });
  assert.deepEqual(await failure(run({ CF_ACCESS_TOKEN: "wrong" }, "partner", "list")), { error: "edge_identity_invalid", httpStatus: 401 });
  assert.deepEqual(await failure(run(access, "partner", "show", "nobody")), { error: "partner_not_found", name: "nobody" });
  // Feishu recovery: authorize the existing app, follow the job until it is ready.
  assert.equal((await cli(access, "channel", "connect", "helper", "feishu", "--app-id", "cli_fixture", "--domain", "lark")).state, "ready");
  assert.equal(recovered, true);
  assert.deepEqual((await cli(access, "channel", "jobs", "helper")).data, [failed]);
  assert.deepEqual(await failure(run(access, "channel", "job", "helper", "recovery")),
    { error: "feishu_creation_outcome_unknown", job: failed, recover: "mau channel connect helper feishu --app-id cli_fixture --domain lark" });
  assert.equal((await failure(run(access, "channel", "connect", "helper", "weixin", "--app-id", "cli_fixture"))).error, "option_requires_feishu");
  assert.equal((await failure(run(access, "channel", "connect", "helper", "matrix"))).error, "unknown_channel");
  assert.equal((await failure(run(access, "channel", "connect", "helper", "feishu", "--app-id", "bad id"))).error, "invalid_feishu_app_id");
  assert.deepEqual(await cli(access, "logout"), { loggedOut: true });
  assert.deepEqual(await failure(run(access, "whoami")), { error: "login_required" });
  assert.ok(requests.includes("POST /_agent-router/v1/agents/helper/connections"));
  console.log("PASS: independent CLI install with its command and deployment modules, help, Access login with service token files and an Access token.");
  console.log("PASS: existing app recovery, job polling, recovery instructions and the JSON error contract.");
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
