import { afterEach, expect, it, vi } from "vitest";
import { ServiceHttp } from "@agent-router/server";
import { BusinessHost, BusinessTools } from "../src/business-tools.js";
import { DurableStore } from "../src/store.js";
import { randomUUID } from "node:crypto";
const stores: DurableStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); vi.restoreAllMocks(); });
function fixture() {
  const store = new DurableStore(":memory:", "fixture"); stores.push(store);
  let submitted: any, pending: any[] = [], resolved: any[] = [], loseStart = false;
  const byRequest = new Map<string, { body: string; run: any }>();
  const http = new class extends ServiceHttp {
    override async request(path: string, options: any = {}): Promise<any> {
      if (path === "/v1/health") return { protocolVersion: 1, capabilities: { runIdempotency: true } };
      if (path === "/v1/native-sessions") return { thread: { id: "native-child" } };
      if (path === "/v1/runs") {
        submitted = options.body;
        const key = submitted.requestKey ? JSON.stringify([submitted.runtimeId, submitted.requestKey]) : undefined;
        const body = JSON.stringify(submitted), prior = key ? byRequest.get(key) : undefined;
        if (prior) { if (prior.body !== body) throw new Error("run_request_conflict"); return prior.run; }
        const run = { id: submitted.sessionId === "session" ? "run" : "child-run", sessionId: submitted.sessionId, runtimeId: "personal", status: "running", answer: "" };
        if (key) byRequest.set(key, { body, run });
        if (loseStart) { loseStart = false; throw new Error("response_lost"); }
        return run;
      }
      if (path.startsWith("/v1/runs/by-request")) {
        const query = new URL(path, "https://host.fixture").searchParams;
        return { run: byRequest.get(JSON.stringify([query.get("runtimeId"), query.get("requestKey")]))?.run ?? null };
      }
      if (path.endsWith("/calls")) return { calls: pending };
      if (path.endsWith("/result")) { resolved.push(options.body.result); return {}; }
      throw new Error("unexpected_request");
    }
  }("https://host.fixture", "host-secret");
  const call = vi.fn(async () => ({ isError: false, content: [{ type: "text", text: "catalog-result" }] }));
  const host = new BusinessHost(http, { call }, store, "agent:binding", undefined, principal);
  return { host, http, store, call, submitted: () => submitted, resolved, lose: () => { loseStart = true; }, setCalls: (name = "business_data", tool = "catalog", body?: unknown, callId = "business-call", runId = "run", namespace?: string) => pending = [
    { id: callId, runId, name, ...(namespace ? { namespace } : {}), kind: "tool", status: "pending", input: body ?? { tool, arguments: {} }, deadlineAt: new Date(Date.now() + 60_000).toISOString() },
    { id: "channel-call", runId: "run", name: "channel", kind: "tool", status: "pending", input: {}, deadlineAt: new Date(Date.now() + 60_000).toISOString() },
  ] };
}
const input = { sessionId: "session", runtimeId: "personal", instructions: "", input: "test" };
const principal = { agentId: "agent", owner: "alice" };
const admission = { kind: "owner" as const, ...principal, reference: "owner-request" };
const tools = [{ name: "channel", description: "", inputSchema: {}, timeoutMs: 1000 }];
it("injects the reviewed tool only with trusted owner admission and resolves it outside the sandbox", async () => {
  const f = fixture(); await f.host.start({ ...input, tools, admission }); f.setCalls();
  expect(f.submitted().tools.map((t: any) => t.name)).toEqual(["channel", "business_data"]);
  const [a, b] = await Promise.all([f.host.calls("run"), f.host.calls("run")]);
  expect(a.map(c => c.name)).toEqual(["channel"]); expect(b).toEqual(a);
  expect(f.call).toHaveBeenCalledTimes(1); expect(f.call).toHaveBeenCalledWith("catalog", {});
  expect(f.resolved[0].success).toBe(true);
  expect(JSON.stringify(f.submitted())).not.toContain("host-secret");
  expect(f.submitted().admission).toBeUndefined();
});

it("serves connected apps through the native Host protocol only for admitted runs and preserves channel handling", async () => {
  const f = fixture(), read = vi.fn(async () => ({ status: "completed", tools: [{ name: "gmail__list" }] }));
  const host = new BusinessHost(f.http, undefined, f.store, "apps:binding", read, principal);
  await host.start({ ...input, tools, admission });
  expect(f.submitted().tools.map((tool: any) => tool.name)).toEqual(["channel", "connected_apps"]);
  f.setCalls("connected_apps", "", { action: "tools" });
  const result = await host.calls("run");
  expect(result.map(c => c.name)).toEqual(["channel"]);
  expect(read).toHaveBeenCalledWith({ action: "tools" });
  expect(f.resolved.at(-1).success).toBe(true);
  read.mockClear();
  const unassigned = new BusinessHost(f.http, undefined, f.store, "apps:binding", undefined, principal);
  await unassigned.calls("run");
  expect(read).not.toHaveBeenCalled(); expect(f.resolved.at(-1).success).toBe(false);
  await expect(host.start(input)).rejects.toThrow("business_run_grant_conflict"); await host.calls("run");
  expect(read).not.toHaveBeenCalled();
});

