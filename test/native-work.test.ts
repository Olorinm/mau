import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServiceHttp } from "@agent-router/server";
import { NativePartnerTools } from "../src/native-work.js";
import { PartnerContext } from "../src/partner-context.js";
import type { Partners } from "../src/partners.js";
import { noPartners } from "./fixtures/no-partners.js";
import { BusinessHost } from "../src/business-tools.js";
import { DurableStore } from "../src/store.js";
import { ProactiveWork, type ProactivePort } from "../src/proactive.js";
import { mauFixture } from "./fixtures/mau.js";
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });

it("enabled partner tools cross the native Host call boundary with the run's own admission", async () => {
  const store = new DurableStore(":memory:", "tools"); cleanup.push(() => store.close());
  const agentId = "11111111-1111-4111-8111-111111111111", owner = "alice";
  const directory = mkdtempSync(join(tmpdir(), "mau-native-memory-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const facts = new PartnerContext(store, (o, a) => { if (o !== owner || a !== agentId) throw new Error("not_owned"); }, { directory });
  facts.mutate(owner, agentId, { action: "add", content: "Prefers concise summaries" });
  const resolved: any[] = []; let pending: any[] = [], request: any;
  const port: ProactivePort = { validate: async () => {}, authorized: async () => true,
    submit: async () => { throw new Error("not_started"); }, lookup: async () => null, delivery: async () => null,
    deliver: async () => { throw new Error("not_started"); }, cancel: async () => {},
    confirmations: { ask: async proposal => { cards.push(proposal); }, answer: async () => ownerAnswer, withdraw: async () => {} } };
  const cards: any[] = []; let ownerAnswer: "pending" | "confirmed" = "pending";
  const proactive = new ProactiveWork(store, port);
  const search = vi.fn(() => ({ data: [], coverage: "fixture_history", format: "original_text" }));
  // The partners service is given the admission of the run and the call's id by the server, never by the model.
  const asked: unknown[] = [];
  const delivered: unknown[] = [];
  const partners = { ...noPartners, memorySource: (admission: { kind: string }) => admission.kind === "delegation" ? { kind: "message", partners: [{ id: "p-1", name: "trip" }] } : undefined, turnContext: async (_admission: unknown, roster: boolean) => roster ? { partners: "The owner has no other partners now." } : {},
    delivered: (...call: unknown[]) => { delivered.push(call); },
    execute: async (...call: unknown[]) => { asked.push(call); return { you: { name: "helper" }, partners: [] }; } } as unknown as Partners;
  const partner = new NativePartnerTools(owner, agentId, partners, facts, proactive, true, {
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
  const host = new BusinessHost(http, undefined, store, "tools:binding", undefined, { agentId, owner }, partner);
  const admission = { kind: "owner" as const, agentId, owner, reference: "owner-request" };
  await host.start({ sessionId: "session", runtimeId: "personal", input: "Start a task", instructions: "Stable role", admission });
  expect(request.tools.map((t: any) => t.name)).toEqual(["partners", "memory", "session_search", "proactive_work"]);
  expect(request.tools.every((t: any) => t.inputSchema.type === "object")).toBe(true);
  expect(request.admission).toBeUndefined(); expect(request.instructions).toContain("Stable role");
  expect(request.instructions).toContain("Prefers concise summaries"); expect(request.instructions).toContain("/4000 Unicode characters");
  // What the turn is told travels beside its input, not in its instructions or its tool definitions.
  expect(request.context).toEqual({ memoryMaintenanceReminder: "Maintain useful durable notes when appropriate.", partners: "The owner has no other partners now." });
  expect(request.instructions).not.toContain("no other partners"); expect(JSON.stringify(request.tools)).not.toContain("no other partners");
  pending = [{ id: "roster", runId: "run", kind: "tool", name: "partners", status: "pending",
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), input: { action: "roster", owner: "bob" } }];
  pending[0].namespace = "other_plugin";
  expect(await host.calls("run")).toEqual(pending); expect(asked).toHaveLength(0); expect(resolved).toHaveLength(0);
  delete pending[0].namespace;
  await host.calls("run");
  expect(asked).toEqual([[admission, { action: "roster", owner: "bob" }, "roster"]]);
  // The service is told when the answer of a partners call has reached the Host, and of no other tool's.
  expect(delivered).toEqual([[admission, "roster"]]);
  expect(JSON.parse(resolved[0].contentItems[0].text)).toEqual({ you: { name: "helper" }, partners: [] });
  pending = [{ ...pending[0], id: "create-rule", name: "proactive_work", input: { action: "create", rule: {
    name: "Daily preparation", goal: "Prepare the daily plan", targetSessionId: "owner-main",
    schedule: { type: "daily", at: "09:00" }, timeZone: "Asia/Shanghai", connections: [],
  } } }];
  await host.calls("run");
  // A rule the Agent creates is not saved: the owner is shown a card, and the Agent is told to wait for the answer.
  expect(proactive.list(owner)).toEqual([]); expect(cards).toMatchObject([{ kind: "create", agentId, rule: { name: "Daily preparation", status: "active" } }]);
  expect(JSON.parse(resolved[1].contentItems[0].text)).toMatchObject({ status: "awaiting_owner_confirmation", change: "create", name: "Daily preparation",
    instruction: expect.stringContaining("Do not repeat this call") });
  await expect(partner.execute("proactive_work", { action: "list" }, admission, "waiting")).resolves.toMatchObject({ rules: [], awaitingOwnerConfirmation: [{ change: "create" }] });
  ownerAnswer = "confirmed"; await proactive.tick();
  expect(proactive.list(owner)).toMatchObject([{ agentId, status: "active", schedule: { type: "daily", at: "09:00" } }]);
  expect(resolved).toHaveLength(2); expect(delivered).toHaveLength(1);
  const narrow = { ...admission, kind: "delegation" as const, toolGrants: {} };
  await expect(partner.execute("memory", { action: "add", content: "A durable fact" }, narrow, "memory-write")).resolves.toMatchObject({ done: true });
  // The change is recorded with whose message the turn was handling; the owner's own turns are the owner's.
  expect(facts.mutations(owner, agentId)).toMatchObject([
    { seq: 2, origin: "delegation", source: { kind: "message", partners: [{ id: "p-1", name: "trip" }] }, changes: [{ action: "add", text: "A durable fact" }], unseen: true },
    { seq: 1, origin: "owner", changes: [{ action: "add", text: "Prefers concise summaries" }], unseen: false }]);
  await expect(partner.execute("memory", { action: "add", content: "A durable fact" }, narrow, "memory-duplicate")).resolves.toMatchObject({ isError: true, error: "memory_duplicate", entries: ["Prefers concise summaries", "A durable fact"] });
  await expect(partner.execute("memory", { action: "add", content: "x".repeat(4001) }, admission, "memory-full")).resolves.toMatchObject({ isError: true, error: "memory_capacity_exceeded", usage: { limit: 4000 } });
  await expect(partner.execute("memory", { action: "add", target: "user", content: "No second file" }, admission, "memory-target")).resolves.toMatchObject({ isError: true, error: "memory_invalid_input" });
  await expect(partner.execute("memory", { action: "read" }, admission, "memory-read")).resolves.toMatchObject({ file: "MEMORY.md", entries: ["Prefers concise summaries", "A durable fact"], usage: { limit: 4000 } });
  // A memory review may use the memory tool and nothing else, and is told nothing about partners.
  const review = { ...narrow, reference: "trusted-review" };
  await expect(partner.execute("memory", { action: "remove", old_text: "A durable fact" }, review, "memory-review")).resolves.toMatchObject({ done: true });
  await expect(partner.execute("session_search", { query: "fact" }, review, "review-history")).rejects.toThrow("memory_review_tool_not_authorized");
  await expect(partner.execute("partners", { action: "roster" }, review, "review-partners")).rejects.toThrow("memory_review_tool_not_authorized");
  expect(await partner.turnContext(review, "session", ["partners", "memory"])).toEqual({});
  // A session that began with an earlier set of tools is told nothing about tools it does not have.
  expect(await partner.turnContext(admission, "session", ["work_sessions", "employee_memory"])).toEqual({});
  expect(await partner.turnContext(admission, "session", ["memory"])).toEqual({ memoryMaintenanceReminder: "Maintain useful durable notes when appropriate." });
  expect(await partner.turnContext(admission, "session", ["partners"])).toEqual({ partners: "The owner has no other partners now." });
  await partner.execute("session_search", { query: "exact phrase" }, admission, "history-search");
  expect(search).toHaveBeenCalledWith(owner, agentId, { query: "exact phrase", limit: 10, offset: 0 });
  // A schedule has none of these tools, whatever a reused conversation's catalog lists.
  const scheduled = { ...admission, kind: "schedule" as const, toolGrants: {} };
  expect(partner.context(scheduled, "Scheduled work", "scheduled-session")).toBeUndefined();
  expect(await partner.turnContext(scheduled, "session", ["partners"])).toEqual({});
  for (const name of ["partners", "memory", "session_search", "proactive_work"])
    await expect(partner.execute(name, { action: "read" }, scheduled, "schedule-call")).rejects.toThrow("partner_tool_not_authorized");
  await expect(partner.execute("work_sessions", { action: "list" }, admission, "old-name")).rejects.toThrow();
  const originalInstructions = request.instructions;
  await host.start({ sessionId: "session", runtimeId: "personal", input: "Next turn", instructions: "Stable role", admission });
  expect(request.instructions).toBe(originalInstructions); expect(request.instructions).not.toContain("A durable fact");
  for (const input of [{ action: "create", rule: { name: "Unauthorized background", goal: "Read more", targetSessionId: "owner-main", schedule: { type: "daily", at: "09:00" }, timeZone: "Asia/Shanghai", connections: ["gmail"], status: "active" } },
    { action: "resume", ruleId: proactive.list(owner)[0]!.id }, { action: "pause", ruleId: proactive.list(owner)[0]!.id }])
    await expect(partner.execute("proactive_work", input, narrow, "forbidden-rule")).rejects.toThrow("proactive_owner_admission_required");
  expect(proactive.list(owner)).toHaveLength(1);
  await expect(partner.execute("proactive_work", { action: "list" }, narrow, "read-rules")).resolves.toEqual({ rules: [expect.objectContaining({ status: "active" })] });
  const disabled = new NativePartnerTools(owner, agentId, partners, facts, proactive, false);
  expect(disabled.definitions).toEqual([]); expect(disabled.context(admission, "Input", "disabled-session")).toBeUndefined();
  expect(await disabled.turnContext(admission, "session", ["partners"])).toEqual({}); expect(disabled.authority(admission)).toBeUndefined();
  await expect(disabled.execute("memory", { action: "read" }, admission, "disabled")).rejects.toThrow("partner_tool_not_authorized");
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
  } }, { nativeWork: { partnerTools: true } });
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
  expect((await f.api(`${base}/memory`, { action: "add", content: "Prefers short reports" })).status).toBe(200);
  expect((await f.api(`${base}/memory`, { action: "add", target: "user", content: "No second file" })).status).toBe(400);
  expect((await f.api(`${base}/memory`)).data).toMatchObject({ file: "MEMORY.md", entries: ["Prefers short reports"], usage: { used: 21, limit: 4000 }, writeApproval: false });
  expect((await f.api(`${base}/memory`, { action: "add", content: "Foreign note" }, "bob")).status).toBe(404);
  expect((await f.api("/proactive", undefined, "bob")).data).toEqual({ data: [] });
});

it("has one name for the setting that turns the partner tools on: the former key is refused, not read", async () => {
  await expect(mauFixture(cleanup, {}, { nativeWork: { employeeTools: true } })).rejects.toThrow(/employeeTools/);
  const f = await mauFixture(cleanup, {}, { nativeWork: { partnerTools: true } });
  expect((await f.api("/partners")).data).toEqual({ data: [{ id: f.agent.id, name: "helper", duty: null, kernel: null, model: null, effort: null, status: "no_environment",
    lastActivityAt: null, waiting: { messages: 0, approvals: 0 } }] });
  expect((await f.api("/partners", undefined, "bob")).data).toEqual({ data: [] });
});
