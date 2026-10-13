import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { SendMessageRequest, TaskState } from "@a2a-js/sdk";
import { createMau } from "@olorinm/mau";
import { count, close } from "./cloud-driver.mjs";
const root = await mkdtemp(join(tmpdir(), "cloud-bootstrap-"));
const owner = "@alice:example.test";
let service, mau, server;
const allocation = createServer().listen(0, "127.0.0.1");
await new Promise((r) => allocation.once("listening", r));
const port = allocation.address().port;
await new Promise((r) => allocation.close(r));
const directory = join(root, "remote"),
  profile = join(root, "profile.json"),
  provider = join(root, "providers.json"),
  options = join(root, "mau.json"),
  logs = join(root, "native-requests.jsonl");
async function save(path, value) {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}
async function open() {
  const app = express();
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  const settings = JSON.parse(await readFile(options, "utf8"));
  settings.publicHomeserver = origin;
  await save(options, settings);
  mau = createMau(
    {
      serverName: "example.test",
      homeserver: "https://matrix.fixture",
      publicUrl: "https://example.test/_agent-router/v1",
      stateDir: join(root, "router"),
      asToken: "a".repeat(48),
      hsToken: "h".repeat(48),
    },
    options,
    { router: {
      authenticate: async (token) => {
        assert.equal(token, "fixture-owner");
        return owner;
      },
      provision: async () => {},
      transport: (agent) => ({
        identity: async () => agent.matrixId,
        sync: async (since) => {
          await new Promise((r) => setTimeout(r, 10));
          return { next_batch: since ?? "0" };
        },
        state: async () => [],
        history: async () => ({ events: [] }),
        createRoom: async () => "!fixture:example.test",
        join: async () => {},
        send: async () => "$fixture",
        stop: () => {},
      }),
    } },
  );
  service = mau.router.service;
  // Existing owner session verification stays in the Matrix authentication boundary.
  app.get("/_matrix/client/v3/account/whoami", (_req, res) =>
    res.json({ user_id: owner }),
  );
  app.post("/_matrix/client/v3/login", express.json(), (req, res) => {
    assert.equal(req.body.identifier.user, owner);
    assert.equal(req.body.password, "fixture-password");
    res.json({ access_token: "fixture-owner", user_id: owner });
  });
  app.use(mau.app);
  await service.start();
  return "http://127.0.0.1:" + server.address().port;
}
async function shutdown() {
  await mau?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    server = undefined;
  }
}
try {
  await save(profile, {
    stateDirectory: join(directory, "state"),
    port,
    runtimes: [
      {
        id: "personal",
        kernel: "codex",
        cwd: root,
        command: process.execPath,
        args: [process.argv[3]],
        env: { CODEX_TEST_LOG: logs },
      },
    ],
  });
  await save(provider, { root, directory, port });
  await save(options, {
    environments: {
      configFile: provider,
      modulePath: resolve("cloud-driver.mjs"),
      profiles: [
        {
          id: "cloud",
          label: "Cloud",
          owners: [owner],
          provider: "volc",
          template: "fixture",
          kernel: "codex",
          runtimeId: "personal",
          hostConfigFile: profile,
          directory,
          port,
        },
      ],
    },
  });
  let base = await open();
  const configDir = join(root, "cli");
  const tokenFile = join(root, "owner-token");
  await writeFile(tokenFile, "fixture-owner", { mode: 0o600 });
  const cli = async (...args) => {
    const r = await promisify(execFile)(
      process.execPath,
      [process.argv[2], "--allow-http", ...args],
      { env: { ...process.env, MAU_CONFIG_DIR: configDir }, timeout: 30000 },
    );
    assert.ok(!r.stdout.includes("fixture-private-cloud-key"));
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  const passwordFile = join(root, "password");
  await writeFile(passwordFile, "fixture-password", { mode: 0o600 });
  await cli("login", "--url", base, "--user", owner, "--password-file", passwordFile);
  const result = await cli("setup", "helper", "--environment", "cloud");
  assert.equal(result.environment.state, "ready");
  assert.equal((await cli("check")).checks[0].status, "verified");
  assert.equal((await cli("channel-connect", "matrix")).connections[0].kind, "matrix");
  assert.equal(count(), 1);
  const agent = result.agent;
  async function turn(text, contextId) {
    const runtime = await service.runtime(agent.id);
    const request = SendMessageRequest.fromJSON({
      message: {
        messageId: randomUUID(),
        role: "ROLE_USER",
        parts: [{ text }],
        ...(contextId ? { contextId } : {}),
      },
      configuration: { returnImmediately: true },
    });
    const task = await runtime.connector.cli.send(request, {
      sender: owner,
      room: "!fixture:example.test",
      approved: true,
    });
    for (let n = 0; n < 300; n++) {
      const current = await runtime.connector.cli.get(task.id);
      if (current.status.state === TaskState.TASK_STATE_COMPLETED)
        return current;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Host worker did not complete");
  }
  const first = await turn("first cloud turn");
  assert.ok(JSON.stringify(first.artifacts).includes("first cloud turn"));
  assert.equal((await cli("pause")).state, "paused");
  await shutdown();
  base = await open();
  await cli("login", "--url", base, "--token-file", tokenFile);
  // The service origin changed only because this is a loopback fixture restart.
  await cli("use", "helper");
  assert.equal((await cli("status")).environment.state, "paused");
  assert.equal((await cli("resume")).state, "ready");
  const second = await turn("continue cloud turn", first.contextId);
  assert.ok(JSON.stringify(second.artifacts).includes("continue cloud turn"));
  assert.equal(count(), 1);
  const native = (await readFile(logs, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(native.filter((r) => r.method === "thread/start").length, 1);
  assert.ok(native.some((r) => r.method === "thread/resume"));
  assert.equal((await cli("destroy")).state, "deleted");
  console.log(
    "PASS: independent Mau/Router/Environment/Host archives, Mau CLI setup, verified bootstrap, worker reply, Router + Host restart, same conversation resume, and explicit destruction. Cloud lifecycle and Codex protocol are fixtures; no cloud/model acceptance is implied.",
  );
} finally {
  await shutdown();
  await close();
  await rm(root, { recursive: true, force: true });
}
