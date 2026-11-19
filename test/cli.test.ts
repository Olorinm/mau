import { afterEach, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigningKey } from "@olorinm/agent-connectors/issuer";
import { privateFile } from "../src/files.js";
import { aliceToken, builtCli, edgeProxy } from "./fixtures/edge.js";
import { alice, mauFixture } from "./fixtures/mau.js";
import { memoryExternalHosts } from "./fixtures/external-hosts.js";
import { partnersFixture } from "./fixtures/partners.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const temporary = () => { const d = mkdtempSync(join(tmpdir(), "mau-cli-")); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; };
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => unknown) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

it("drives a Mau service behind its edge: partners, chat, memory, connectors and the API reference", async () => {
  const directory = temporary(), authority = await generateSigningKey("authority");
  privateFile(join(directory, "authority.json"), authority.privateJwk);
  const connectors = await listen((_req, res) => res.setHeader("Content-Type", "application/json").end(JSON.stringify({ connections: [
    { id: "alice-gmail", kind: "google", owner: alice, label: "Gmail", account: { status: "connected", verification: "oauth" } }] })));
  const links = memoryExternalHosts();
  const f = await partnersFixture(cleanup, { externalHosts: links.hosts, mau: {
    connectorAccounts: { url: connectors, issuer: "fixture", audience: "fixture-connectors", authorityKeyFile: join(directory, "authority.json"), consentOrigins: ["https://accounts.example.test"] },
    connectedApps: { url: connectors, issuer: "fixture", audience: "fixture-connectors", callerKeyFile: join(directory, "authority.json") } } });
  // The Host is given the owner's text followed by its channel context; the scripted partner answers the text.
  const answer = (turn: { text: string }) => `answer to ${turn.text.split("\n")[0]}`;
  f.respond(answer);
  const edge = await edgeProxy(cleanup, () => f.base, f.access.jwt);
  const mau = builtCli(cleanup, { CF_ACCESS_TOKEN: aliceToken }), ok = async (...args: string[]) => {
    const run = await mau(...args);
    expect(run, args.join(" ")).toMatchObject({ code: 0 });
    return run.json;
  };

  // Signing in saves the service and the owner, never a credential.
  expect(await mau("whoami")).toMatchObject({ code: 1, stdout: "", error: { error: "login_required" } });
  expect((await builtCli(cleanup)("login", edge)).error).toEqual({ error: "access_credentials_required" });
  expect((await builtCli(cleanup, { CF_ACCESS_TOKEN: "stranger" })("login", edge)).error).toMatchObject({ httpStatus: 401 });
  expect(await ok("login", edge)).toEqual({ owner: alice, url: edge });
  expect(await ok("whoami")).toMatchObject({ owner: alice, via: "edge", email: "alice@example.test" });
  expect((await ok("profiles")).environments).toEqual([{ id: "cloud", label: "Cloud", kernel: "codex", kernels: ["codex"] }]);

  // Partners: one with an environment of its own (waits until it is ready), one in another partner's environment.
  expect((await ok("partner", "list")).data.map((item: any) => item.agent.name)).toEqual(["helper"]);
  const scout = await ok("partner", "create", "scout", "--profile", "cloud", "--duty", "Finds things");
  expect(scout).toMatchObject({ agent: { name: "scout", owner: alice }, duty: "Finds things", environment: { state: "ready", busy: false } });
  const mate = await ok("partner", "create", "mate", "--share", "helper");
  expect(mate).toMatchObject({ agent: { name: "mate" }, environment: { sharedFrom: f.agent.id } });
  expect(await ok("partner", "show", "scout")).toEqual(scout);
  expect((await mau("partner", "create", "extra")).error).toMatchObject({ error: "choose_profile_share_or_external" });
  expect((await mau("partner", "create", "scout", "--profile", "cloud")).error).toEqual({ error: "partner_exists", name: "scout" });
  // An agent on the owner's computer: the answer has the pairing code once, and its computer is managed under `device`.
  const laptop = await ok("partner", "create", "laptop", "--external", "--duty", "Works on my laptop");
  expect(laptop).toMatchObject({ agent: { name: "laptop" }, kind: "external", connection: "pairing", device: null, duty: "Works on my laptop",
    pairing: { code: expect.stringMatching(/^PAIR-/), command: expect.stringContaining("--code PAIR-") } });
  expect((await mau("partner", "create", "both", "--external", "--profile", "cloud")).error).toMatchObject({ error: "choose_profile_share_or_external" });
  expect(await ok("device", "show", "laptop")).toEqual({ ownership: "owner", connection: "pairing", device: null });
  const paired = links.enroll((await ok("device", "pair", "laptop")).code);
  await f.until(async () => (await ok("partner", "show", "laptop")).host, "paired");
  expect(await ok("device", "list")).toEqual({ data: [{ partner: { id: laptop.agent.id, name: "laptop" }, ownership: "owner", connection: "online",
    device: { id: paired.id, name: "laptop", platform: "darwin", kernel: "claude", online: true, pairedAt: paired.createdAt, lastSeenAt: expect.any(String) } }] });
  expect((await mau("device", "show", "scout")).error).toMatchObject({ error: "partner_not_external" });
  expect((await mau("env", "show", "laptop")).error).toMatchObject({ error: "not_available_for_external_partner" });
  expect((await mau("device", "remove", "laptop")).error).toMatchObject({ error: "confirm_with_yes" });
  expect(await ok("device", "remove", "laptop", "--yes")).toEqual({ removed: "laptop" });
  expect(await ok("device", "show", "laptop")).toEqual({ ownership: "owner", connection: "pairing", device: null });
  expect(await ok("partner", "delete", "laptop", "--yes")).toEqual({ deleted: "laptop" });
  expect(await ok("env", "show", "scout")).toMatchObject({ state: "ready", profileId: "cloud" });
  expect(await ok("env", "pause", "scout")).toMatchObject({ state: "paused", busy: false });
  expect((await ok("partner", "dismiss", "scout")).dismissed).toBeTruthy();
  expect((await ok("partner", "restore", "scout")).dismissed).toBeNull();
  expect(await ok("partner", "model", "helper")).toMatchObject({ kernel: "codex", defaultModel: "large", selection: {}, source: "live" });
  expect((await ok("partner", "model", "helper", "--set", "model=small", "--set", "effort=low")).selection).toEqual({ model: "small", effort: "low" });
  expect((await ok("partner", "model", "helper", "--set", "effort=")).selection).toEqual({ model: "small" });
  expect((await mau("partner", "model", "helper", "--set", "speed=fast")).error).toEqual({ error: "unknown_setting", setting: "speed", settings: ["model", "effort"] });

  // Chat: sending waits for the partner's turn and prints its reply.
  const sent = await ok("chat", "send", "helper", "hello");
  expect(sent).toMatchObject({ chatId: `dm:${f.agent.id}`, state: "completed", replies: [{ role: "assistant", text: "answer to hello" }], pendingCards: [] });
  const shown = await ok("chat", "show", "helper", "--limit", "5");
  expect(shown.messages.map((item: any) => [item.role, item.text])).toEqual([["user", "hello"], ["assistant", "answer to hello"]]);
  expect(shown.messages[0]).toMatchObject({ eventId: sent.eventId, seq: sent.seq });
  expect(await ok("chat", "send", "helper", "again", "--no-wait")).toMatchObject({ state: "queued", replies: [] });
  await f.until(async () => (await f.answers(f.agent.id)).length === 2, "second answer");
  expect((await ok("chat", "show", "helper", "--limit", "1")).messages.map((item: any) => item.text)).toEqual(["answer to again"]);
  expect((await ok("chat", "list")).data.map((chat: any) => chat.chatId)).toContain(`dm:${f.agent.id}`);
  expect(await ok("card", "list")).toEqual({ data: [] });
  expect(await ok("card", "list", "helper")).toEqual({ data: [] });
  expect((await ok("chat", "new", "helper")).window).toBeGreaterThan(0);
  // A turn that fails is a failure of the command, with what the partner said until then.
  f.respond(() => { throw new Error("model unavailable"); });
  expect(await mau("chat", "send", "helper", "break")).toMatchObject({ code: 1, stdout: "", error: { error: "turn_failed", chatId: `dm:${f.agent.id}`, state: "failed" } });
  f.respond(answer);

  // Memory: add, read, look at the change and take it back.
  await ok("memory", "add", "helper", "Alice drinks tea.");
  expect((await ok("memory", "show", "helper")).entries).toEqual(["Alice drinks tea."]);
  await ok("memory", "replace", "helper", "tea", "Alice drinks coffee.");
  const log = (await ok("memory", "log", "helper")).data;
  expect(log.map((mutation: any) => mutation.changes[0].action)).toEqual(["replace", "add"]);
  await ok("memory", "undo", "helper", log[0].id);
  expect((await ok("memory", "show", "helper")).entries).toEqual(["Alice drinks tea."]);
  await ok("memory", "remove", "helper", "tea");
  expect((await ok("memory", "show", "helper")).entries).toEqual([]);
  expect((await mau("memory", "undo", "helper", "missing")).error).toMatchObject({ error: "memory_mutation_not_found", httpStatus: 404 });

  // Connectors: what a partner can use is set by name, and applies without a restart.
  expect((await ok("connector", "list")).data.map((account: any) => [account.id, account.state])).toEqual([["alice-gmail", "connected"]]);
  expect(await ok("connector", "show", "alice-gmail")).toMatchObject({ id: "alice-gmail", kind: "google", state: "connected" });
  expect(await ok("connector", "assign", "alice-gmail", "helper")).toEqual({ connections: ["alice-gmail"] });
  expect((await ok("connector", "show", "alice-gmail")).assignedAgents).toEqual([f.agent.id, mate.agent.id]);
  // "mate" uses helper's connections; it cannot give up one it only inherits.
  expect((await mau("connector", "unassign", "alice-gmail", "mate")).error).toEqual({ error: "connector_inherited", id: "alice-gmail", inheritedFrom: { id: f.agent.id, name: "helper" } });
  expect(await ok("connector", "unassign", "alice-gmail", "helper")).toEqual({ connections: [] });
  expect((await mau("connector", "assign", "missing", "helper")).error).toEqual({ error: "connector_account_not_found", id: "missing" });
  expect((await mau("connector", "disconnect", "alice-gmail")).error).toMatchObject({ error: "confirm_with_yes", option: "--yes" });

  // The API reference and a direct call.
  const reference = await ok("api");
  expect(reference.routes).toContainEqual(expect.objectContaining({ method: "PUT", path: "/_mau/v1/agents/:id/connectors" }));
  expect((await ok("api", "GET", `/_mau/v1/agents/${f.agent.id}/connectors`))).toEqual({ connections: [] });
  expect(await ok("api", "PUT", `/_mau/v1/agents/${f.agent.id}/connectors`, "--data", JSON.stringify({ connections: ["alice-gmail"] }))).toEqual({ connections: ["alice-gmail"] });
  const body = join(directory, "body.json"); writeFileSync(body, JSON.stringify({ connections: [] }));
  expect(await ok("api", "PUT", `/_mau/v1/agents/${f.agent.id}/connectors`, "--data-file", body)).toEqual({ connections: [] });
  expect((await ok("api", "GET", "/_agent-router/v1/web/me")).ownerId).toBe(alice);
  expect((await mau("api", "GET", "/health/live")).error).toMatchObject({ error: "invalid_api_path" });
  expect((await mau("api", "POST", "/_mau/v1/agents", "--data", "{")).error).toEqual({ error: "invalid_json_body" });

  // Failures: one JSON object on the last stderr line with what the server said, exit code 1, nothing on stdout.
  expect(await mau("partner", "show", "nobody")).toMatchObject({ code: 1, stdout: "", error: { error: "partner_not_found", name: "nobody" } });
  const refused = await mau("partner", "delete", "helper", "--yes");
  expect(refused).toMatchObject({ code: 1, stdout: "", error: { error: "environment_shared_by_partners", httpStatus: 409, partners: [{ id: mate.agent.id, name: "mate" }] } });
  expect(refused.stderr.trimEnd().split("\n")).toHaveLength(1);
  expect((await mau("partner", "delete", "mate")).error).toMatchObject({ error: "confirm_with_yes", option: "--yes" });
  expect((await mau("partner", "list", "--token-file", "x")).error).toMatchObject({ error: "invalid_arguments", usage: expect.stringContaining("mau partner list") });
  expect((await mau("partner", "show")).error).toMatchObject({ error: "invalid_arguments", usage: expect.stringContaining("mau partner show NAME") });
  expect((await mau("partner")).error).toMatchObject({ error: "unknown_command", usage: expect.arrayContaining([expect.stringContaining("mau partner list")]) });
  expect(await ok("partner", "delete", "mate", "--yes")).toEqual({ deleted: "mate" });
  expect(await ok("partner", "delete", "scout", "--yes")).toEqual({ deleted: "scout" });
  expect((await ok("partner", "list")).data.map((item: any) => item.agent.name)).toEqual(["helper"]);
  expect(await ok("logout")).toEqual({ loggedOut: true });
  expect((await mau("partner", "list")).error).toEqual({ error: "login_required" });
}, 120_000);

