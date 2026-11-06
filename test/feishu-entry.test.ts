import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { generateSigningKey } from "@olorinm/agent-connectors/issuer";
import { TokenVerifier } from "@olorinm/agent-connectors";
import { ConnectorAccounts } from "../src/connector-accounts.js";
import { ConnectedApps } from "../src/connected-apps.js";
import { chatChannelApplication } from "../src/feishu-entry.js";
import { OwnerPrivateConnections, ownerPrivateAdmission, type RouterConversations } from "../src/owner-private.js";
import { privateFile } from "../src/files.js";
import { mauFixture, alice, bob } from "./fixtures/mau.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const temporary = () => { const d = mkdtempSync(join(tmpdir(), "mau-feishu-")); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; };

/** Agent Connectors account API for one owner's Feishu connection, with the device flow and hand-over routes. */
async function upstream() {
  const directory = temporary();
  const authority = await generateSigningKey("authority"), caller = await generateSigningKey("caller");
  const keyFile = join(directory, "authority.json"); privateFile(keyFile, authority.privateJwk);
  const tokens = new TokenVerifier({ issuer: "fixture", audience: "fixture-connectors", callerKeys: { keys: [caller.publicJwk] }, authorityKeys: { keys: [authority.publicJwk] } });
  const consent = "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=FIXTURE";
  const state = { account: { status: "feishu_configuration_required", reason: "application_not_provided" } as Record<string, unknown>,
    posts: [] as Array<{ path: string; body: string }>, confirmed: false };
  const server = createServer(async (req, res) => {
    try { await tokens.service(req.headers.authorization!.slice(7)); } catch { res.writeHead(401).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST") {
      state.posts.push({ path: req.url!, body });
      if (req.url!.endsWith("/application")) state.account = { status: "authorization_required", applicationChanged: true };
      if (req.url!.endsWith("/connect")) state.account = { status: "authorization_required", authorizationUrl: consent, expiresAt: new Date(Date.now() + 600_000).toISOString() };
      if (req.url!.endsWith("/complete")) state.account = state.confirmed ? { status: "connected", authorized: true, verified: true, userName: "Alice", scope: ["mail:read"] }
        : { status: "authorization_pending", authorizationUrl: consent, expiresAt: new Date(Date.now() + 600_000).toISOString() };
      res.end(JSON.stringify(state.account)); return;
    }
    res.end(JSON.stringify({ connections: [
      { id: "alice-feishu", kind: "feishu", owner: alice, label: "飞书", usage: "owner_private", account: state.account },
      { id: "alice-gmail", kind: "google", owner: alice, label: "Gmail", account: { status: "connected", verification: "oauth" } },
      { id: "bob-feishu", kind: "feishu", owner: bob, label: "飞书", usage: "owner_private", account: { status: "connected" } },
    ] }));
  });
  server.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  cleanup.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const options = { url: `http://127.0.0.1:${(server.address() as any).port}`, issuer: "fixture", audience: "fixture-connectors",
    authorityKeyFile: keyFile, consentOrigins: ["https://accounts.feishu.cn"] };
  return { options, state, consent, directory, keyFile, client: new ConnectorAccounts(options, directory) };
}
/** Router's saved bot application for an Agent's Feishu chat channel. */
function routerApplication(directory: string) {
  privateFile(join(directory, "feishu", "app-secret"), "bot-secret\n");
  privateFile(join(directory, "feishu", "credentials.json"), { version: 1, appId: "cli_bot", appSecretFile: "app-secret", domain: "feishu", ownerOpenId: "ou_owner" });
  return [{ kind: "feishu", credentialsFile: "feishu/credentials.json" }];
}

