import { afterEach, expect, it, vi } from "vitest";
import { ServiceHttp } from "@agent-router/server";
import { BusinessHost, BusinessTools, type PartnerTools } from "../src/business-tools.js";
import { DurableStore } from "../src/store.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const call = vi.fn(async (_args: string[]) => ({ isError: false, content: [{ type: "text", text: "read-result" }] }));
  const host = new BusinessHost(http, { read: call }, store, "agent:binding", undefined, principal);
  return { host, http, store, call, submitted: () => submitted, resolved, lose: () => { loseStart = true; }, setCalls: (name = "feishu_bot_read", command = "--help", body?: unknown, callId = "bot-call", runId = "run", namespace?: string) => pending = [
    { id: callId, runId, name, ...(namespace ? { namespace } : {}), kind: "tool", status: "pending", input: body ?? { args: [command] }, deadlineAt: new Date(Date.now() + 60_000).toISOString() },
    { id: "channel-call", runId: "run", name: "channel", kind: "tool", status: "pending", input: {}, deadlineAt: new Date(Date.now() + 60_000).toISOString() },
  ] };
}
const input = { sessionId: "session", runtimeId: "personal", instructions: "", input: "test" };
const principal = { agentId: "agent", owner: "alice" };
const admission = { kind: "owner" as const, ...principal, reference: "owner-request" };
const tools = [{ name: "channel", description: "", inputSchema: {}, timeoutMs: 1000 }];
it("injects the reviewed tool only with trusted owner admission and resolves it outside the sandbox", async () => {
  const f = fixture(); await f.host.start({ ...input, tools, admission }); f.setCalls();
  expect(f.submitted().tools.map((t: any) => t.name)).toEqual(["channel", "feishu_bot_read"]);
  const [a, b] = await Promise.all([f.host.calls("run"), f.host.calls("run")]);
  expect(a.map(c => c.name)).toEqual(["channel"]); expect(b).toEqual(a);
  expect(f.call).toHaveBeenCalledTimes(1); expect(f.call).toHaveBeenCalledWith(["--help"]);
  expect(f.resolved[0].success).toBe(true);
  expect(JSON.stringify(f.submitted())).not.toContain("host-secret");
  expect(f.submitted().admission).toBeUndefined();
});

it("prepares the local browser in a sandbox with no connected apps or partner tools before normal native submission", async () => {
  const f = fixture();
  const business = new BusinessTools([], tmpdir(), f.store);
  const sync = vi.fn(async () => undefined);
  business.setSkills(sync);
  await business.host("agent", "owner", "binding", f.http).start(input);
  expect(sync).toHaveBeenCalledWith("agent", "owner", "binding");
  expect(f.submitted()).toMatchObject({ input: input.input, instructions: input.instructions });
  expect(f.submitted().tools).toBeUndefined();
});

