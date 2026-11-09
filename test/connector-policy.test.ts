import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceHttp } from "@agent-router/server";
import { generateSigningKey } from "@olorinm/agent-connectors/issuer";
import { TokenVerifier } from "@olorinm/agent-connectors";
import { BusinessHost } from "../src/business-tools.js";
import { connectedAppDefinition, type ConnectedAppReader } from "../src/connected-apps.js";
import { APPROVAL_PREFIX, type ApprovalPort } from "../src/connector-approvals.js";
import type { OperationView } from "../src/connector-accounts.js";
import { DurableStore } from "../src/store.js";
import { privateFile } from "../src/files.js";
import { mauFixture, alice, bob } from "./fixtures/mau.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

const operation = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, labelZh: id, risk: "read", setting: "allow", default: "allow", available: true, ...extra });
/** The connector service's policy endpoints and account list, as a fake upstream with a real service-token check. */
async function upstream() {
  const directory = mkdtempSync(join(tmpdir(), "mau-policy-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const authority = await generateSigningKey("authority"), caller = await generateSigningKey("caller");
  const keyFile = join(directory, "authority.json"); privateFile(keyFile, authority.privateJwk);
  const tokens = new TokenVerifier({ issuer: "fixture", audience: "fixture-connectors", callerKeys: { keys: [caller.publicJwk] }, authorityKeys: { keys: [authority.publicJwk] } });
  const state = {
    requests: [] as Array<{ method: string; url: string; body?: unknown }>,
    accounts: {
      "alice-gmail": { status: "connected", verification: "oauth", accountEmail: "owner@example.test", scopes: ["https://www.googleapis.com/auth/gmail.readonly"], refresh_token: "never-return-this" },
      "alice-feishu": { status: "authorization_pending", authorizationUrl: "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD", expiresAt: "2030-01-01T00:00:00.000Z" },
      "bob-drive": { status: "connected", verification: "oauth" },
    } as Record<string, Record<string, unknown>>,
    entries: [{ id: "alice-gmail", kind: "google", owner: alice, label: "Gmail" }, { id: "alice-feishu", kind: "feishu", owner: alice, label: "飞书", usage: "owner_private" },
      { id: "bob-drive", kind: "google", owner: bob, label: "Drive" }],
    policy: { groups: [{ id: "read", label: "Read", labelZh: "读取权限", internal: "never-return-this", operations: [operation("gmail.messages.read", { internal: "never-return-this" })] },
      { id: "write", label: "Write and delete", labelZh: "写入和删除权限", operations: [
        operation("gmail.send", { risk: "write", setting: "ask", default: "ask", available: false, unavailableReason: "scope_required", grantable: true, grantScope: "https://www.googleapis.com/auth/gmail.send" }),
        operation("gmail.unsubscribe", { risk: "write", setting: "ask", default: "ask", available: false, unavailableReason: "not_supported" }),
        operation("gmail.messages.trash", { risk: "destructive", setting: "ask", default: "ask" })] }],
      background: [operation("gmail.background.sync", { available: false, unavailableReason: "not_supported" })] } as any,
  };
  const server = createServer(async (req, res) => {
    try { expect((await tokens.service(req.headers.authorization!.slice(7))).service).toBe("mau-account-management"); }
    catch { res.writeHead(401).end(); return; }
    let text = ""; for await (const chunk of req) text += chunk;
    state.requests.push({ method: req.method!, url: req.url!, ...(text ? { body: JSON.parse(text) } : {}) });
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value)); };
    const path = req.url!.split("/").filter(Boolean);
    if (req.url === "/v1/connections") return json({ connections: state.entries.map(entry => ({ ...entry, account: state.accounts[entry.id] })) });
    if (path[3] === "policy" && req.method === "PUT") {
      const settings = JSON.parse(text).settings as Record<string, string>;
      if (Object.keys(settings).some(id => !id.startsWith("gmail."))) return json({ error: "policy_operation_unknown" }, 400);
      for (const group of state.policy.groups) for (const op of group.operations) if (settings[op.id]) op.setting = settings[op.id];
      return json(state.policy);
    }
    if (path[3] === "policy") return json(state.policy);
    if (path[3] === "connect") return json({ status: "authorization_required", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture", expiresAt: "2030-01-01T00:00:00.000Z" });
    json({ error: "not_found" }, 404);
  });
  server.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  cleanup.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const options = { url: `http://127.0.0.1:${(server.address() as any).port}`, issuer: "fixture", audience: "fixture-connectors", authorityKeyFile: keyFile,
    consentOrigins: ["https://accounts.google.com", "https://accounts.feishu.cn"] };
  return { options, state, directory };
}

it("proxies the owner's operation policy with ownership checks, validated input and reviewed fields only", async () => {
  const u = await upstream();
  const f = await mauFixture(cleanup, {}, undefined, { connectorAccounts: u.options });
  const policy = await f.api("/connector-accounts/alice-gmail/policy");
  expect(policy.status).toBe(200);
  expect(JSON.stringify(policy.data)).not.toMatch(/never-return-this|grantScope|googleapis/);
  expect(policy.data.groups.map((group: any) => group.labelZh)).toEqual(["读取权限", "写入和删除权限"]);
  expect(policy.data.groups[1].operations[0]).toEqual({ id: "gmail.send", label: "gmail.send", labelZh: "gmail.send", risk: "write", setting: "ask", default: "ask",
    available: false, unavailableReason: "scope_required", grantable: true });
  expect(policy.data.background).toEqual([{ ...operation("gmail.background.sync"), available: false, unavailableReason: "not_supported" }]);
  // Another owner's connection is not found, and nothing reaches the connector policy.
  u.state.requests.length = 0;
  expect((await f.api("/connector-accounts/bob-drive/policy")).status).toBe(404);
  expect((await f.api("/connector-accounts/alice-gmail/policy", { settings: { "gmail.send": "allow" } }, "bob", undefined, "PUT")).status).toBe(404);
  expect((await f.api("/connector-accounts/alice-gmail/policy/reset", {}, "bob")).status).toBe(404);
  expect((await f.api("/connector-accounts/../policy")).status).toBe(404);
  // Malformed settings are refused before any upstream call.
  for (const body of [{ settings: { "gmail.send": "always" } }, { settings: { "Gmail Send": "allow" } }, { settings: {}, owner: alice }, { settings: "allow" }])
    expect((await f.api("/connector-accounts/alice-gmail/policy", body, "alice", undefined, "PUT")).status).toBe(400);
  expect(u.state.requests.filter(r => r.url.includes("/policy"))).toEqual([]);
  const updated = await f.api("/connector-accounts/alice-gmail/policy", { settings: { "gmail.messages.trash": "deny", "gmail.send": "allow" } }, "alice", undefined, "PUT");
  expect(updated.status).toBe(200);
  expect(updated.data.groups[1].operations.map((o: any) => o.setting)).toEqual(["allow", "ask", "deny"]);
  expect(u.state.requests.at(-1)).toEqual({ method: "PUT", url: "/v1/connections/alice-gmail/policy", body: { settings: { "gmail.messages.trash": "deny", "gmail.send": "allow" } } });
  // The connector's own refusal keeps its code.
  expect(await f.api("/connector-accounts/alice-gmail/policy", { settings: { "feishu.im.read": "deny" } }, "alice", undefined, "PUT"))
    .toEqual({ status: 400, data: expect.objectContaining({ error: "policy_operation_unknown" }) });
  expect((await f.api("/connector-accounts/alice-gmail/policy/reset", { extra: true })).status).toBe(400);
  expect((await f.api("/connector-accounts/alice-gmail/policy/reset", {})).status).toBe(200);
  expect(u.state.requests.at(-1)).toMatchObject({ method: "POST", url: "/v1/connections/alice-gmail/policy/reset" });
});

it("lists the authorized account and keeps a pending consent link across reloads, from allowed origins only", async () => {
  const u = await upstream();
  const f = await mauFixture(cleanup, {}, undefined, { connectorAccounts: u.options });
  const listed = (await f.api("/connector-accounts")).data.data;
  expect(listed.find((a: any) => a.id === "alice-gmail")).toEqual({ id: "alice-gmail", kind: "google", label: "Gmail", state: "connected", verification: "oauth",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"], account: { email: "owner@example.test" } });
  expect(listed.find((a: any) => a.id === "alice-feishu")).toMatchObject({ state: "authorization_pending",
    authorizationUrl: "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD", expiresAt: "2030-01-01T00:00:00.000Z" });
  expect(listed.map((a: any) => a.id)).not.toContain("bob-drive");
  // A connected Feishu account shows the user's name; the link is never listed once connected.
  u.state.accounts["alice-feishu"] = { authorized: true, verified: true, userName: "Alice\u0007", accountName: "Alice", authorizationUrl: "https://accounts.feishu.cn/x" };
  const connected = (await f.api("/connector-accounts")).data.data.find((a: any) => a.id === "alice-feishu");
  expect(connected).toMatchObject({ state: "connected", name: "Alice", account: { name: "Alice" } });
  expect(connected.authorizationUrl).toBeUndefined();
  // A pending link outside the consent allow-list is dropped without failing the list.
  u.state.accounts["alice-feishu"] = { status: "authorization_pending", authorizationUrl: "https://evil.example/verify", expiresAt: "2030-01-01T00:00:00.000Z" };
  const foreign = await f.api("/connector-accounts");
  expect(foreign.status).toBe(200);
  expect(foreign.data.data.find((a: any) => a.id === "alice-feishu")).toEqual({ id: "alice-feishu", kind: "feishu", label: "飞书", usage: "owner_private",
    state: "authorization_pending", verification: "none", scopes: [] });
});

it("adds scopes only for grantable operations, from the connector's own mapping", async () => {
  const u = await upstream();
  const f = await mauFixture(cleanup, {}, undefined, { connectorAccounts: u.options });
  u.state.requests.length = 0;
  for (const operations of [["gmail.unsubscribe"], ["gmail.messages.read"], ["gmail.nothing"]])
    expect(await f.api("/connector-accounts/alice-gmail/connect", { operations })).toEqual({ status: 409, data: expect.objectContaining({ error: "connector_operation_not_grantable" }) });
  for (const body of [{ operations: [] }, { scopes: ["https://mail.google.com/"] }, { operations: ["gmail.send"], owner: alice }])
    expect((await f.api("/connector-accounts/alice-gmail/connect", body)).status).toBe(400);
  expect((await f.api("/connector-accounts/alice-gmail/connect", { operations: ["gmail.send"] }, "bob")).status).toBe(404);
  expect(u.state.requests.filter(r => r.url.endsWith("/connect"))).toEqual([]);
  // A connected account still starts the added consent; the request carries only the mapped scope.
  const consent = await f.api("/connector-accounts/alice-gmail/connect", { operations: ["gmail.send"] });
  expect(consent.data).toMatchObject({ state: "authorization_required", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture" });
  expect(u.state.requests.at(-1)).toEqual({ method: "POST", url: "/v1/connections/alice-gmail/connect", body: { scopes: ["https://www.googleapis.com/auth/gmail.send"] } });
  // A plain connect of a connected account still does nothing.
  u.state.requests.length = 0;
  expect((await f.api("/connector-accounts/alice-gmail/connect", {})).data.state).toBe("connected");
  expect(u.state.requests.filter(r => r.method === "POST")).toEqual([]);
});

it("keeps the connected_apps tool definition unchanged, so policy changes never rotate sessions", () => {
  // Policy changes only what action=tools lists and how calls are admitted. Changing this definition changes every
  // session's tool fingerprint (Host and Mau's frozen session catalog) and needs a planned session rotation.
  expect(createHash("sha256").update(JSON.stringify(connectedAppDefinition)).digest("hex")).toBe("c3979895b2dbf19a262fbcdde60aea9fa746d87bfb6a3376916855782f50e1c8");
});

/**
 * A connector stand-in with the service's policy semantics: deny hides and refuses, ask needs approval (refused for
 * read-only callers), allow runs; read-only callers never write. Mau's handling is what is under test.
 */
function policyConnector(settings: Record<"read" | "send", "allow" | "ask" | "deny">) {
  const tools = [{ name: "mail__read", risk: "read", op: "read" as const }, { name: "mail__send", risk: "write", op: "send" as const }];
  const executed: string[] = [], views = new Map<string, OperationView>();
  const calls: Array<{ name?: string; write: boolean }> = [];
  const reader: ConnectedAppReader = async (input, _scope, options) => {
    const readOnly = options?.write !== true;
    calls.push({ ...(input.name ? { name: input.name } : {}), write: !readOnly });
    if (input.action === "tools") return { status: "completed", tools: tools.filter(t => settings[t.op] !== "deny" && !(readOnly && (t.risk === "write" || settings[t.op] === "ask")))
      .map(t => ({ name: t.name, risk: t.risk, description: t.name, inputSchema: { type: "object" } })) };
    const tool = tools.find(t => t.name === input.name);
    if (!tool || (readOnly && tool.risk === "write")) return { status: "failed", error: "tool_not_available" };
    const setting = settings[tool.op];
    if (setting === "deny") return { status: "failed", error: "connector_operation_denied", detail: { operation: tool.op } };
    if (setting === "ask" && readOnly) return { status: "failed", error: "connector_operation_requires_approval", detail: { operation: tool.op, label: "Read mail", instruction: "x" } };
    if (setting === "ask") {
      const id = `op-${views.size + 1}`, expiresAt = new Date(Date.now() + 600_000).toISOString();
      views.set(id, { id, owner: principal.owner, agentId: principal.agentId, connectionId: "mail", tool: tool.op, digest: "a".repeat(64), status: "pending",
        summary: `${tool.op} on mail`, input: input.arguments ?? {}, createdAt: new Date().toISOString(), expiresAt });
      return { status: "approval_required", operationId: id, summary: `${tool.op} on mail`, expiresAt };
    }
    executed.push(tool.name);
    return { status: "completed", result: { ok: tool.op } };
  };
  const port: ApprovalPort = {
    operation: async id => views.get(id),
    approve: async (_owner, id) => { const view = views.get(id)!; executed.push(`mail__${view.tool}`); views.set(id, { ...view, status: "completed" });
      return { outcome: { status: "completed", result: { ok: view.tool }, operationId: id } }; },
    deny: async id => { views.set(id, { ...views.get(id)!, status: "denied" }); return {}; },
  };
  return { reader, port, executed, calls };
}
const principal = { agentId: "agent", owner: "alice" };
const admissions = {
  owner: { kind: "owner" as const, ...principal, reference: "owner-request" },
  schedule: { kind: "schedule" as const, ...principal, reference: "rule", toolGrants: { connectedApps: { connections: ["mail"] } } },
  delegation: { kind: "delegation" as const, ...principal, reference: "work", toolGrants: { connectedApps: { connections: ["mail"] } } },
};
function host(settings: Parameters<typeof policyConnector>[0], options: { ownerPrivate?: boolean } = {}) {
  const store = new DurableStore(":memory:", "fixture"); cleanup.push(() => store.close());
  let pending: any[] = [];
  const resolved = new Map<string, any>();
  const http = new class extends ServiceHttp {
    override async request(path: string, request: any = {}): Promise<any> {
      if (path === "/v1/runs") return { id: "run", sessionId: request.body.sessionId, runtimeId: "personal", status: "running", answer: "" };
      if (path.endsWith("/calls")) return { calls: pending };
      const match = /\/calls\/([^/]+)\/result$/.exec(path);
      if (match) { resolved.set(decodeURIComponent(match[1]!), request.body.result); pending = pending.map(c => c.id === decodeURIComponent(match[1]!) ? { ...c, status: "completed" } : c); return {}; }
      throw new Error("unexpected_request " + path);
    }
  }("https://host.fixture", "host-secret");
  const connector = policyConnector(settings);
  const hosting = { connections: ["mail"], browser: [], approvals: connector.port,
    ...(options.ownerPrivate ? { ownerPrivate: { connections: async () => new Set(["mail"]), admitted: async () => false } } : {}) };
  const business = new BusinessHost(http, undefined, store, "agent:binding", connector.reader, principal, undefined, undefined, hosting);
  const call = async (body: unknown, id: string) => {
    pending = [...pending, { id, runId: "run", kind: "tool", name: "connected_apps", status: "pending", input: body, deadlineAt: new Date(Date.now() + 300_000).toISOString() }];
    const listed = await business.calls("run");
    return { cards: listed.filter(c => c.kind === "interaction"), result: resolved.has(id) ? JSON.parse(resolved.get(id).contentItems[0].text) : undefined };
  };
  return { business, call, resolved, ...connector,
    start: (admission: unknown) => business.start({ sessionId: "session", runtimeId: "personal", instructions: "", input: "go", admission } as any) };
}

it("owner conversations: allowed writes run without a card, reads set to ask get one, denied operations are refused", async () => {
  const allowed = host({ read: "allow", send: "allow" }); await allowed.start(admissions.owner);
  const sent = await allowed.call({ action: "call", name: "mail__send", arguments: { to: "x" } }, "send");
  expect(sent.cards).toEqual([]);
  expect(sent.result).toMatchObject({ status: "completed", result: { ok: "send" } });
  expect(allowed.executed).toEqual(["mail__send"]);
  expect(allowed.calls.at(-1)).toEqual({ name: "mail__send", write: true });

  const asking = host({ read: "ask", send: "deny" }); await asking.start(admissions.owner);
  const tools = await asking.call({ action: "tools" }, "tools");
  expect(tools.result.tools.map((t: any) => t.name)).toEqual(["mail__read"]);
  const read = await asking.call({ action: "call", name: "mail__read", arguments: {} }, "read");
  expect(read.result).toBeUndefined();
  expect(read.cards).toHaveLength(1);
  await asking.business.resolve("run", `${APPROVAL_PREFIX}read`, { choice: "once" });
  await asking.business.settled("run"); await asking.business.calls("run");
  expect(JSON.parse(asking.resolved.get("read").contentItems[0].text)).toMatchObject({ status: "completed", result: { ok: "read" } });
  const denied = await asking.call({ action: "call", name: "mail__send", arguments: {} }, "denied");
  expect(denied.result).toMatchObject({ status: "failed", error: "connector_operation_denied" });
  expect(asking.executed).toEqual(["mail__read"]);
});

it.each(["schedule", "delegation"] as const)("%s work never writes and is told the owner cannot approve here", async kind => {
  const f = host({ read: "ask", send: "allow" }); await f.start(admissions[kind]);
  const tools = await f.call({ action: "tools" }, "tools");
  expect(tools.result.tools).toEqual([]);
  const read = await f.call({ action: "call", name: "mail__read", arguments: {} }, "read");
  expect(read.cards).toEqual([]);
  expect(read.result).toMatchObject({ status: "failed", error: "owner_approval_unavailable_here", operation: "read", label: "Read mail" });
  expect(read.result.message).toMatch(/无法向你弹出批准卡片/);
  expect(read.result.instruction).toMatch(/owner cannot approve here/);
  // An allowed write is still not available: these runs only get read-only tokens.
  const sent = await f.call({ action: "call", name: "mail__send", arguments: {} }, "send");
  expect(sent.result).toMatchObject({ status: "failed", error: "tool_not_available" });
  expect(f.calls.every(c => !c.write)).toBe(true);
  expect(f.executed).toEqual([]);
});

it("evaluates the owner-private rule before the operation policy", async () => {
  const f = host({ read: "allow", send: "allow" }, { ownerPrivate: true }); await f.start(admissions.owner);
  const read = await f.call({ action: "call", name: "mail__read", arguments: {} }, "read");
  expect(read.result).toMatchObject({ status: "failed", error: "connected_app_owner_private_only" });
  expect(f.calls.filter(c => c.name)).toEqual([]);
});

it("keeps account and policy routes unavailable without the connector service", async () => {
  const f = await mauFixture(cleanup);
  expect((await f.api("/connector-accounts/alice-gmail/policy")).status).toBe(503);
  expect((await f.api("/connector-accounts/alice-gmail/policy", undefined, "invalid")).status).toBe(401);
});
