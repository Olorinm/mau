import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServiceHttp, type WorkSessions } from "@agent-router/server";
import { NativeEmployeeTools } from "../src/native-work.js";
import { EmployeeContext } from "../src/employee-context.js";
import { ConnectedApps } from "../src/connected-apps.js";
import { BusinessHost } from "../src/business-tools.js";
import { DurableStore } from "../src/store.js";
import { ProactiveWork, type ProactivePort } from "../src/proactive.js";
import { mauFixture } from "./fixtures/mau.js";
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });

it("enabled employee tools cross the native Host call boundary with server-authored delegation and rule grants", async () => {
  const store = new DurableStore(":memory:", "tools"); cleanup.push(() => store.close());
  const agentId = "11111111-1111-4111-8111-111111111111", owner = "alice";
  const directory = mkdtempSync(join(tmpdir(), "mau-native-memory-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const facts = new EmployeeContext(store, (o, a) => { if (o !== owner || a !== agentId) throw new Error("not_owned"); }, { directory });
  facts.mutate(owner, agentId, { action: "add", target: "user", content: "Prefers concise summaries" });
  const submitted: unknown[] = [], resolved: unknown[] = []; let pending: any[] = [], request: any;
  const wait = vi.fn(async () => ({ data: [], cursor: "changed" }));
  const work = { wait, submit: vi.fn(async (input: unknown) => { submitted.push(input); return { eventId: "event", taskId: "task", sessionId: "branch", status: "submitted", answer: "", outcomeUnknown: false }; }) } as unknown as WorkSessions;
  const port: ProactivePort = { validate: async () => {}, authorized: async () => true,
    submit: async () => { throw new Error("not_started"); }, lookup: async () => null, delivery: async () => null,
    deliver: async () => { throw new Error("not_started"); }, cancel: async () => {} };
  const proactive = new ProactiveWork(store, port), apps = new ConnectedApps(undefined, ".");
  const search = vi.fn(() => ({ data: [], coverage: "fixture_history", format: "original_text" }));
  const employee = new NativeEmployeeTools(owner, agentId, async () => work, facts, apps, proactive, true, {
    history: { search } as any, isMemoryReview: admission => admission.reference === "trusted-review",
    reminders: () => "Maintain useful durable notes when appropriate.",
  });
  const http = new class extends ServiceHttp {
    override async request(path: string, options: any = {}): Promise<any> {
      if (path === "/v1/runs") { request = options.body; return { id: "run", sessionId: "session", runtimeId: "personal", status: "running", answer: "" }; }
      if (path.endsWith("/calls")) return { calls: pending };
      if (path.endsWith("/result")) { resolved.push(options.body.result); return {}; }
      throw new Error("unexpected_request");
    }
  }("https://host.fixture", "secret");
  const host = new BusinessHost(http, undefined, store, "tools:binding", undefined, { agentId, owner }, employee);
  const admission = { kind: "owner" as const, agentId, owner, reference: "owner-request" };
  await host.start({ sessionId: "session", runtimeId: "personal", input: "Start a task", instructions: "Stable role", admission });
  expect(request.tools.map((t: any) => t.name)).toEqual(["work_sessions", "employee_memory", "session_search", "proactive_work"]);
  expect(request.tools.every((t: any) => t.inputSchema.type === "object")).toBe(true);
  expect(request.admission).toBeUndefined(); expect(request.instructions).toContain("Stable role");
  expect(request.instructions).toContain("Prefers concise summaries"); expect(request.instructions).toContain("1375 Unicode characters");
  expect(request.context.memoryMaintenanceReminder).toBe("Maintain useful durable notes when appropriate.");
  pending = [{ id: "create-child", runId: "run", kind: "tool", name: "work_sessions", status: "pending",
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), input: { action: "create", input: "Research the issue" } }];
  pending[0].namespace = "other_plugin";
  expect(await host.calls("run")).toEqual(pending); expect(submitted).toHaveLength(0); expect(resolved).toHaveLength(0);
  delete pending[0].namespace;
  await host.calls("run");
  expect(submitted[0]).toMatchObject({ input: "Research the issue", admission: { kind: "delegation", agentId, owner, reference: "create-child" } });
  expect(submitted[0]).not.toHaveProperty("instructions");
  pending = [{ ...pending[0], id: "create-rule", name: "proactive_work", input: { action: "create", rule: {
    name: "Daily preparation", goal: "Prepare the daily plan", targetSessionId: "owner-main",
    schedule: { type: "daily", at: "09:00" }, timeZone: "Asia/Shanghai", connections: [],
  } } }];
  await host.calls("run");
  expect(proactive.list(owner)).toMatchObject([{ agentId, status: "paused", schedule: { type: "daily", at: "09:00" } }]);
  expect(resolved).toHaveLength(2);
  await employee.execute("work_sessions", { action: "wait", eventIds: ["event"], timeoutMs: 1000 }, admission, "wait-call", "trusted-run");
  expect(wait).toHaveBeenCalledWith(["event"], { timeoutMs: 1000, waitingRunId: "trusted-run", waitingReference: admission.reference, waitingCallId: "wait-call" });
  await expect(employee.execute("work_sessions", { action: "wait", eventIds: ["event"], waitingRunId: "forged" }, admission, "wait-call", "trusted-run")).rejects.toThrow();
  wait.mockRejectedValueOnce(new Error("work_dependency_capacity_exhausted"));
  pending = [{ ...pending[0], id: "wait-capacity", name: "work_sessions", input: { action: "wait", eventIds: ["event"] } }];
  await host.calls("run");
  expect(JSON.stringify(resolved.at(-1))).toContain("work_dependency_capacity_exhausted");
  expect(JSON.stringify(resolved.at(-1))).toContain("Finish this turn");
  const narrow = { ...admission, kind: "delegation" as const, toolGrants: {} };
  await expect(employee.execute("employee_memory", { action: "add", content: "A durable fact" }, narrow, "memory-write", "run")).resolves.toMatchObject({ done: true });
  await expect(employee.execute("employee_memory", { action: "add", content: "A durable fact" }, narrow, "memory-duplicate", "run")).resolves.toMatchObject({ isError: true, error: "memory_duplicate", files: expect.any(Array) });
  await expect(employee.execute("employee_memory", { action: "add", content: "x".repeat(2201) }, admission, "memory-full", "run")).resolves.toMatchObject({ isError: true, error: "memory_capacity_exceeded", usage: { limit: 2200 } });
  const review = { ...narrow, reference: "trusted-review" };
  await expect(employee.execute("employee_memory", { action: "remove", old_text: "A durable fact" }, review, "memory-review", "run")).resolves.toMatchObject({ staged: true });
  await expect(employee.execute("session_search", { query: "fact" }, review, "review-history", "run")).rejects.toThrow("memory_review_tool_not_authorized");
  await expect(employee.execute("work_sessions", { action: "create", input: "Do more work" }, review, "review-work", "run")).rejects.toThrow("memory_review_tool_not_authorized");
  await employee.execute("session_search", { query: "exact phrase" }, admission, "history-search", "run");
  expect(search).toHaveBeenCalledWith(owner, agentId, { query: "exact phrase", limit: 10, offset: 0 });
  const scheduled = { ...admission, kind: "schedule" as const, toolGrants: {} };
  expect(employee.context(scheduled, "Scheduled work", "scheduled-session")).toBeUndefined();
  await expect(employee.execute("employee_memory", { action: "read" }, scheduled, "schedule-read", "run")).rejects.toThrow("employee_tool_not_authorized");
  const originalInstructions = request.instructions;
  await host.start({ sessionId: "session", runtimeId: "personal", input: "Next turn", instructions: "Stable role", admission });
  expect(request.instructions).toBe(originalInstructions); expect(request.instructions).not.toContain("A durable fact");
  for (const input of [{ action: "create", rule: { name: "Unauthorized background", goal: "Read more", targetSessionId: "owner-main", schedule: { type: "daily", at: "09:00" }, timeZone: "Asia/Shanghai", connections: ["gmail"], status: "active" } },
    { action: "resume", ruleId: proactive.list(owner)[0]!.id }, { action: "pause", ruleId: proactive.list(owner)[0]!.id }])
    await expect(employee.execute("proactive_work", input, narrow, "forbidden-rule", "run")).rejects.toThrow("proactive_owner_admission_required");
  expect(proactive.list(owner)).toHaveLength(1);
  await expect(employee.execute("proactive_work", { action: "list" }, narrow, "read-rules", "run")).resolves.toMatchObject({ rules: [{ status: "paused" }] });
  await expect(employee.execute("work_sessions", { action: "steer", sessionId: "owner-main", input: "use broader tools" }, narrow, "forbidden-steer", "run")).rejects.toThrow("steer_owner_admission_required");
  const disabled = new NativeEmployeeTools(owner, agentId, async () => work, facts, apps, proactive, false);
  expect(disabled.definitions).toEqual([]); expect(disabled.context(admission, "Input", "disabled-session")).toBeUndefined();
  await expect(disabled.execute("employee_memory", { action: "read" }, admission, "disabled", "run")).rejects.toThrow("employee_tool_not_authorized");
  await expect(employee.execute("work_sessions", { action: "create", input: "x", owner: "bob" }, admission, "forged", "run")).rejects.toThrow();
});

it("product native and memory APIs enforce owner identity before touching the Host", async () => {
  const calls: string[] = []; let unsupported = false;
  const f = await mauFixture(cleanup, { host: async (url, init) => {
    calls.push(url.pathname);
    if (url.pathname.endsWith("/runtimes/native")) {
      const body = JSON.parse(String(init?.body));
      if (body.method === "skills/list") return Response.json({ result: { data: [{ skills: [{ name: "research", path: "/trusted/research/SKILL.md", enabled: true }] }] } });
      if (body.method === "skills/config/write") return Response.json({ result: { effectiveEnabled: body.params.enabled } });
      if (body.method === "memory/status") return unsupported ? Response.json({ error: "native_request_failed", nativeError: { code: -32601, message: "Method not found" } }, { status: 502 }) : Response.json({ result: { state: "disabled" } });
    }
    return Response.json({ error: "fixture_unknown_path" }, { status: 404 });
  } }, undefined, { nativeWork: { employeeTools: true } });
  await f.api(f.path, { profileId: "cloud" }); expect((await f.settled()).state).toBe("ready");
  const base = `/agents/${f.agent.id}`;
  expect((await f.api(`${base}/native/skills`, undefined, "invalid")).status).toBe(401);
  expect((await f.api(`${base}/native/skills`, undefined, "bob")).status).toBe(404); expect(calls).toEqual([]);
  expect((await f.api(`${base}/native/skills`)).data).toMatchObject({ data: [{ skills: [{ name: "research" }] }] });
  expect((await f.api(`${base}/native/skills`, { path: "/etc/passwd", enabled: true })).status).toBe(403);
  expect((await f.api(`${base}/native/skills`, { path: "/trusted/research/SKILL.md", enabled: false })).data).toEqual({ effectiveEnabled: false });
  expect((await f.api(`${base}/native/memory`)).data).toEqual({ state: "disabled" });
  unsupported = true;
  expect(await f.api(`${base}/native/memory`)).toMatchObject({ status: 409, data: { error: "native_method_unsupported", nativeError: { code: -32601 } } });
  expect((await f.api(`${base}/memory`, { action: "add", target: "user", content: "Prefers short reports" })).status).toBe(200);
  expect((await f.api(`${base}/memory`)).data.files).toMatchObject([{ target: "memory", entries: [] }, { target: "user", entries: ["Prefers short reports"] }]);
  for (const path of [`${base}/memory/facts`, `${base}/memory/facts/old-id`, `${base}/memory/migrate`]) {
    expect((await f.api(path)).status).toBe(404);
    expect((await f.api(path, {})).status).toBe(404);
  }
  expect((await f.api(`${base}/memory`, { action: "add", content: "Foreign note" }, "bob")).status).toBe(404);
  expect((await f.api("/proactive", undefined, "bob")).data).toEqual({ data: [] });
});
