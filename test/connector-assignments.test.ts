import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { ServiceHttp } from "@agent-router/server";
import { generateSigningKey } from "@olorinm/agent-connectors/issuer";
import { ConnectorReadClient } from "@olorinm/agent-connectors/read-client";
import { BusinessTools } from "../src/business-tools.js";
import { ConnectedApps } from "../src/connected-apps.js";
import { privateFile } from "../src/files.js";
import { DurableStore } from "../src/store.js";
import { accessAudience, accessTeam } from "./fixtures/access.js";
import { alice, bob, mauFixture } from "./fixtures/mau.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const temporary = () => { const d = mkdtempSync(join(tmpdir(), "mau-assignments-")); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; };

/** Mau with a connector service that lists two connections of alice and one of bob. */
async function product(edgeIdentity?: Record<string, unknown>) {
  const directory = temporary(), authority = await generateSigningKey("authority");
  privateFile(join(directory, "authority.json"), authority.privateJwk);
  const server = createServer((_req, res) => res.setHeader("Content-Type", "application/json").end(JSON.stringify({ connections: [
    { id: "alice-gmail", kind: "google", owner: alice, label: "Gmail", account: { status: "connected", verification: "oauth" } },
    { id: "alice-browser", kind: "browser", owner: alice, label: "Browser", account: { status: "connected" } },
    { id: "bob-gmail", kind: "google", owner: bob, label: "Gmail", account: { status: "connected" } }] })));
  server.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  cleanup.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const f = await mauFixture(cleanup, {}, { ...(edgeIdentity ? { edgeIdentity } : {}),
    connectorAccounts: { url, issuer: "fixture", audience: "fixture-connectors", authorityKeyFile: join(directory, "authority.json"), consentOrigins: ["https://accounts.example.test"] },
    connectedApps: { url, issuer: "fixture", audience: "fixture-connectors", callerKeyFile: join(directory, "authority.json") } });
  const connectors = `/agents/${f.agent.id}/connectors`;
  const put = (path: string, connections: unknown, owner = "alice") => f.api(path, { connections }, owner, undefined, "PUT");
  return { f, connectors, put };
}

it("the owner sets which connections a partner can use; unknown ones and other owners are refused", async () => {
  const { f, connectors, put } = await product();
  expect(await f.api(connectors)).toEqual({ status: 200, data: { connections: [] } });
  expect(await put(connectors, ["alice-gmail", "alice-browser", "alice-gmail"])).toEqual({ status: 200, data: { connections: ["alice-gmail", "alice-browser"] } });
  expect((await f.api(connectors)).data).toEqual({ connections: ["alice-gmail", "alice-browser"] });
  const assigned = async () => Object.fromEntries((await f.api("/connector-accounts")).data.data.map((account: any) => [account.id, account.assignedAgents ?? []]));
  expect(await assigned()).toEqual({ "alice-gmail": [f.agent.id], "alice-browser": [f.agent.id] });
  // A connection that does not exist, another owner's connection, and a body with anything else change nothing.
  for (const connections of [["alice-gmail", "missing"], ["bob-gmail"]])
    expect(await put(connectors, connections)).toEqual({ status: 400, data: { error: "connector_not_found" } });
  expect((await f.api(connectors, { connections: ["alice-gmail"], owner: bob }, "alice", undefined, "PUT")).data).toEqual({ error: "invalid_request" });
  expect((await put(connectors, "alice-gmail")).status).toBe(400);
  expect((await f.api(connectors)).data).toEqual({ connections: ["alice-gmail", "alice-browser"] });
  // Another owner's partner is not found, for reading and for writing.
  expect(await f.api(connectors, undefined, "bob")).toEqual({ status: 404, data: { error: "agent_not_found" } });
  expect(await put(connectors, [], "bob")).toEqual({ status: 404, data: { error: "agent_not_found" } });
  expect((await put(`/agents/00000000-0000-4000-8000-000000000000/connectors`, [])).status).toBe(404);
  expect((await f.api(connectors)).data).toEqual({ connections: ["alice-gmail", "alice-browser"] });
  expect(await put(connectors, ["alice-gmail"])).toEqual({ status: 200, data: { connections: ["alice-gmail"] } });
  expect(await assigned()).toEqual({ "alice-gmail": [f.agent.id], "alice-browser": [] });
  // The assignment is state: another process on the same state has it, and an empty list removes it.
  await f.restart();
  expect((await f.api(connectors)).data).toEqual({ connections: ["alice-gmail"] });
  expect(await put(connectors, [])).toEqual({ status: 200, data: { connections: [] } });
  expect(await assigned()).toEqual({ "alice-gmail": [], "alice-browser": [] });
});