it("adds the connector guides to the catalog of an Agent whose kernel has none installed, and to no other", async () => {
  const f = fixture(), read = vi.fn(async (input: { action: string }) => input.action === "tools" ? { status: "completed", tools: [{ name: "mail__gws_read" }, { name: "mail__gws_write" }] } : { status: "completed", result: { output: "ok" } });
  const apps = { reader: () => read, connections: () => ["mail"], browser: () => [], sharedEmployee: () => false, writable: false } as unknown as ConstructorParameters<typeof BusinessTools>[3];
  const business = new BusinessTools([], tmpdir(), f.store, apps);
  const sync = vi.fn(async () => undefined);
  business.setSkills(sync);
  business.setGuides(agentId => agentId === "agent" ? tools => ({ guidesNote: "note", guides: tools.map(name => ({ read: name })) }) : undefined);
  const catalog = async (agentId: string) => {
    const host = business.host(agentId, "alice", "binding", f.http);
    await host.start({ ...input, tools, admission: { ...admission, agentId } });
    f.setCalls("connected_apps", "", { action: "tools" });
    await host.calls("run");
    return JSON.parse(f.resolved.at(-1).contentItems[0].text);
  };
  expect(await catalog("agent")).toEqual({ status: "completed", tools: [{ name: "mail__gws_read" }, { name: "mail__gws_write" }],
    guidesNote: "note", guides: [{ read: "mail__gws_read" }, { read: "mail__gws_write" }] });
  // The calls themselves are the same for every kernel.
  f.setCalls("connected_apps", "", { action: "call", name: "mail__gws_read", arguments: { args: ["gmail", "+triage"] } }, "second");
  await business.host("agent", "alice", "binding", f.http).calls("run");
  expect(read).toHaveBeenLastCalledWith({ action: "call", name: "mail__gws_read", arguments: { args: ["gmail", "+triage"] } });
  expect(JSON.parse(f.resolved.at(-1).contentItems[0].text)).toEqual({ status: "completed", result: { output: "ok" } });
  expect(sync).toHaveBeenCalledWith("agent", "alice", "binding");
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
  const other = new BusinessHost(f.http, {read:f.call}, f.store, "agent:other-binding", undefined, principal);
  await other.calls("run"); expect(f.call).not.toHaveBeenCalled();
});
it("agent and owner configuration must both match before tools are attached", async () => {
  const f=fixture(), id=randomUUID();
  const manager=new BusinessTools([{agentId:id,owner:"alice",appId:"cli_fixture",appSecretFile:"private-secret",domain:"feishu",directory:"bot"}], mkdtempSync(join(tmpdir(), "mau-bot-")), f.store);
  await manager.host(id,"bob","binding",f.http).start({...input,tools,admission:{...admission,agentId:id}});
  expect(f.submitted().tools).toEqual(tools);
  await manager.host(randomUUID(),"alice","binding",f.http).start({...input,tools,admission:{...admission,agentId:id}});
  expect(f.submitted().tools).toEqual(tools);
});

it("refuses malformed reader arguments before calling the reader even for an authorized run", async () => {
  const f=fixture(); await f.host.start({...input,tools,admission}); f.setCalls("feishu_bot_read","",{args:[],sql:"select"});
  await f.host.calls("run"); expect(f.call).not.toHaveBeenCalled();
  expect(JSON.stringify(f.resolved)).toContain("invalid_business_arguments");
});
it("Cloudflare tools stay bound to the configured agent and owner", async () => {
  const f=fixture(), id=randomUUID();
  const manager=new BusinessTools([{mode:"cloudflare",agentId:id,owner:"alice",endpoint:"https://connectors.fixture/",tokenFile:"caller-token"}],".",f.store);
  await manager.host(id,"alice","binding",f.http).start({...input,tools,admission:{...admission,agentId:id}});
  expect(f.submitted().tools.map((t:any)=>t.name)).toEqual(["channel","feishu_bot_read"]);
  expect(JSON.stringify(f.submitted())).not.toContain("caller-token");
  await manager.host(id,"mallory","binding",f.http).start({...input,tools,admission:{...admission,agentId:id}});
  expect(f.submitted().tools).toEqual(tools);
});

it("a channel tool name grants nothing; an explicitly admitted independent task needs no channel tool", async () => {
  const denied = fixture(); await denied.host.start({ ...input, tools }); denied.setCalls(); await denied.host.calls("run");
  expect(denied.submitted().tools).toEqual(tools); expect(denied.call).not.toHaveBeenCalled();
  const allowed = fixture(); await allowed.host.start({ ...input, admission }); allowed.setCalls(); await allowed.host.calls("run");
  expect(allowed.submitted().tools.map((t: any) => t.name)).toEqual(["feishu_bot_read"]); expect(allowed.call).toHaveBeenCalledTimes(1);
});