it("reads the chat channel's app for hand-over and refuses missing or unsafe bindings", () => {
  const directory = temporary();
  expect(() => chatChannelApplication([], directory)).toThrow("feishu_chat_not_connected");
  expect(() => chatChannelApplication([{ kind: "feishu" }], directory)).toThrow("feishu_chat_owner_binding_required");
  expect(chatChannelApplication(routerApplication(directory), directory)).toEqual({ appId: "cli_bot", appSecret: "bot-secret", domain: "feishu", ownerOpenId: "ou_owner" });
  privateFile(join(directory, "feishu", "credentials.json"), { version: 1, appId: "cli_bot", appSecretFile: "../../outside", domain: "feishu", ownerOpenId: "ou_owner" });
  expect(() => chatChannelApplication([{ kind: "feishu", credentialsFile: "feishu/credentials.json" }], directory)).toThrow("feishu_chat_credentials_unavailable");
});

it("reports expiry with its reason, owner-private usage, and finishes the device flow with the consent link", async () => {
  const u = await upstream();
  u.state.account = { status: "expired", reason: "refresh_token_expired", access_token: "never-return-this" };
  const listed = await u.client.list(alice);
  expect(listed.data).toEqual([
    { id: "alice-feishu", kind: "feishu", label: "飞书", usage: "owner_private", state: "expired", reason: "refresh_token_expired", verification: "none", scopes: [] },
    { id: "alice-gmail", kind: "google", label: "Gmail", state: "connected", verification: "oauth", scopes: [] }]);
  expect(JSON.stringify(listed)).not.toContain("never-return-this");
  expect((await u.client.action(alice, "alice-feishu", "connect")).authorizationUrl).toBe(u.consent);
  const waiting = await u.client.action(alice, "alice-feishu", "complete");
  expect(waiting).toMatchObject({ state: "authorization_pending", authorizationUrl: u.consent });
  u.state.confirmed = true;
  expect(await u.client.action(alice, "alice-feishu", "complete")).toEqual({ state: "connected", verification: "provider", scopes: ["mail:read"], name: "Alice" });
  await expect(u.client.action(alice, "alice-gmail", "complete")).rejects.toThrow("connector_action_not_supported");
  await expect(u.client.action(bob, "alice-feishu", "complete")).rejects.toThrow("connector_account_not_found");
});

async function product() {
  const u = await upstream();
  const f = await mauFixture(cleanup, {}, undefined, { connectorAccounts: u.options, connectedApps: { url: u.options.url, issuer: "fixture",
    audience: "fixture-connectors", callerKeyFile: u.keyFile, assignments: [] } });
  return { u, f, channels: routerApplication(f.mau.router.connections.agentDirectory(f.agent.id)) };
}

it("refuses the hand-over for an unassigned Agent, another owner's Agent and a missing chat channel", async () => {
  const { u, f, channels } = await product();
  const configuration = vi.spyOn(f.mau.router.connections, "configuration").mockReturnValue({ connections: channels } as any);
  expect((await f.api("/connector-accounts/alice-feishu/feishu-application", { agentId: f.agent.id })).data.error).toBe("connector_not_assigned_to_agent");
  vi.spyOn(ConnectedApps.prototype, "assigned").mockImplementation((owner, id) => owner === alice && id === "alice-feishu" ? [f.agent.id] : []);
  expect((await f.api("/connector-accounts/alice-feishu/feishu-application", { agentId: f.agent.id }, "bob")).status).toBe(404);
  expect((await f.api("/connector-accounts/alice-feishu/feishu-application", { agentId: f.agent.id, appSecret: "x" })).status).toBe(400);
  configuration.mockReturnValue({ connections: [] } as any);
  expect((await f.api("/connector-accounts/alice-feishu/feishu-application", { agentId: f.agent.id })).data.error).toBe("feishu_chat_not_connected");
  expect(u.state.posts).toEqual([]);
});

