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
  mau = createMau(
    {
      serverName: "example.test",
      publicUrl: "https://example.test/_agent-router/v1",
      stateDir: join(root, "router"),
      ledgerRead: true,
      ledgerSend: true,
    },
    options,
    { router: {
      authenticate: async (token) => {
        assert.equal(token, "fixture-owner");
        return owner;
      },
    } },
  );
  service = mau.router.service;
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
    // Owners sign in at the edge in production; this fixture's CLI and API calls use the bearer account below.
    edgeIdentity: { provider: "cloudflare-access", teamDomain: "https://example-team.cloudflareaccess.com", audiences: ["fixture"],
      owners: { "alice@example.test": owner } },
    nativeWork: { employeeTools: true },
    environments: {
      configFile: provider,
      modulePath: resolve("cloud-driver.mjs"),
      profiles: [
        {
          id: "cloud",
          label: "Cloud",
          owners: [owner],
          provider: "cloud",
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
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  await cli("login", "--url", base, "--token-file", tokenFile);
  const result = await cli("setup", "helper", "--environment", "cloud");
  assert.equal(result.environment.state, "ready");
  assert.equal((await cli("check")).checks[0].status, "verified");
  assert.deepEqual((await cli("status")).connections, []);
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
  // The owner's message arrives as the console sends it: through Router's ledger web channel.
  const web = async (path, body) => {
    const response = await fetch(base + "/_agent-router/v1/web" + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer fixture-owner", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  const chat = await web("/chats/dm", { agentId: agent.id });
  // Scheduled notices recorded in the owner's conversation (Router's ledger).
  const recorded = async text => (await web(`/chats/${encodeURIComponent(chat.chatId)}/events?limit=200`)).events
    .filter(event => event.kind === "notice" && event.text === text).length;
  await web(`/chats/${encodeURIComponent(chat.chatId)}/messages`, { idempotencyKey: "fixture-owner-message-1", text: "employee-orchestrate" });
  let incoming;
  for (let n = 0; n < 300 && !incoming; n++) {
    incoming = sessions.communication.status().inbox.find(value => value.connectionId === "web" && value.taskId);
    if (!incoming) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(incoming, "the owner's web message was not dispatched");
  const mainTask = incoming.taskId;
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
    notify: { channel: "web" },
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
  assert.equal(await recorded("Scheduled fixture report"), 1);
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
  // A rule without notify defaults to `web`: the reminder is recorded in the conversation.
  assert.equal(mau.proactive.rule(owner, direct.id).notify.channel, "web");
  assert.equal(await recorded("Fixed fixture reminder"), 1);
  assert.equal((await cli("destroy")).state, "deleted");
  console.log(
    "PASS: independent Mau/Router/Environment/Host archives, CLI setup, restart/resume, owner tool -> delegated task -> wait, narrowed fork, native skills/memory, frozen bounded memory, schedule held during manual pause -> explicit resume -> native toolOutput with current read-only memory -> stable outbox, trigger deduplication, and explicit destruction. Cloud lifecycle and Codex protocol are fixtures; no cloud/model acceptance is implied.",
  );
} finally {
  await shutdown();
  await close();
  await rm(root, { recursive: true, force: true });
}