it("a partner in a shared environment inherits until it has an assignment of its own, and deleting a partner removes its assignment", async () => {
  const { f, connectors, put } = await product();
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");
  await put(connectors, ["alice-gmail", "alice-browser"]);
  const scout = (await f.api("/agents", { name: "scout", shareWith: f.agent.id })).data.agent, own = `/agents/${scout.id}/connectors`;
  expect((await f.api(own)).data).toEqual({ connections: ["alice-gmail", "alice-browser"], inheritedFrom: { id: f.agent.id, name: "helper" } });
  expect((await put(own, ["alice-browser"])).data).toEqual({ connections: ["alice-browser"] });
  expect((await put(connectors, ["alice-gmail"])).data).toEqual({ connections: ["alice-gmail"] });
  expect((await f.api(own)).data).toEqual({ connections: ["alice-browser"] });
  expect((await put(own, [])).data).toEqual({ connections: ["alice-gmail"], inheritedFrom: { id: f.agent.id, name: "helper" } });
  await put(own, ["alice-browser"]);
  const stored = () => { const store = new DurableStore(join(f.directory, "business-tools.sqlite"), "example.test");
    try { return store.entries("connector_assignments").map(entry => entry.id); } finally { store.close(); } };
  expect(stored()).toEqual([f.agent.id, scout.id]);
  expect((await fetch(`${f.base}/_mau/v1/agents/${scout.id}`, { method: "DELETE", headers: { authorization: "Bearer alice" } })).status).toBe(204);
  expect(stored()).toEqual([f.agent.id]);
});

it("an operator's service token reads a partner's connections and cannot change them", async () => {
  const { f, connectors } = await product({ provider: "cloudflare-access", teamDomain: accessTeam, audiences: [accessAudience],
    owners: { "alice@example.test": alice }, serviceTokens: { "ops.access": alice, "full.access": { owner: alice, access: "owner" } } });
  const call = async (method: string, common_name: string, body?: unknown) => {
    const response = await fetch(f.base + "/_mau/v1" + connectors, { method, headers: { "content-type": "application/json", origin: f.base,
      "cf-access-jwt-assertion": f.access.jwt({ email: undefined, sub: "", common_name }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  expect(await call("GET", "ops.access")).toEqual({ status: 200, data: { connections: [] } });
  expect(await call("PUT", "ops.access", { connections: ["alice-gmail"] })).toEqual({ status: 403, data: { error: "owner_sign_in_required" } });
  expect(await call("GET", "ops.access")).toEqual({ status: 200, data: { connections: [] } });
  expect(await call("PUT", "full.access", { connections: ["alice-gmail"] })).toEqual({ status: 200, data: { connections: ["alice-gmail"] } });
});

it("a running partner's Host uses a changed assignment at once; the tool itself joins a conversation at its first turn", async () => {
  const directory = temporary(), key = await generateSigningKey("caller"), store = new DurableStore(":memory:", "fixture");
  cleanup.push(() => store.close());
  privateFile(join(directory, "caller.json"), key.privateJwk);
  const apps = new ConnectedApps({ url: "http://127.0.0.1:18100", issuer: "mau", audience: "connectors", callerKeyFile: "caller.json" }, directory, store);
  const list = vi.spyOn(ConnectorReadClient.prototype, "tools").mockResolvedValue([{ name: "alice_gmail__list", description: "List", inputSchema: { type: "object" } }]);
  let pending: unknown[] = []; const started: any[] = [], resolved: any[] = [];
  const http = new class extends ServiceHttp {
    override async request(path: string, options: any = {}): Promise<any> {
      if (path === "/v1/health") return { protocolVersion: 1 };
      if (path === "/v1/runs") { started.push(options.body); return { id: `run-${started.length}`, sessionId: options.body.sessionId, runtimeId: "personal", status: "running", answer: "" }; }
      if (path.endsWith("/calls")) return { calls: pending };
      if (path.endsWith("/result")) { resolved.push(JSON.parse(options.body.result.contentItems[0].text)); return {}; }
      throw new Error("unexpected_request");
    }
  }("https://host.fixture", "host-secret");
  // One Host for the partner, as Router keeps it for as long as the partner's runtime is open.
  const host = new BusinessTools([], directory, store, apps).host("agent", "alice", "binding", http);
  const start = (sessionId: string) => host.start({ runtimeId: "personal", sessionId, input: "hello", instructions: "", admission: { kind: "owner", owner: "alice", agentId: "agent", reference: sessionId } } as any);
  const tools = () => (started.at(-1).tools ?? []).map((tool: any) => tool.name);
  const ask = async (runId: string, id: string) => { pending = [{ id, runId, kind: "tool", name: "connected_apps", input: { action: "tools" }, status: "pending", deadlineAt: new Date(Date.now() + 60_000).toISOString() }]; await host.calls(runId); pending = []; return resolved.at(-1); };
  await start("before");
  expect(tools()).toEqual([]);
  apps.assign("alice", "agent", ["alice-gmail"]);
  // The conversation that began without the tool keeps its catalog; a new one has the tool.
  await start("before");
  expect(tools()).toEqual([]);
  await start("after");
  expect(tools()).toEqual(["connected_apps"]);
  expect(await ask("run-3", "call-1")).toMatchObject({ status: "completed", tools: [{ name: "alice_gmail__list" }] });
  expect(list).toHaveBeenLastCalledWith({ agentId: "agent", owner: "alice", connections: ["alice-gmail"] });
  // Removing the assignment takes effect on the next call of the same conversation.
  apps.assign("alice", "agent", []);
  expect(await ask("run-3", "call-2")).toMatchObject({ error: "connected_app_not_granted" });
  expect(list).toHaveBeenCalledOnce();
});
