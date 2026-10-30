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
const delivered = [];
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
        state: async () => [{ type: "m.room.member", state_key: owner, content: { membership: "join" } }],
        history: async () => ({ events: [] }),
        createRoom: async () => "!fixture:example.test",
        join: async () => {},
        send: async (...args) => { delivered.push(args); return "$fixture"; },
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
        args: [resolve("mau-native-server.mjs")],
        env: { CODEX_TEST_LOG: logs, MAU_TEST_BASE_FIXTURE: process.argv[3] },
        nativeAccess: { methods: ["skills/list", "skills/config/write", "memory/status", "thread/memoryMode/set"] },
      },
    ],
  });
  await save(provider, { root, directory, port });
  await save(options, {
    nativeWork: { employeeTools: true },
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
  assert.deepEqual((await cli("status")).connections, [
    { id: "matrix", kind: "matrix" },
  ]);
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
  const api = async (path, body) => {
    const response = await fetch(base + "/_mau/v1" + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer fixture-owner", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  await api(`/agents/${agent.id}/memory`, { action: "add", target: "user", content: "Use concise fixture reports" });
  assert.equal((await api(`/agents/${agent.id}/native/skills`)).data[0].skills[0].name, "fixture-skill");
  assert.equal((await api(`/agents/${agent.id}/native/memory`)).state, "disabled");
  const runtime = await service.runtime(agent.id), sessions = runtime.extension.sessions;
  const connection = sessions.communication.status().connections.find(value => value.kind === "matrix");
  assert.ok(connection);
  const incoming = sessions.communication.receive(connection.id, { externalId: "employee-main", sender: owner,
    threadId: "!fixture:example.test", scope: "direct", text: "employee-orchestrate",
    reply: { target: "!fixture:example.test", messageId: "employee-main", data: { sender: owner } } });
  await sessions.communication.dispatch();
  const mainTask = sessions.communication.status().inbox.find(value => value.id === incoming.id).taskId;
  let orchestrated;
  for (let n = 0; n < 300; n++) {
    const current = await runtime.connector.cli.get(mainTask);
    if (current.status.state === TaskState.TASK_STATE_COMPLETED) { orchestrated = current; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(orchestrated, "owner orchestration did not complete");
  assert.ok(JSON.stringify(orchestrated.artifacts).includes("Delegated fixture: child fixture work"), JSON.stringify(orchestrated.artifacts));
  const fork = await sessions.fork(incoming.conversationId, "restricted-fork");
  assert.equal(fork.parentSessionId, incoming.conversationId);
  const forked = await sessions.submit({ eventId: "restricted-followup", sessionId: "restricted-fork", input: "fork fixture work",
    admission: { kind: "delegation", owner, agentId: agent.id, reference: "fork-fixture", toolGrants: {} } });
  for (let n = 0; n < 200 && sessions.get(forked.eventId).status !== "completed"; n++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(sessions.get(forked.eventId).status, "completed");
  const rule = await api("/proactive", { agentId: agent.id, targetSessionId: incoming.conversationId, name: "Fixture schedule", goal: "Prepare a report",
    schedule: { type: "interval", minutes: 5 }, timeZone: "Asia/Shanghai", connections: [], notifications: "always", status: "active",
    skills: [{ name: "fixture-skill", path: "/trusted/fixture/SKILL.md" }] });
  assert.equal((await cli("pause")).state, "paused");
  const trigger = await api(`/proactive/${rule.id}/run`, { requestId: "fixture-trigger" });
  await mau.proactive.tick();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(mau.environments.summary(owner, agent.id).state, "paused");
  assert.equal(mau.proactive.runs(owner, rule.id)[0].work.status, "submitted");
  // A deliberate owner pause must not be overridden by background work.
  assert.equal((await cli("resume")).state, "ready");
  for (let n = 0; n < 600; n++) {
    await mau.proactive.tick();
    if (mau.proactive.runs(owner, rule.id)[0]?.status === "completed" && mau.proactive.notices(owner, rule.id)[0]?.status === "sent") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(mau.proactive.runs(owner, rule.id)[0].status, "completed", JSON.stringify({ runs: mau.proactive.runs(owner, rule.id), environment: mau.environments.summary(owner, agent.id), native: (await readFile(logs, "utf8")).trim().split("\n").map(JSON.parse).slice(-8) }));
  assert.equal(mau.proactive.notices(owner, rule.id)[0].status, "sent", JSON.stringify({ notices: mau.proactive.notices(owner, rule.id), communication: (await service.runtime(agent.id)).extension.sessions.communication.status() }));
  assert.equal((await api(`/proactive/${rule.id}/run`, { requestId: "fixture-trigger" })).id, trigger.id);
  await mau.proactive.tick();
  assert.equal(mau.proactive.runs(owner, rule.id).length, 1); assert.equal(count(), 1);
  assert.equal(delivered.filter(value => JSON.stringify(value).includes("Scheduled fixture report")).length, 1);
  const allNative = (await readFile(logs, "utf8")).trim().split("\n").map(JSON.parse);
  const scheduled = allNative.find(value => value.method === "turn/start" && value.params.toolOutput?.name === "proactive_work");
  assert.ok(scheduled && !scheduled.params.input?.length);
  assert.equal(JSON.parse(scheduled.params.toolOutput.output).skills[0].name, "fixture-skill");
  const scheduledMemory = JSON.parse(scheduled.params.toolOutput.output).scheduledMemory;
  assert.equal(scheduledMemory.mode, "read_only");
  assert.match(scheduledMemory.text, /Use concise fixture reports/);
  const scheduledContext = JSON.parse(scheduled.params.additionalContext.agent_host.value).scheduledMemory;
  const { text: _memoryText, ...memoryMetadata } = scheduledMemory;
  assert.deepEqual(scheduledContext, memoryMetadata);
  assert.equal(scheduled.params.additionalContext.agent_host.kind, "untrusted");
  assert.ok(allNative.some(value => value.method === "thread/start" && value.params.developerInstructions?.includes("Use concise fixture reports")));
  assert.match(JSON.stringify(await api(`/agents/${agent.id}/memory`)), /Use concise fixture reports/);
  const beforeDirect = (await readFile(logs, "utf8")).trim();
  const direct = await api("/proactive", { agentId: agent.id, targetSessionId: incoming.conversationId,
    name: "Fixed reminder", execution: { type: "direct", message: "Fixed fixture reminder" },
    schedule: { type: "interval", minutes: 5 }, timeZone: "UTC", status: "active" });
  await api(`/proactive/${direct.id}/run`, { requestId: "fixed-reminder" });
  for (let n = 0; n < 200; n++) {
    await mau.proactive.tick();
    if (mau.proactive.notices(owner, direct.id)[0]?.status === "sent") break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(mau.proactive.notices(owner, direct.id)[0]?.status, "sent");
  assert.equal((await readFile(logs, "utf8")).trim(), beforeDirect);
  assert.equal(delivered.filter(value => JSON.stringify(value).includes("Fixed fixture reminder")).length, 1);
  assert.equal((await cli("destroy")).state, "deleted");
  console.log(
    "PASS: independent Mau/Router/Environment/Host archives, CLI setup, restart/resume, owner tool -> delegated task -> wait, narrowed fork, native skills/memory, frozen bounded memory, schedule held during manual pause -> explicit resume -> native toolOutput with current read-only memory -> stable outbox, trigger deduplication, and explicit destruction. Cloud lifecycle and Codex protocol are fixtures; no cloud/model acceptance is implied.",
  );
} finally {
  await shutdown();
  await close();
  await rm(root, { recursive: true, force: true });
}