it("rejects malformed connected-app arguments and marks provider failures as failed native tool results", async () => {
  const f = fixture(), read = vi.fn(async () => ({ status: "failed", error: "authorization_required" }));
  const host = new BusinessHost(f.http, undefined, f.store, "apps:binding", read, principal);
  await host.start({ ...input, tools, admission });
  f.setCalls("connected_apps", "", { action: "call", name: "gmail__list", arguments: {} });
  await host.calls("run"); expect(f.resolved.at(-1).success).toBe(false);
  read.mockClear(); f.setCalls("connected_apps", "", { action: "call", name: "gmail__list", owner: "someone-else" });
  await host.calls("run"); expect(read).not.toHaveBeenCalled();
});
it("refuses tool calls from an ungranted run or a different environment binding", async () => {
  const f = fixture(); await f.host.start(input); f.setCalls(); await f.host.calls("run");
  expect(f.submitted().tools).toBeUndefined(); expect(f.call).not.toHaveBeenCalled();
  expect(JSON.stringify(f.resolved)).toContain("business_tool_not_authorized");
  const other = new BusinessHost(f.http, {call:f.call}, f.store, "agent:other-binding", undefined, principal);
  await other.calls("run"); expect(f.call).not.toHaveBeenCalled();
});
it("agent and owner configuration must both match before tools are attached", async () => {
  const f=fixture(), id=randomUUID();
  const manager=new BusinessTools([{agentId:id,owner:"alice",endpoint:"https://business.fixture/mcp",tokenFile:"private-key"}], ".", f.store);
  await manager.host(id,"bob","binding",f.http).start({...input,tools,admission:{...admission,agentId:id}});
  expect(f.submitted().tools).toEqual(tools);
  await manager.host(randomUUID(),"alice","binding",f.http).start({...input,tools,admission:{...admission,agentId:id}});
  expect(f.submitted().tools).toEqual(tools);
});

it("refuses arbitrary SQL before calling a connector even for an authorized run", async () => {
  const f=fixture(); await f.host.start({...input,tools,admission}); f.setCalls("business_data","sql");
  await f.host.calls("run"); expect(f.call).not.toHaveBeenCalled();
  expect(JSON.stringify(f.resolved)).toContain("invalid_business_arguments");
});
it("Cloudflare tools stay bound to the configured agent and owner", async () => {
  const f=fixture(), id=randomUUID();
  const manager=new BusinessTools([{mode:"cloudflare",agentId:id,owner:"alice",endpoint:"https://connectors.fixture/",tokenFile:"caller-token"}],".",f.store);
  await manager.host(id,"alice","binding",f.http).start({...input,tools,admission:{...admission,agentId:id}});
  expect(f.submitted().tools.map((t:any)=>t.name)).toEqual(["channel","business_data","feishu_bot_read"]);
  expect(JSON.stringify(f.submitted())).not.toContain("caller-token");
  await manager.host(id,"mallory","binding",f.http).start({...input,tools,admission:{...admission,agentId:id}});
  expect(f.submitted().tools).toEqual(tools);
});

it("shows only the owner's connector capabilities and verifies successful catalog reads without returning private configuration", async () => {
  const { CloudflareReadClient } = await import("@olorinm/agent-connectors/cloudflare-read-client");
  const call = vi.spyOn(CloudflareReadClient.prototype, "call").mockResolvedValue({isError: false, content: []});
  const f = fixture(), id = randomUUID();
  const manager = new BusinessTools([{mode:"cloudflare",agentId:id,owner:"alice",endpoint:"https://connectors.fixture/",tokenFile:"private-caller-key"}],".",f.store);
  expect(manager.inventory("bob")).toEqual([]);
  const catalog = manager.inventory("alice");
  expect(catalog).toMatchObject([{agentId:id, permission:"read-only", feishuBotRead: true}]);
  expect(catalog[0]!.tools).not.toContain("sql");
  expect(JSON.stringify(catalog)).not.toMatch(/private-caller-key|https:/);
  await expect(manager.check("bob", id)).rejects.toThrow("business_tool_not_authorized");
  await expect(manager.check("alice", randomUUID())).rejects.toThrow("business_tool_not_authorized");
  expect(call).not.toHaveBeenCalled();
  await expect(manager.check("alice", id)).resolves.toMatchObject({status:"verified"});
  expect(call).toHaveBeenCalledWith("tools", {});
  call.mockResolvedValueOnce({isError:true,content:[]});
  await expect(manager.check("alice", id)).rejects.toThrow("connector_check_failed");
});