it("edits a channel connection's access lists and removes the connection through Router", async () => {
  const f = await mauFixture(cleanup);
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");
  // A Feishu connection as Router's setup job leaves it: `feishu/credentials.json` and the app secret in the agent's directory.
  const connections = f.mau.router.connections, dir = join(connections.agentDirectory(f.agent.id), "feishu");
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "feishu-secret"), "fixture-secret\n", { mode: 0o600 });
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ version: 1, appId: "cli_fixture", appSecretFile: "feishu-secret", domain: "feishu", ownerOpenId: "ou_owner" }), { mode: 0o600 });
  await connections.edit(alice, f.agent.id, config => {
    config.connections.push({ id: "feishu", kind: "feishu", credentialsFile: join(dir, "credentials.json"), domain: "feishu", ownerAddresses: ["ou_owner"], peerAddresses: ["ou_p1", "ou_p2"], groupIds: ["oc_g1"] });
  });
  const edge = await edgeProxy(cleanup, () => f.base, f.access.jwt), mau = builtCli(cleanup, { CF_ACCESS_TOKEN: aliceToken });
  expect((await mau("login", edge)).json).toEqual({ owner: alice, url: edge });
  // Access: no option shows; an option replaces its list and keeps the other.
  expect((await mau("channel", "access", "helper", "feishu")).json).toEqual({ groupIds: ["oc_g1"], peerAddresses: ["ou_p1", "ou_p2"], ownerAddresses: ["ou_owner"] });
  expect((await mau("channel", "access", "helper", "feishu", "--groups", "oc_g2, oc_g3")).json).toEqual({ groupIds: ["oc_g2", "oc_g3"], peerAddresses: ["ou_p1", "ou_p2"], ownerAddresses: ["ou_owner"] });
  expect((await mau("channel", "access", "helper", "feishu", "--peers", "", "--groups", "oc_g4")).json).toEqual({ groupIds: ["oc_g4"], peerAddresses: [], ownerAddresses: ["ou_owner"] });
  expect(connections.configuration(f.service.agent(f.agent.id))!.connections[0]).toMatchObject({ groupIds: ["oc_g4"], peerAddresses: [] });
  expect((await mau("channel", "access", "helper", "gone")).error).toMatchObject({ error: "connection_not_found", httpStatus: 404 });
  // Disconnecting needs --yes, removes the connection with its credential files, and reports the server's error as it is.
  expect((await mau("channel", "disconnect", "helper", "feishu")).error).toMatchObject({ error: "confirm_with_yes", option: "--yes" });
  expect(connections.summary(f.service.agent(f.agent.id)).connections.map(connection => connection.id)).toContain("feishu");
  const removed = (await mau("channel", "disconnect", "helper", "feishu", "--yes")).json;
  expect(removed.agent).toMatchObject({ id: f.agent.id, name: "helper" });
  expect(removed.connections.map((connection: { id: string }) => connection.id)).not.toContain("feishu");
  expect(existsSync(dir)).toBe(false);
  expect(await mau("channel", "disconnect", "helper", "feishu", "--yes")).toMatchObject({ code: 1, stdout: "", error: { error: "connection_not_found", httpStatus: 404 } });
  expect(await mau("channel", "disconnect", "helper", "web", "--yes")).toMatchObject({ code: 1, error: { error: "connection_not_found", httpStatus: 404 } });
}, 60_000);

