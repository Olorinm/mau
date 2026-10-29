import { afterEach, expect, it, vi } from "vitest";
import { ServiceHttp } from "@agent-router/server";
import { BusinessHost, BusinessTools } from "../src/business-tools.js";
import { DurableStore } from "../src/store.js";
import { randomUUID } from "node:crypto";
const stores: DurableStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); vi.restoreAllMocks(); });
function fixture() {
  const store = new DurableStore(":memory:", "fixture"); stores.push(store);
  let submitted: any, pending: any[] = [], resolved: any[] = [];
  const http = new class extends ServiceHttp {
    override async request(path: string, options: any = {}): Promise<any> {
      if (path === "/v1/runs") { submitted = options.body; return { id: "run", sessionId: "session", runtimeId: "personal", status: "running", answer: "" }; }
      if (path.endsWith("/calls")) return { calls: pending };
      if (path.endsWith("/result")) { resolved.push(options.body.result); return {}; }
      throw new Error("unexpected_request");
    }
  }("https://host.fixture", "host-secret");
  const call = vi.fn(async () => ({ isError: false, content: [{ type: "text", text: "catalog-result" }] }));
  const host = new BusinessHost(http, { call }, store, "agent:binding");
  return { host, http, store, call, submitted: () => submitted, resolved, setCalls: (name = "business_data", tool = "catalog", body?: unknown) => pending = [
    { id: "business-call", runId: "run", name, kind: "tool", status: "pending", input: body ?? { tool, arguments: {} }, deadlineAt: new Date(Date.now() + 60_000).toISOString() },
    { id: "channel-call", runId: "run", name: "channel", kind: "tool", status: "pending", input: {}, deadlineAt: new Date(Date.now() + 60_000).toISOString() },
  ] };
}
const input = { sessionId: "session", runtimeId: "personal", instructions: "", input: "test" };
const tools = [{ name: "channel", description: "", inputSchema: {}, timeoutMs: 1000 }];
it("injects the reviewed tool only into channel runs and resolves it outside the sandbox", async () => {
  const f = fixture(); await f.host.start({ ...input, tools }); f.setCalls();
  expect(f.submitted().tools.map((t: any) => t.name)).toEqual(["channel", "business_data"]);
  const [a, b] = await Promise.all([f.host.calls("run"), f.host.calls("run")]);
  expect(a.map(c => c.name)).toEqual(["channel"]); expect(b).toEqual(a);
  expect(f.call).toHaveBeenCalledTimes(1); expect(f.call).toHaveBeenCalledWith("catalog", {});
  expect(f.resolved[0].success).toBe(true);
  expect(JSON.stringify(f.submitted())).not.toContain("host-secret");
});

it("serves connected apps through the native Host protocol only for admitted runs and preserves channel handling", async () => {
  const f = fixture(), read = vi.fn(async () => ({ status: "completed", tools: [{ name: "gmail__list" }] }));
  const host = new BusinessHost(f.http, undefined, f.store, "apps:binding", read);
  await host.start({ ...input, tools });
  expect(f.submitted().tools.map((tool: any) => tool.name)).toEqual(["channel", "connected_apps"]);
  f.setCalls("connected_apps", "", { action: "tools" });
  const result = await host.calls("run");
  expect(result.map(c => c.name)).toEqual(["channel"]);
  expect(read).toHaveBeenCalledWith({ action: "tools" });
  expect(f.resolved.at(-1).success).toBe(true);
  read.mockClear();
  const unassigned = new BusinessHost(f.http, undefined, f.store, "apps:binding");
  await unassigned.calls("run");
  expect(read).not.toHaveBeenCalled(); expect(f.resolved.at(-1).success).toBe(false);
  await host.start(input); await host.calls("run");
  expect(read).not.toHaveBeenCalled();
});

it("rejects malformed connected-app arguments and marks provider failures as failed native tool results", async () => {
  const f = fixture(), read = vi.fn(async () => ({ status: "failed", error: "authorization_required" }));
  const host = new BusinessHost(f.http, undefined, f.store, "apps:binding", read);
  await host.start({ ...input, tools });
  f.setCalls("connected_apps", "", { action: "call", name: "gmail__list", arguments: {} });
  await host.calls("run"); expect(f.resolved.at(-1).success).toBe(false);
  read.mockClear(); f.setCalls("connected_apps", "", { action: "call", name: "gmail__list", owner: "someone-else" });
  await host.calls("run"); expect(read).not.toHaveBeenCalled();
});
it("refuses tool calls from an ungranted run or a different environment binding", async () => {
  const f = fixture(); await f.host.start(input); f.setCalls(); await f.host.calls("run");
  expect(f.submitted().tools).toBeUndefined(); expect(f.call).not.toHaveBeenCalled();
  expect(JSON.stringify(f.resolved)).toContain("business_tool_not_authorized");
  await f.host.start({ ...input, tools });
  const other = new BusinessHost(f.http, {call:f.call}, f.store, "agent:other-binding");
  await other.calls("run"); expect(f.call).not.toHaveBeenCalled();
});
it("agent and owner configuration must both match before tools are attached", async () => {
  const f=fixture(), id=randomUUID();
  const manager=new BusinessTools([{agentId:id,owner:"alice",endpoint:"https://business.fixture/mcp",tokenFile:"private-key"}], ".", f.store);
  await manager.host(id,"bob","binding",f.http).start({...input,tools});
  expect(f.submitted().tools).toEqual(tools);
  await manager.host(randomUUID(),"alice","binding",f.http).start({...input,tools});
  expect(f.submitted().tools).toEqual(tools);
});

it("refuses arbitrary SQL before calling a connector even for an authorized run", async () => {
  const f=fixture(); await f.host.start({...input,tools}); f.setCalls("business_data","sql");
  await f.host.calls("run"); expect(f.call).not.toHaveBeenCalled();
  expect(JSON.stringify(f.resolved)).toContain("invalid_business_arguments");
});
it("Cloudflare tools stay bound to the configured agent and owner", async () => {
  const f=fixture(), id=randomUUID();
  const manager=new BusinessTools([{mode:"cloudflare",agentId:id,owner:"alice",endpoint:"https://connectors.fixture/",tokenFile:"caller-token"}],".",f.store);
  await manager.host(id,"alice","binding",f.http).start({...input,tools});
  expect(f.submitted().tools.map((t:any)=>t.name)).toEqual(["channel","business_data","feishu_bot_read"]);
  expect(JSON.stringify(f.submitted())).not.toContain("caller-token");
  await manager.host(id,"mallory","binding",f.http).start({...input,tools});
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
