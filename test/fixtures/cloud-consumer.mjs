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
let service, mau, server, partnerTimer;
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
  // Stands in for the Cloudflare edge: the Access token the CLI sends is this fixture's bearer account.
  app.use((req, _res, next) => {
    if (req.headers["cf-access-token"] === "fixture-owner") { delete req.headers["cf-access-token"]; req.headers.authorization = "Bearer fixture-owner"; }
    next();
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
    // Owners sign in at the edge in production; this fixture's API calls use a bearer account, and its CLI an Access
    // token that the fixture's stand-in for the edge turns into that account.
    edgeIdentity: { provider: "cloudflare-access", teamDomain: "https://example-team.cloudflareaccess.com", audiences: ["fixture"],
      owners: { "alice@example.test": owner } },
    nativeWork: { partnerTools: true },
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
  const cli = async (...args) => {
    const r = await promisify(execFile)(
      process.execPath,
      [process.argv[2], ...args],
      { env: { ...process.env, MAU_CONFIG_DIR: configDir, CF_ACCESS_TOKEN: "fixture-owner" }, timeout: 30000 },
    );
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  await cli("login", base);
  const result = await cli("partner", "create", "helper", "--profile", "cloud");
  assert.equal(result.environment.state, "ready");
  assert.equal((await cli("partner", "check", "helper")).checks[0].status, "verified");
  assert.deepEqual((await cli("partner", "show", "helper")).connections, []);
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
    const task = await runtime.work.send(request, {
      sender: owner,
      room: "!fixture:example.test",
      approved: true,
    });
    for (let n = 0; n < 300; n++) {
      const current = await runtime.work.get(task.id);
      if (current.status.state === TaskState.TASK_STATE_COMPLETED)
        return current;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Host worker did not complete");
  }
  // Mau's own start is not used here, so the delivery of partner messages is driven as its timer would.
  partnerTimer = setInterval(() => { void mau?.partners.tick(); }, 100);
  const first = await turn("first cloud turn");
  assert.ok(JSON.stringify(first.artifacts).includes("first cloud turn"));
  assert.equal((await cli("env", "pause", "helper")).state, "paused");
  await shutdown();
  base = await open();
  // The service origin changed only because this is a loopback fixture restart.
  await cli("login", base);
  assert.equal((await cli("partner", "show", "helper")).environment.state, "paused");
  assert.equal((await cli("env", "resume", "helper")).state, "ready");
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
  await api(`/agents/${agent.id}/memory`, { action: "add", content: "Use concise fixture reports" });
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
  await web(`/chats/${encodeURIComponent(chat.chatId)}/messages`, { idempotencyKey: "fixture-owner-message-1", text: "partner-orchestrate" });
  let incoming;
  for (let n = 0; n < 300 && !incoming; n++) {
    incoming = sessions.communication.status().inbox.find(value => value.connectionId === "web" && value.taskId);
    if (!incoming) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(incoming, "the owner's web message was not dispatched");
  const mainTask = incoming.taskId;
  let orchestrated;
  for (let n = 0; n < 300; n++) {
    const current = await runtime.work.get(mainTask);
    if (current.status.state === TaskState.TASK_STATE_COMPLETED) { orchestrated = current; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(orchestrated, "owner orchestration did not complete");
  // The owner's turn recruited a partner into its own environment, sent it work and read the reply with wait.
  // The answer of a finished turn is recorded in the conversation by the channel loop, a moment after the task ends.
  const answered = async (text) => {
    for (let n = 0; n < 400; n++) {
      const found = (await web(`/chats/${encodeURIComponent(chat.chatId)}/events?limit=200`)).events
        .find(event => event.kind === "message" && event.role === "assistant" && event.text.includes(text));
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const told = JSON.parse((await answered("recruited")).text);
  assert.deepEqual(told.roster, { partners: [], kernels: ["codex"] });
  assert.equal(told.recruited.status, "recruited"); assert.equal(told.recruited.message.status, "sent");
  assert.equal(told.waited.results[0].status, "completed"); assert.deepEqual(told.waited.pending, []);
  assert.match(told.waited.results[0].answer, /^Delegated fixture: \[Partner message: delivered by the system, not written by the owner\]/);
  assert.match(told.waited.results[0].answer, /child fixture work$/);
  const scout = service.agents(owner).find(candidate => candidate.name === "scout");
  assert.equal(mau.environments.summary(owner, scout.id).sharedFrom, agent.id); assert.equal(count(), 1);
  // The partner handled the message in its own conversation with the owner, where the owner finds it as sent by the other partner.
  const scoutChat = await web("/chats/dm", { agentId: scout.id });
  const scoutEvents = (await web(`/chats/${encodeURIComponent(scoutChat.chatId)}/events?limit=200`)).events.filter(event => event.kind === "message");
  assert.deepEqual(scoutEvents.map(event => [event.role, event.sender.type, event.sender.id]), [["user", "agent", agent.id], ["assistant", "agent", scout.id]]);
  // A reply that was not waited for comes back as a turn of the sender, whose answer goes to the owner's conversation.
  await web(`/chats/${encodeURIComponent(chat.chatId)}/messages`, { idempotencyKey: "fixture-owner-message-2", text: "partner-orchestrate-later" });
  const returned = await answered("[Partner results");
  assert.ok(returned, "the partner's reply did not come back to the owner's conversation");
  assert.match(returned.text, /^Delegated fixture: \[Partner results: delivered by the system, not written by the owner\]/);
  assert.match(returned.text, /From: partner "scout"/); assert.match(returned.text, /Delegated fixture: \[Partner message[^]*later fixture work/);
  // The hand-over is recorded as done when the ending of its turn has been read from Router's settlement feed.
  for (let n = 0; n < 200 && mau.partners.messages(owner)[0].status !== "returned"; n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(mau.partners.messages(owner).map(message => [message.intent, message.status, message.deliveredBy]), [["ask", "returned", "turn"], ["relay", "collected", "wait"]]);
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
  assert.equal((await cli("env", "pause", "helper")).state, "paused");
  const trigger = await api(`/proactive/${rule.id}/run`, { requestId: "fixture-trigger" });
  await mau.proactive.tick();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(mau.environments.summary(owner, agent.id).state, "paused");
  assert.equal(mau.proactive.runs(owner, rule.id)[0].work.status, "submitted");
  // A deliberate owner pause must not be overridden by background work.
  assert.equal((await cli("env", "resume", "helper")).state, "ready");
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
  // The environment cannot go while a partner still works in it; that partner is deleted first, with its records.
  const removed = await fetch(`${base}/_mau/v1/agents/${scout.id}`, { method: "DELETE", headers: { authorization: "Bearer fixture-owner" } });
  assert.equal(removed.status, 204);
  assert.deepEqual(mau.partners.messages(owner).map(message => message.to.name), []);
  assert.equal((await cli("env", "destroy", "helper", "--yes")).state, "deleted");
  console.log(
    "PASS: independent Mau/Router/Environment/Host archives, CLI setup, restart/resume, owner tool -> recruited partner in the same environment -> message -> wait, a reply returned as a turn that answers the owner, narrowed fork, native skills/memory, frozen bounded memory, schedule held during manual pause -> explicit resume -> native toolOutput with current read-only memory -> stable outbox, trigger deduplication, and explicit destruction. Cloud lifecycle and Codex protocol are fixtures; no cloud/model acceptance is implied.",
  );
} finally {
  clearInterval(partnerTimer);
  await shutdown();
  await close();
  await rm(root, { recursive: true, force: true });
}