/**
 * A service made of canned answers, for what the fixture service cannot do: channel checks and connection jobs that
 * reach a chat platform, cards, and connector consent.
 */
async function stubService(routes: Record<string, (body: any, res: ServerResponse) => unknown>) {
  const requests: Array<{ call: string; body: any }> = [];
  const base = await listen(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const call = `${req.method} ${req.url}`, body = raw ? JSON.parse(raw) : undefined;
    requests.push({ call, body });
    res.setHeader("Content-Type", "application/json");
    if (req.headers["cf-access-token"] !== aliceToken) { res.writeHead(401).end(JSON.stringify({ error: "edge_identity_invalid" })); return; }
    const route = routes[call];
    if (!route) { res.writeHead(404).end(JSON.stringify({ error: "not_found" })); return; }
    const answer = await route(body, res);
    if (!res.writableEnded) res.end(JSON.stringify(answer));
  });
  const mau = builtCli(cleanup, { CF_ACCESS_TOKEN: aliceToken });
  return { base, mau, requests, bodies: (call: string) => requests.filter(request => request.call === call).map(request => request.body) };
}
const account = { "GET /_mau/v1/account": () => ({ owner: alice }),
  "GET /_mau/v1/agents": () => ({ data: [{ agent: { id: "a1", name: "helper" }, connections: [{ id: "feishu", kind: "feishu" }, { id: "web", kind: "web" }] }] }) };