it("rechecks revocation and call budget, persists deduplication, and refuses changed native call payloads", async () => {
  const f = fixture(); let active = true;
  const principalNow = { ...principal, validate: () => active };
  const host = new BusinessHost(f.http, { read: f.call }, f.store, "scheduled:binding", undefined, principalNow);
  const scheduled = { ...admission, kind: "schedule" as const, toolGrants: { feishu: true }, maxToolCalls: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await host.start({ ...input, admission: scheduled }); f.setCalls(); await host.calls("run");
  const restarted = new BusinessHost(f.http, { read: f.call }, f.store, "scheduled:binding", undefined, principalNow);
  await restarted.calls("run"); expect(f.call).toHaveBeenCalledTimes(1);
  f.setCalls("feishu_bot_read", "docs"); await restarted.calls("run");
  expect(JSON.stringify(f.resolved.at(-1))).toContain("business_call_changed");
  f.setCalls("feishu_bot_read", "--help", undefined, "second-call"); await restarted.calls("run");
  expect(JSON.stringify(f.resolved.at(-1))).toContain("business_tool_budget_exhausted");
  active = false; f.setCalls(); await restarted.calls("run");
  expect(JSON.stringify(f.resolved.at(-1))).toContain("business_tool_not_authorized"); expect(f.call).toHaveBeenCalledTimes(1);
});

it("recovers the trusted run grant after a lost start response and freezes request context for idempotent retries", async () => {
  const f = fixture(); await f.host.connect(); f.lose();
  await expect(f.host.start({ ...input, admission, requestKey: "request" })).rejects.toThrow("response_lost");
  expect(f.submitted().requestKey).toBe("request");
  const restarted = new BusinessHost(f.http, { read: f.call }, f.store, "agent:binding", undefined, principal);
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
  f.setCalls("feishu_bot_read", "--help", undefined, "child-call", "child-run"); await f.host.calls("child-run");
  expect(f.call).not.toHaveBeenCalled(); expect(JSON.stringify(f.resolved.at(-1))).toContain("business_tool_not_authorized");
});

it("preserves foreign namespaces with the same tool name for their original callback owner", async () => {
  const f = fixture(); await f.host.start({ ...input, admission });
  f.setCalls("feishu_bot_read", "--help", undefined, "other-call", "run", "other_plugin");
  expect((await f.host.calls("run")).map(call => call.name)).toEqual(["feishu_bot_read", "channel"]);
  expect(f.call).not.toHaveBeenCalled(); expect(f.resolved).toHaveLength(0);
  f.setCalls(); await f.host.calls("run"); expect(f.call).toHaveBeenCalledTimes(1);
});

it("answers a removed tool still listed in an older session's frozen catalog instead of leaving it pending", async () => {
  const f = fixture(); await f.host.start({ ...input, admission });
  for (const [name, body] of [["business_data", { tool: "catalog", arguments: {} }], ["work_sessions", { action: "create", input: "Research the issue" }],
    ["employee_memory", { action: "add", target: "user", content: "Prefers short answers" }]] as const) {
    f.setCalls(name, "", body, `${name}-call`);
    expect((await f.host.calls("run")).map(call => call.name)).toEqual(["channel"]);
    // Answered at once, with what the model can tell the owner.
    expect(f.resolved.at(-1).success).toBe(false);
    expect(JSON.parse(f.resolved.at(-1).contentItems[0].text)).toEqual({ isError: true, error: "tool_removed",
      instruction: "This tool no longer exists. This conversation still lists the tools it began with; the owner can start a new conversation to load the current ones." });
  }
  expect(f.resolved).toHaveLength(3); expect(f.call).not.toHaveBeenCalled();
  // Another component's tool of the same name is not Mau's to answer.
  f.setCalls("work_sessions", "", { action: "list" }, "foreign", "run", "other_plugin");
  expect((await f.host.calls("run")).map(call => call.name)).toEqual(["work_sessions", "channel"]);
  expect(f.resolved).toHaveLength(3);
});

it("keeps a session that began before this release on the tools and instructions it began with", async () => {
  // What a session of the previous release stored: the catalog with the tools that were since removed or renamed,
  // and its instructions with the two-file memory snapshot.
  const f = fixture(), executed: unknown[] = [];
  const before = [
    { name: "work_sessions", description: "Manage this employee's work sessions.", inputSchema: { type: "object" }, timeoutMs: 60_000 },
    { name: "employee_memory", description: "Maintain concise durable notes: memory (MEMORY.md) and user (USER.md).", inputSchema: { type: "object" }, timeoutMs: 10_000 },
    { name: "session_search", description: "Search original stored conversation text for this employee.", inputSchema: { type: "object" }, timeoutMs: 10_000 }];
  const instructions = "Stable role\n\nRemembered notes (frozen when this session began). Maintain concise durable notes with employee_memory.";
  f.store.set("business_session_catalog", "agent:binding:session", before);
  f.store.set("business_session_instructions", "agent:binding:session", instructions);
  const current = [{ name: "partners", description: "Work with the owner's other partners.", inputSchema: { type: "object" }, timeoutMs: 90_000 },
    { name: "memory", description: "Maintain your one durable memory document.", inputSchema: { type: "object" }, timeoutMs: 10_000 },
    { name: "session_search", description: "Search the original stored text of your own conversations.", inputSchema: { type: "object" }, timeoutMs: 10_000 }];
  const partner: PartnerTools = { definitions: current, context: () => ({ text: "Your memory (frozen when this session began)." }),
    turnContext: async (_admission, _sessionId, names) => ({ sessionTools: names }),
    execute: async (name, body) => { executed.push([name, body]); return { data: [] }; } };
  const host = new BusinessHost(f.http, undefined, f.store, "agent:binding", undefined, principal, partner);
  await host.start({ ...input, instructions: "Stable role", admission, tools });
  // Host compares a session with its definition: both parts are exactly what the session was created with.
  expect(f.submitted().tools).toEqual([...tools, ...before]);
  expect(f.submitted().instructions).toBe(instructions);
  // What a turn is told beside its input is decided by the tools its session has, not by the current ones.
  expect(f.submitted().context).toEqual({ requestContext: null, sessionTools: ["work_sessions", "employee_memory", "session_search"] });
  // A tool that kept its name still works there; the removed ones are answered at once; the new ones are not offered.
  f.setCalls("session_search", "", { query: "invoice" }, "search-call");
  await host.calls("run");
  expect(executed).toEqual([["session_search", { query: "invoice" }]]);
  expect(JSON.parse(f.resolved.at(-1).contentItems[0].text)).toEqual({ data: [] });
  f.setCalls("employee_memory", "", { action: "read" }, "memory-call");
  await host.calls("run");
  expect(JSON.parse(f.resolved.at(-1).contentItems[0].text)).toMatchObject({ error: "tool_removed" });
  expect(executed).toHaveLength(1);
  // A new conversation of the same partner begins with the current tools and memory text.
  await host.start({ ...input, sessionId: "new-window", instructions: "Stable role", admission, tools });
  expect(f.submitted().tools).toEqual([...tools, ...current]);
  expect(f.submitted().instructions).toBe("Stable role\n\nYour memory (frozen when this session began).");
  expect(f.submitted().context).toEqual({ requestContext: null, sessionTools: ["partners", "memory", "session_search"] });
  expect(f.store.get("business_session_catalog", "agent:binding:session")).toEqual(before);
});

it("opens a conversation with the whole catalog when a partner's message is its first turn, and records delivered input as not the owner's", async () => {
  const completed: any[] = [], runs: any[] = [];
  const f = fixture(), apps = vi.fn(async () => ({ status: "completed", tools: [] }));
  const definitions = [{ name: "partners", description: "", inputSchema: { type: "object" }, timeoutMs: 90_000 }];
  const partner: PartnerTools = { definitions, context: () => undefined, execute: async () => ({}), observe: run => { runs.push([run.id, run.status]); },
    authority: turn => turn.reference === "pm-1" ? { write: true, tool: "partners" } : undefined };
  const host = new BusinessHost(f.http, { read: f.call }, f.store, "agent:binding", apps, principal, partner, turn => completed.push(turn));
  // The message grants no Feishu reader and no connection, but the session it opens is the owner's conversation.
  const message = { kind: "delegation" as const, ...principal, reference: "pm-1", toolGrants: { feishu: false, connectedApps: { connections: [] } } };
  await host.start({ ...input, input: "[Automated delivery: this input is not a message from a human user]\n...", admission: message });
  expect(f.submitted().tools.map((tool: { name: string }) => tool.name)).toEqual(["feishu_bot_read", "connected_apps", "partners"]);
  // Having the tool in the catalog grants nothing: the run's own grants decide each call.
  f.setCalls("feishu_bot_read", "docs list");
  await host.calls("run");
  expect(f.call).not.toHaveBeenCalled(); expect(JSON.stringify(f.resolved.at(-1))).toContain("business_tool_not_authorized");
  // Any other delegation opens a session with what it was granted, as before.
  await host.start({ ...input, sessionId: "review", admission: { ...message, reference: "memory-review-1" } });
  expect(f.submitted().tools.map((tool: { name: string }) => tool.name)).toEqual(["connected_apps", "partners"]);
  // Text delivered to a runtime that takes no tool output is still not the owner's input.
  expect(f.store.get<{ inputRole: string }>("business_turn_inputs", "agent:binding:run")).toMatchObject({ inputRole: "tool" });
  expect(f.store.get<{ inputRole: string }>("business_turn_inputs", "agent:binding:child-run")).toMatchObject({ inputRole: "tool" });
  const g = fixture();
  await new BusinessHost(g.http, undefined, g.store, "agent:binding", undefined, principal, partner).start({ ...input, admission });
  expect(g.store.get<{ inputRole: string }>("business_turn_inputs", "agent:binding:run")).toMatchObject({ inputRole: "user" });
  // Every run that reaches the Host is reported, for the roster's view of who is working.
  expect(runs).toEqual([["run", "running"], ["child-run", "running"], ["run", "running"]]);
  expect(completed).toEqual([]);
  // Router labels a delegated tool output with the former delegation tool. A partner's turn gets it under the tool that sent it.
  const delivery = { namespace: "mau", name: "work_sessions", retain: false, output: JSON.stringify({ source: { kind: "delegation", reference: "pm-1" }, message: "Hello" }) };
  const delivered = async (toolOutput: typeof delivery, turn: typeof message, began?: string[]) => {
    const one = fixture();
    if (began) one.store.set("business_session_catalog", "agent:binding:session", began.map(name => ({ name, description: "", inputSchema: { type: "object" }, timeoutMs: 1000 })));
    await new BusinessHost(one.http, undefined, one.store, "agent:binding", undefined, principal, partner).start({ ...input, input: "", toolOutput, admission: turn });
    return one.submitted().toolOutput;
  };
  expect(await delivered(delivery, message)).toEqual({ ...delivery, name: "partners" });
  // A session that began with the former tool, and not with this one, keeps the label of a tool it has.
  expect((await delivered(delivery, message, ["work_sessions", "employee_memory"])).name).toBe("work_sessions");
  expect((await delivered({ ...delivery, namespace: "other" }, message)).name).toBe("work_sessions");
  expect((await delivered(delivery, { ...message, reference: "memory-review-1" })).name).toBe("work_sessions");

});

it("tells a product tool that its result was delivered only when the result itself reached the Host", async () => {
  const f = fixture(), delivered: string[] = [];
  const partner: PartnerTools = { definitions: [{ name: "partners", description: "", inputSchema: { type: "object" }, timeoutMs: 90_000 }], context: () => undefined,
    execute: async () => ({ results: [] }), delivered: (name, _admission, callId) => { delivered.push(`${name}:${callId}`); } };
  const host = new BusinessHost(f.http, undefined, f.store, "agent:binding", undefined, principal, partner);
  await host.start({ ...input, admission });
  f.setCalls("partners", "", { action: "wait" }, "wait-1");
  await host.calls("run");
  expect(delivered).toEqual(["partners:wait-1"]);
  // The same call listed again answers from its receipt, which is the same result.
  await new BusinessHost(f.http, undefined, f.store, "agent:binding", undefined, principal, partner).calls("run");
  expect(delivered).toEqual(["partners:wait-1", "partners:wait-1"]);
  // A call that was interrupted before its result was saved is answered as unknown: nothing was delivered.
  f.setCalls("partners", "", { action: "wait" }, "wait-2");
  const interrupted: PartnerTools = { ...partner, execute: async () => { throw Object.assign(new Error("process stopped"), { stop: true }); } };
  await new BusinessHost(f.http, undefined, f.store, "agent:binding", undefined, principal, interrupted).calls("run");
  expect(JSON.stringify(f.resolved.at(-1))).toContain("partner_tool_unavailable");
  f.store.set("business_call_receipts", "agent:binding:run:wait-3", { hash: (f.store.get<{ hash: string }>("business_call_receipts", "agent:binding:run:wait-2"))!.hash });
  f.setCalls("partners", "", { action: "wait" }, "wait-3");
  await host.calls("run");
  expect(JSON.stringify(f.resolved.at(-1))).toContain("business_call_outcome_unknown");
  expect(delivered).toEqual(["partners:wait-1", "partners:wait-1"]);
});

it("prepares connector skills before a run, and a failed preparation never blocks the run", async () => {
  const f = fixture(), read = vi.fn(async () => ({ status: "completed", tools: [] }));
  const host = new BusinessHost(f.http, undefined, f.store, "apps:binding", read, principal);
  const prepared: string[] = [];
  host.beforeStart = async () => { prepared.push("synced"); throw new Error("environment busy"); };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await host.start({ ...input, admission });
  expect(prepared).toEqual(["synced"]);
  expect(f.submitted().tools.map((tool: any) => tool.name)).toEqual(["connected_apps"]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("agent_skills_sync_failed"));
});

it("admits owner-identity connections only in the owner's private conversation, with a clear refusal elsewhere", async () => {
  const f = fixture();
  const read = vi.fn(async (input: any, scope?: any) => input.action === "tools"
    ? { status: "completed", tools: (scope?.connections ?? ["alice-feishu", "alice-gmail"]).map((id: string) => ({ name: `${id.replaceAll("-", "_")}__read` })) }
    : { status: "completed", result: "ok" });
  let privateConversation = false, known: Set<string> | undefined = new Set(["alice-feishu"]);
  const hosting = { connections: () => ["alice-feishu", "alice-gmail"], browser: () => [],
    ownerPrivate: { connections: async () => known, admitted: async () => privateConversation } };
  const host = new BusinessHost(f.http, undefined, f.store, "private:binding", read, principal, undefined, undefined, hosting);
  await host.start({ ...input, tools, admission });
  const answer = async (body: unknown, id: string) => { f.setCalls("connected_apps", "", body, id); await host.calls("run"); return JSON.parse(f.resolved.at(-1).contentItems[0].text); };
  // A group turn (Router admits the owner's private-group turns as `owner`): Feishu is reported unavailable, Gmail stays.
  const listed = await answer({ action: "tools" }, "group-tools");
  expect(listed.tools.map((t: any) => t.name)).toEqual(["alice_gmail__read"]);
  expect(listed.unavailableHere).toEqual([{ connection: "alice-feishu", reason: "connected_app_owner_private_only" }]);
  read.mockClear();
  const refused = await answer({ action: "call", name: "alice_feishu__read", arguments: {} }, "group-call");
  expect(refused).toMatchObject({ status: "failed", error: "connected_app_owner_private_only", connection: "alice-feishu" });
  expect(refused.message).toMatch(/私聊/);
  expect(read).not.toHaveBeenCalled();
  expect((await answer({ action: "call", name: "alice_gmail__read", arguments: {} }, "group-gmail")).status).toBe("completed");
  expect(read.mock.calls.at(-1)![1]).toEqual({ connections: ["alice-gmail"] });
  // Unknown usage (service unavailable) fails closed outside the private conversation.
  known = undefined;
  expect((await answer({ action: "call", name: "alice_gmail__read", arguments: {} }, "unknown-gmail")).error).toBe("connected_app_owner_private_only");
  // The owner's private conversation uses both.
  privateConversation = true; read.mockClear();
  expect((await answer({ action: "tools" }, "dm-tools")).tools).toHaveLength(2);
  expect((await answer({ action: "call", name: "alice_feishu__read", arguments: {} }, "dm-call")).status).toBe("completed");
  // A turn a partner's message started has write authority from the turn that sent the message, and still no
  // personal identity: what admits it is the owner's own turn, which the policy decides, not the partner tools.
  const g = fixture(), asked: unknown[] = [];
  const partner: PartnerTools = { definitions: [], context: () => undefined, execute: async () => ({}), authority: () => ({ write: true, tool: "partners" }) };
  const partnerHost = new BusinessHost(g.http, undefined, g.store, "private:binding", read, principal, partner, undefined,
    { ...hosting, ownerPrivate: { connections: async () => new Set(["alice-feishu"]), admitted: async turn => { asked.push(turn.kind); return turn.kind === "owner"; } } });
  await partnerHost.start({ ...input, tools, admission: { kind: "delegation", ...principal, reference: "pm-1", toolGrants: { connectedApps: { connections: ["alice-feishu", "alice-gmail"] } } } });
  g.setCalls("connected_apps", "", { action: "call", name: "alice_feishu__read", arguments: {} }, "partner-call"); read.mockClear();
  await partnerHost.calls("run");
  expect(JSON.parse(g.resolved.at(-1).contentItems[0].text)).toMatchObject({ status: "failed", error: "connected_app_owner_private_only", connection: "alice-feishu",
    message: expect.stringContaining("伙伴之间的消息") });
  expect(read).not.toHaveBeenCalled(); expect(asked).toEqual(["delegation"]);
});

it("uses the employee assignment on a partner return and preserves explicit grants on a restricted review", async () => {
  const f = fixture(), read = vi.fn(async () => ({ status: "completed", tools: [{ name: "personal__read" }] }));
  const partner: PartnerTools = { definitions: [], context: () => undefined, execute: async () => ({}),
    authority: turn => turn.reference === "pr-result" ? { write: true, tool: "partners" } : undefined };
  const host = new BusinessHost(f.http, undefined, f.store, "lead", read, principal, partner, undefined,
    { employeePermissions: true, connections: () => ["personal"], browser: () => [],
      ownerPrivate: { connections: async () => new Set(["personal"]), admitted: async () => false } });
  const start = (reference: string) => host.start({ ...input, sessionId: reference === "pr-result" ? "session" : "review", tools, admission: { ...admission, kind: "delegation", reference,
    toolGrants: { connectedApps: { connections: [], operations: [] } } } });
  await start("pr-result");
  f.setCalls("connected_apps", "", { action: "tools" }, "partner-catalog");
  await host.calls("run");
  expect(read).toHaveBeenCalledWith({ action: "tools" });
  read.mockClear();
  await start("memory-review");
  f.setCalls("connected_apps", "", { action: "tools" }, "review-catalog", "child-run");
  await host.calls("child-run");
  expect(read).toHaveBeenCalledWith({ action: "tools" }, { connections: [], operations: [] });
});