it("hands the chat bot's app over without a second QR, then authorizes the owner; the secret never returns", async () => {
  const { u, f, channels } = await product();
  vi.spyOn(f.mau.router.connections, "configuration").mockReturnValue({ connections: channels } as any);
  vi.spyOn(ConnectedApps.prototype, "assigned").mockImplementation((owner, id) => owner === alice && id === "alice-feishu" ? [f.agent.id] : []);
  const before = await f.api("/connector-accounts");
  expect(before.data.data[0]).toMatchObject({ id: "alice-feishu", usage: "owner_private", state: "needs_setup", reason: "application_not_provided", assignedAgents: [f.agent.id] });
  const handed = await f.api("/connector-accounts/alice-feishu/feishu-application", { agentId: f.agent.id });
  expect(handed.data).toEqual({ state: "authorization_required", verification: "none", scopes: [] });
  expect(u.state.posts.map(p => p.path)).toEqual(["/v1/connections/alice-feishu/application"]);
  expect(JSON.parse(u.state.posts[0]!.body)).toEqual({ appId: "cli_bot", appSecret: "bot-secret", domain: "feishu", ownerOpenId: "ou_owner" });
  const begun = await f.api("/connector-accounts/alice-feishu/connect", {});
  expect(begun.data.authorizationUrl).toBe(u.consent);
  expect((await f.api("/connector-accounts/alice-feishu/complete", {})).data.state).toBe("authorization_pending");
  u.state.confirmed = true;
  expect((await f.api("/connector-accounts/alice-feishu/complete", {})).data).toMatchObject({ state: "connected", name: "Alice" });
  for (const response of [before, handed, begun]) expect(JSON.stringify(response)).not.toContain("bot-secret");
});

const owner = { kind: "owner" as const, owner: alice, agentId: "agent", reference: "task-dm" };
function conversations(inputs: Record<string, { scope: string; owner: boolean }>, events: Record<string, string[]> = {}): RouterConversations {
  return {
    communication: { input: id => inputs[id] ? { source: { scope: inputs[id]!.scope }, conversationId: id } : undefined,
      isOwnerInput: input => input.source.scope === "direct" && inputs[input.conversationId]!.owner },
    sessions: { lookup: id => events[id] ? { sessionId: id } : null, getSession: id => ({ runs: (events[id] ?? []).map(taskId => ({ taskId })) }) },
  };
}
it("admits owner-identity connections only in the owner's private conversation", async () => {
  const router = conversations({ "task-dm": { scope: "direct", owner: true }, "task-group": { scope: "group", owner: true },
    "task-visitor": { scope: "direct", owner: false } }, { "event-private": ["task-dm", "api-task"], "event-shared": ["task-dm", "task-group"] });
  expect(await ownerPrivateAdmission(owner, router)).toBe(true);
  expect(await ownerPrivateAdmission({ ...owner, reference: "task-group" }, router)).toBe(false); // includes Router's private groups
  expect(await ownerPrivateAdmission({ ...owner, reference: "task-visitor" }, router)).toBe(false);
  expect(await ownerPrivateAdmission({ ...owner, reference: "event-private" }, router)).toBe(true); // owner-authenticated work event
  expect(await ownerPrivateAdmission({ ...owner, reference: "event-shared" }, router)).toBe(false); // in a session shared with a group
  expect(await ownerPrivateAdmission({ ...owner, reference: "unknown" }, router)).toBe(false);
  expect(await ownerPrivateAdmission({ ...owner, kind: "delegation", toolGrants: {} }, router)).toBe(false);
  expect(await ownerPrivateAdmission({ ...owner, kind: "schedule", toolGrants: {} }, router)).toBe(true); // owner-created, read-only, owner-conversation targets
  expect(await ownerPrivateAdmission(owner, undefined)).toBe(false);
});
it("learns owner-private connections from the service, caches them and fails closed", async () => {
  let calls = 0, fail = false;
  const ids = new OwnerPrivateConnections(["configured"], async () => { calls++; if (fail) throw new Error("down"); return [{ id: "alice-feishu", usage: "owner_private" }, { id: "alice-gmail" }]; }, 0);
  expect([...(await ids.ids())!].sort()).toEqual(["alice-feishu", "configured"]);
  fail = true;
  expect(await ids.ids()).toBeUndefined();
  expect(calls).toBe(2);
  expect([...(await new OwnerPrivateConnections(["x"]).ids())!]).toEqual(["x"]);
});