const refuse = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status).end(JSON.stringify(body)); };

it("checks a partner's channels and follows connection jobs that need a person", async () => {
  const s = await stubService({ ...account,
    "POST /_agent-router/v1/agents/a1/check": () => ({ checks: [{ agentId: "a1", kind: "host", status: "verified", detail: "Host is ready." },
      { agentId: "a1", connectionId: "feishu", kind: "feishu", status: "needs_action", detail: "Bot is not in any chat." }] }),
    "POST /_agent-router/v1/agents/a1/connections": () => ({ id: "j1", kind: "weixin", state: "starting", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    "GET /_agent-router/v1/agents/a1/connection-jobs/j1": () => ({ id: "j1", kind: "weixin", state: "waiting", url: "https://login.example.test/qr?code=1", qr: "[QR]", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    "GET /_agent-router/v1/agents/a1/connection-jobs/j2": () => ({ id: "j2", kind: "weixin", state: "pairing", url: "https://login.example.test/qr?code=1", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    "POST /_agent-router/v1/agents/a1/connection-jobs/j2/pairing": (_body, res) => { res.writeHead(204).end(); } });
  expect((await s.mau("login", s.base)).json).toEqual({ owner: alice, url: s.base });
  expect((await s.mau("channel", "list", "helper")).json).toEqual({ data: [{ id: "feishu", kind: "feishu", status: "needs_action", detail: "Bot is not in any chat." }, { id: "web", kind: "web" }],
    checks: [{ agentId: "a1", kind: "host", status: "verified", detail: "Host is ready." }] });
  // A job that needs a person: the link and QR code on stderr, and in the result what to hand over.
  const waiting = await s.mau("channel", "connect", "helper", "weixin", "--no-wait");
  expect(waiting.json).toMatchObject({ id: "j1", state: "waiting", needsOwner: { action: "open_link", url: "https://login.example.test/qr?code=1" } });
  expect(waiting.stderr).toBe("https://login.example.test/qr?code=1\n[QR]\n");
  expect((await s.mau("channel", "job", "helper", "j2")).json.needsOwner).toEqual({ action: "enter_pairing_code", command: "mau channel pair helper j2 --code-file FILE" });
  const code = join(temporary(), "code"); writeFileSync(code, "123456\n");
  expect((await s.mau("channel", "pair", "helper", "j2", "--code-file", code)).json).toEqual({ paired: true });
  expect(s.bodies("POST /_agent-router/v1/agents/a1/connection-jobs/j2/pairing")).toEqual([{ code: "123456" }]);
  expect((await s.mau("channel", "pair", "helper", "j2")).error).toEqual({ error: "option_required", option: "--code-file", usage: "mau channel pair NAME JOB_ID --code-file FILE" });
  expect((await s.mau("env", "create", "helper")).error).toMatchObject({ error: "option_required", option: "--profile" });
  expect((await s.mau("channel", "connect", "helper", "telegram")).error).toEqual({ error: "bot_token_file_required" });
}, 60_000);

it("lists pending cards and answers one by its choice, then follows the partner's turn", async () => {
  const card = { cardId: "c1", agentId: "a1", turnId: "t1", kind: "approval", text: "Send the mail?", freeText: false, status: "pending", deadlineAt: null,
    choices: [{ choiceId: "0", label: "Allow" }, { choiceId: "1", label: "Deny" }] };
  const events: any[] = [{ seq: 1, eventId: "e1", kind: "card", turnId: "t1", card }];
  let state = "waiting";
  const chat = "/_agent-router/v1/web/chats/dm%3Aa1", summary = () => ({ chatId: "dm:a1", agentIds: ["a1"], pendingCards: state === "waiting" ? 1 : 0, activeTurns: 1 });
  const page = (after: number) => ({ mode: "page", lastSeq: events.length, events: events.filter(event => event.seq > after), olderCursor: null, newerCursor: null });
  const s = await stubService({ ...account,
    "GET /_agent-router/v1/web/chats?archived=false": () => ({ data: [summary()], next: null }),
    [`GET ${chat}/events?limit=200`]: () => page(0),
    [`GET ${chat}/events?limit=1`]: () => page(0),
    [`GET ${chat}/events?limit=200&after=1`]: () => page(1),
    [`GET ${chat}/events?limit=200&after=3`]: () => page(3),
    [`GET ${chat}/cards/c1`]: () => card,
    [`GET ${chat}/cards/c9`]: (_body, res) => refuse(res, 404, { error: "card_not_found" }),
    [`GET ${chat}/turns/t1`]: () => ({ turnId: "t1", state }),
    [`POST ${chat}/cards/c1/answer`]: body => {
      if (body.choiceId === "1") return { status: "stale", card: { ...card, status: "approved" } };
      // The partner goes on and finishes its turn.
      events.push({ seq: 2, eventId: "e2", kind: "card.update", turnId: "t1", cardId: "c1", status: "approved" },
        { seq: 3, eventId: "e3", kind: "message", role: "assistant", turnId: "t1", at: "2026-01-01T00:00:00Z", sender: { name: "helper" }, text: "Sent." });
      state = "completed";
      return { status: "accepted", card: { ...card, status: "approved" } };
    } });
  await s.mau("login", s.base);
  expect((await s.mau("card", "list")).json).toEqual({ data: [{ ...card, chatId: "dm:a1", partner: "helper" }] });
  expect((await s.mau("card", "list", "helper")).json.data).toHaveLength(1);
  // An answer that is none of the card's choices is refused before anything is sent; so is another card.
  expect((await s.mau("card", "answer", "helper", "c1", "maybe")).error).toEqual({ error: "choice_not_found", cardId: "c1", choices: card.choices });
  expect((await s.mau("card", "answer", "helper", "c9", "Allow")).error).toEqual({ error: "card_not_found", cardId: "c9" });
  expect((await s.mau("card", "answer", "helper", "c1", "Deny")).error).toMatchObject({ error: "card_already_answered", card: { status: "approved" } });
  expect((await s.mau("card", "answer", "helper", "c1", "Allow")).json).toEqual({ chatId: "dm:a1", card: { ...card, status: "approved" }, turnId: "t1", state: "completed",
    replies: [{ eventId: "e3", seq: 3, at: "2026-01-01T00:00:00Z", role: "assistant", sender: "helper", text: "Sent." }], pendingCards: [] });
  const answers = s.bodies(`POST ${chat}/cards/c1/answer`);
  expect(answers.map(({ idempotencyKey, ...answer }) => answer)).toEqual([{ choiceId: "1" }, { choiceId: "0" }]);
  expect(answers[0].idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  expect((await s.mau("card", "list")).json).toEqual({ data: [] });
}, 60_000);

it("authorizes a Feishu connection by its consent link and sends OAuth consent to the console", async () => {
  let completes = 0; const consent = "https://accounts.example.test/device?user_code=FIXTURE";
  const pending = { state: "authorization_pending", verification: "none", scopes: [], authorizationUrl: consent, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const accounts = [{ id: "alice-feishu", kind: "feishu", label: "Feishu", state: "authorization_required" }, { id: "alice-gmail", kind: "google", label: "Gmail", state: "authorization_required" },
    { id: "alice-browser", kind: "browser", label: "Browser", state: "connected" }];
  const policy = { groups: [{ id: "mail", label: "Mail", labelZh: "邮件", operations: [{ id: "mail.send", label: "Send", labelZh: "发送", risk: "write", setting: "ask", default: "ask", available: true }] }] };
  const s = await stubService({ ...account,
    "GET /_mau/v1/connector-accounts": () => ({ configured: true, data: accounts }),
    "POST /_mau/v1/connector-accounts/alice-feishu/feishu-application": () => ({ state: "authorization_required" }),
    "POST /_mau/v1/connector-accounts/alice-feishu/connect": () => pending,
    "POST /_mau/v1/connector-accounts/alice-feishu/complete": () => ++completes < 2 ? pending : { state: "connected", verification: "provider", scopes: ["mail:read"], name: "Alice" },
    // The service binds OAuth consent to the browser that asked for it, with a cookie on its callback.
    "POST /_mau/v1/connector-accounts/alice-gmail/connect": (_body, res) => {
      res.setHeader("Set-Cookie", "mau_oauth_0123456789abcdef0123=nonce; Path=/oauth/callback; HttpOnly; SameSite=Lax");
      return { state: "authorization_required", verification: "none", scopes: [], authorizationUrl: "https://accounts.example.test/o/oauth2/auth?state=fixture" };
    },
    "POST /_mau/v1/connector-accounts/alice-gmail/disconnect": () => ({ state: "disconnected", verification: "none", scopes: [] }),
    "GET /_mau/v1/connector-accounts/alice-gmail/policy": () => policy,
    "PUT /_mau/v1/connector-accounts/alice-gmail/policy": () => policy,
    "POST /_mau/v1/connector-accounts/alice-gmail/policy/reset": () => policy,
    "GET /_mau/v1/connector-accounts/alice-browser/access": () => ({ webAccess: "ask", sites: ["example.test", "docs.example.test"] }),
    "PUT /_mau/v1/connector-accounts/alice-browser/access": body => ({ webAccess: body.webAccess ?? "direct", sites: ["example.test"] }) });
  await s.mau("login", s.base);
  // Feishu device consent: the link is the owner's to open; the command waits until the service says it is confirmed.
  const started = await s.mau("connector", "connect", "alice-feishu", "--partner", "helper", "--no-wait");
  expect(started.json).toMatchObject({ state: "authorization_pending", needsOwner: { action: "open_link", url: consent } });
  expect(started.stderr).toBe(consent + "\n");
  expect(s.bodies("POST /_mau/v1/connector-accounts/alice-feishu/feishu-application")).toEqual([{ agentId: "a1" }]);
  expect((await s.mau("connector", "connect", "alice-feishu")).json).toEqual({ state: "connected", verification: "provider", scopes: ["mail:read"], name: "Alice" });
  expect(completes).toBe(2);
  // OAuth consent cannot be finished from here: the result says where the owner does it.
  expect(await s.mau("connector", "connect", "alice-gmail")).toMatchObject({ code: 1, stdout: "",
    error: { error: "connector_consent_requires_console", id: "alice-gmail", needsOwner: { action: "connect_in_console", url: s.base + "/?view=connectors" } } });
  expect((await s.mau("connector", "connect", "alice-gmail", "--partner", "helper")).error).toEqual({ error: "partner_option_requires_feishu" });
  expect((await s.mau("connector", "disconnect", "alice-gmail", "--yes")).json.state).toBe("disconnected");
  // Policy and site access mirror the service's bodies.
  expect((await s.mau("connector", "policy", "alice-gmail")).json).toEqual(policy);
  await s.mau("connector", "policy", "alice-gmail", "--set", "mail.send=allow", "--set", "mail.read=deny");
  expect(s.bodies("PUT /_mau/v1/connector-accounts/alice-gmail/policy")).toEqual([{ settings: { "mail.send": "allow", "mail.read": "deny" } }]);
  expect((await s.mau("connector", "policy", "alice-gmail", "--set", "mail.send=maybe")).error).toMatchObject({ error: "invalid_setting", operation: "mail.send" });
  expect((await s.mau("connector", "policy", "alice-gmail", "--reset", "--set", "mail.send=allow")).error).toEqual({ error: "choose_set_or_reset" });
  expect((await s.mau("connector", "policy", "alice-gmail", "--reset")).json).toEqual(policy);
  expect((await s.mau("connector", "sites", "alice-browser")).json).toEqual({ webAccess: "ask", sites: ["example.test", "docs.example.test"] });
  expect((await s.mau("connector", "sites", "alice-browser", "--mode", "direct", "--remove", "docs.example.test")).json).toEqual({ webAccess: "direct", sites: ["example.test"] });
  expect(s.bodies("PUT /_mau/v1/connector-accounts/alice-browser/access")).toEqual([{ webAccess: "direct" }, { remove: "docs.example.test" }]);
}, 60_000);