it("a channel tool name grants nothing; an explicitly admitted independent task needs no channel tool", async () => {
  const denied = fixture(); await denied.host.start({ ...input, tools }); denied.setCalls(); await denied.host.calls("run");
  expect(denied.submitted().tools).toEqual(tools); expect(denied.call).not.toHaveBeenCalled();
  const allowed = fixture(); await allowed.host.start({ ...input, admission }); allowed.setCalls(); await allowed.host.calls("run");
  expect(allowed.submitted().tools.map((t: any) => t.name)).toEqual(["business_data"]); expect(allowed.call).toHaveBeenCalledTimes(1);
});

it("rechecks revocation and call budget, persists deduplication, and refuses changed native call payloads", async () => {
  const f = fixture(); let active = true;
  const principalNow = { ...principal, validate: () => active };
  const host = new BusinessHost(f.http, { call: f.call }, f.store, "scheduled:binding", undefined, principalNow);
  const scheduled = { ...admission, kind: "schedule" as const, toolGrants: { business: true }, maxToolCalls: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await host.start({ ...input, admission: scheduled }); f.setCalls(); await host.calls("run");
  const restarted = new BusinessHost(f.http, { call: f.call }, f.store, "scheduled:binding", undefined, principalNow);
  await restarted.calls("run"); expect(f.call).toHaveBeenCalledTimes(1);
  f.setCalls("business_data", "rows"); await restarted.calls("run");
  expect(JSON.stringify(f.resolved.at(-1))).toContain("business_call_changed");
  f.setCalls("business_data", "catalog", undefined, "second-call"); await restarted.calls("run");
  expect(JSON.stringify(f.resolved.at(-1))).toContain("business_tool_budget_exhausted");
  active = false; f.setCalls(); await restarted.calls("run");
  expect(JSON.stringify(f.resolved.at(-1))).toContain("business_tool_not_authorized"); expect(f.call).toHaveBeenCalledTimes(1);
});

it("recovers the trusted run grant after a lost start response and freezes request context for idempotent retries", async () => {
  const f = fixture(); await f.host.connect(); f.lose();
  await expect(f.host.start({ ...input, admission, requestKey: "request" })).rejects.toThrow("response_lost");
  expect(f.submitted().requestKey).toBe("request");
  const restarted = new BusinessHost(f.http, { call: f.call }, f.store, "agent:binding", undefined, principal);
  await restarted.connect();
  expect((await restarted.findRun("personal", "request"))?.id).toBe("run");
  f.setCalls(); await restarted.calls("run"); expect(f.call).toHaveBeenCalledTimes(1);
  let contextVersion = 1;
  const contextHost = new BusinessHost(f.http, undefined, f.store, "context:binding", undefined, principal,
    { definitions: [], context: () => ({ version: contextVersion++ }), execute: async () => ({}) });
  await contextHost.connect();
  await contextHost.start({ ...input, admission, requestKey: "fixed" }); const first = f.submitted();
  expect(first.requestKey).toBe("fixed");
  await contextHost.start({ ...input, admission, requestKey: "fixed" }); expect(f.submitted()).toEqual(first);
  await expect(contextHost.start({ ...input, input: "changed", admission, requestKey: "fixed" })).rejects.toThrow("business_run_request_conflict");
  await expect(contextHost.start({ ...input, admission: { ...admission, expiresAt: "2020-01-01T00:00:00Z" } })).rejects.toThrow("business_run_admission_invalid");
});

it("inherits a forked native tool catalog without inheriting the parent's wider call grants", async () => {
  const f = fixture();
  await f.host.start({ ...input, admission, tools });
  const original = f.submitted().tools;
  await f.host.nativeSessions({ runtimeId: "personal", action: "fork", sessionId: "session", targetSessionId: "child" });
  await f.host.start({ ...input, sessionId: "child", tools, admission: { ...admission, kind: "delegation", reference: "delegation", toolGrants: {} } });
  expect(f.submitted().tools).toEqual(original);
  f.setCalls("business_data", "catalog", undefined, "child-call", "child-run"); await f.host.calls("child-run");
  expect(f.call).not.toHaveBeenCalled(); expect(JSON.stringify(f.resolved.at(-1))).toContain("business_tool_not_authorized");
});

it("preserves foreign namespaces with the same tool name for their original callback owner", async () => {
  const f = fixture(); await f.host.start({ ...input, admission });
  f.setCalls("business_data", "catalog", undefined, "other-call", "run", "other_plugin");
  expect((await f.host.calls("run")).map(call => call.name)).toEqual(["business_data", "channel"]);
  expect(f.call).not.toHaveBeenCalled(); expect(f.resolved).toHaveLength(0);
  f.setCalls(); await f.host.calls("run"); expect(f.call).toHaveBeenCalledTimes(1);
});
