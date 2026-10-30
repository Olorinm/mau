import { afterEach, expect, it } from "vitest";
import { DurableStore } from "../src/store.js";
import { ProactiveWork, nextOccurrence, inQuietHours, heartbeatPreset, proactiveRuleInput, type ProactivePort, type WorkSnapshot } from "../src/proactive.js";
import { RouterError } from "@agent-router/server";
const stores: DurableStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); });
const result = (version = "1", decision = "notify") => ({ decision, reason: "changed", summary: `Report ${version}`,
  findings: [{ sourceId: "gmail", entityId: "message", version, occurredAt: "2026-10-29T01:00:00Z", evidence: "message id" }],
  sources: [{ sourceId: "gmail", status: "checked", proposedCursor: version }], approvalProposals: [] });
function fixture() {
  const store = new DurableStore(":memory:", "proactive"); stores.push(store);
  let now = new Date("2026-10-29T01:00:00Z"), authorized = true, answer: unknown = result(), loseSubmit = false;
  const works = new Map<string, WorkSnapshot>(), deliveries = new Map<string, { status: string }>();
  const submitted: any[] = [], notifications: any[] = [];
  const port: ProactivePort = {
    async validate(rule) { if (rule.owner !== "alice" || rule.targetSessionId !== "owner-main") throw new Error("scope"); },
    async authorized() { return authorized; },
    async submit(_rule, input) {
      submitted.push(input);
      const work = { eventId: input.eventId, taskId: "task", sessionId: input.sessionId, status: "completed", answer: JSON.stringify(answer) };
      works.set(input.eventId, work);
      if (loseSubmit) { loseSubmit = false; throw new Error("connection_lost"); }
      return work;
    },
    async lookup(_rule, id) { return works.get(id) ?? null; },
    async validateCursor() { return true; }, // This fixture simulates a trusted source receipt.
    async deliver(_rule, input) { notifications.push(input); const receipt = { status: "sent" }; deliveries.set(input.eventId, receipt); return receipt; },
    async delivery(_rule, id) { return deliveries.get(id) ?? null; },
    async cancel(_rule, id) { const work = works.get(id); if (work) works.set(id, { ...work, status: "cancelled" }); },
  };
  const service = new ProactiveWork(store, port, () => now);
  return { store, service, port, works, submitted, notifications, deliveries,
    setNow: (value: string) => { now = new Date(value); },
    setAnswer: (value: unknown) => { answer = value; },
    setAuthorized: (value: boolean) => { authorized = value; },
    lose: () => { loseSubmit = true; }, clock: () => now,
    input: { agentId: "11111111-1111-4111-8111-111111111111", targetSessionId: "owner-main", name: "Check mail", goal: "Find new actionable mail",
      schedule: { type: "interval" as const, minutes: 5 }, timeZone: "Asia/Shanghai", connections: ["gmail"], status: "active" as const },
  };
}

it("persists a trigger before dispatch, queries a lost submission, and atomically advances cursor plus notification", async () => {
  const f = fixture(), rule = await f.service.save("alice", f.input);
  const trigger = await f.service.runNow("alice", rule.id, "request-1");
  f.lose(); await f.service.tick();
  expect(f.service.runs("alice", rule.id)[0]!.status).toBe("submitting");
  expect(f.notifications).toEqual([]);
  await f.service.close();
  const reopened = new ProactiveWork(f.store, f.port, f.clock);
  await reopened.tick();
  expect(f.submitted).toHaveLength(1); expect(f.notifications).toHaveLength(1);
  expect(f.store.get("cursors", `${rule.id}:gmail`)).toEqual({ sourceId: "gmail", cursor: "1" });
  expect(reopened.notices("alice", rule.id)[0]!.status).toBe("sent");
  expect((await reopened.runNow("alice", rule.id, "request-1")).id).toBe(trigger.id);
  await reopened.tick(); expect(f.notifications).toHaveLength(1);
  expect(f.submitted[0].admission).toMatchObject({ kind: "schedule", owner: "alice", reference: trigger.id, toolGrants: { connectedApps: { connections: ["gmail"] } } });
  expect(f.submitted[0].sessionId).not.toBe(f.input.targetSessionId);
});

it("coalesces missed intervals, prevents overlapping runs, enforces daily budgets and isolates owner APIs", async () => {
  const f = fixture(), rule = await f.service.save("alice", { ...f.input, maxRunsPerDay: 1 });
  f.setNow("2026-10-29T02:00:00Z"); await f.service.tick();
  expect(f.submitted).toHaveLength(1);
  expect(f.service.rule("alice", rule.id).nextAt).toBe("2026-10-29T02:05:00.000Z");
  await expect(f.service.runNow("alice", rule.id, "manual")).rejects.toThrow("proactive_daily_budget_exhausted");
  expect(() => f.service.rule("bob", rule.id)).toThrow("proactive_rule_not_found");
  expect(f.service.list("bob")).toEqual([]);
  f.setNow("2026-10-30T02:00:00Z");
  const first = await f.service.runNow("alice", rule.id, "second-day");
  await expect(f.service.runNow("alice", rule.id, "overlap")).rejects.toThrow("proactive_rule_has_active_run");
  expect(f.service.rule("alice", rule.id).activeRun).toBe(first.id);
});

it("deduplicates findings and refuses foreign sources, regressing cursors or malformed output without partial commits", async () => {
  const f = fixture(), rule = await f.service.save("alice", f.input);
  await f.service.runNow("alice", rule.id, "one"); await f.service.tick();
  await f.service.runNow("alice", rule.id, "duplicate"); await f.service.tick();
  expect(f.notifications).toHaveLength(1);
  f.setAnswer({ ...result("2"), sources: [{ sourceId: "foreign", status: "checked", proposedCursor: "200" }] });
  await f.service.runNow("alice", rule.id, "foreign"); await f.service.tick();
  expect(f.service.runs("alice", rule.id)[0]!.status).toBe("failed");
  expect(f.store.get("cursors", `${rule.id}:foreign`)).toBeUndefined();
  f.setAnswer(result("0")); await f.service.runNow("alice", rule.id, "regression"); await f.service.tick();
  expect(f.store.get("cursors", `${rule.id}:gmail`)).toMatchObject({ cursor: "1" });
  expect(f.notifications).toHaveLength(2); // One successful finding and one deduplicated failure notice.
  expect(f.notifications.some(n => n.text === "Report 2" || n.text === "Report 0")).toBe(false);
});

it("pauses before dispatch, gates pending notification during quiet hours, and sends authorization needs once", async () => {
  const f = fixture(), rule = await f.service.save("alice", { ...f.input, quietHours: { start: "09:00", end: "10:00" } });
  const queued = await f.service.runNow("alice", rule.id, "first");
  await f.service.state("alice", rule.id, "paused"); await f.service.tick();
  expect(f.submitted).toHaveLength(0);
  expect(f.service.allows({ kind: "schedule", owner: "alice", agentId: rule.agentId, reference: queued.id, toolGrants: {} })).toBe(false);
  await f.service.state("alice", rule.id, "active"); await f.service.tick(); expect(f.notifications).toHaveLength(0);
  f.setNow("2026-10-29T02:00:00Z"); await f.service.tick(); expect(f.notifications).toHaveLength(1);
  f.setAuthorized(false);
  await f.service.runNow("alice", rule.id, "expired"); await f.service.tick();
  expect(f.service.rule("alice", rule.id).status).toBe("authorization_required");
  expect(f.notifications).toHaveLength(2); await f.service.tick(); expect(f.notifications).toHaveLength(2);
  await expect(f.service.state("alice", rule.id, "active")).rejects.toThrow("proactive_authorization_required");
});

it("daily schedules handle daylight saving gaps and repeated hours once per local date", () => {
  const daily = { schedule: { type: "daily" as const, at: "02:30" }, timeZone: "America/New_York" };
  expect(nextOccurrence(daily, new Date("2026-03-08T05:00:00Z"))).toBe("2026-03-09T06:30:00.000Z");
  const repeat = { schedule: { type: "daily" as const, at: "01:30" }, timeZone: "America/New_York" };
  expect(nextOccurrence(repeat, new Date("2026-11-01T04:00:00Z"))).toBe("2026-11-01T05:30:00.000Z");
  expect(nextOccurrence(repeat, new Date("2026-11-01T05:30:00Z"))).toBe("2026-11-02T06:30:00.000Z");
  expect(inQuietHours({ timeZone: "Asia/Shanghai", quietHours: { start: "22:00", end: "08:00" } }, new Date("2026-10-29T23:00:00Z"))).toBe(true);
});

it("unknown executions are queried without replay and expired running work is cancelled", async () => {
  const f = fixture(), rule = await f.service.save("alice", { ...f.input, timeoutSeconds: 30, notifications: "none" });
  const first = await f.service.runNow("alice", rule.id, "uncertain"); f.lose(); await f.service.tick();
  f.works.set(first.id, { ...f.works.get(first.id)!, outcomeUnknown: true, status: "unknown" }); await f.service.tick();
  expect(f.service.runs("alice", rule.id)[0]!.status).toBe("uncertain");
  f.works.delete(first.id); await f.service.tick(); expect(f.submitted).toHaveLength(1);
  f.works.set(first.id, { eventId: first.id, taskId: "task", sessionId: "session", status: "working", answer: "" });
  f.setNow("2026-10-29T01:01:00Z"); await f.service.tick(); await f.service.tick();
  expect(f.service.runs("alice", rule.id)[0]!.status).toBe("cancelled");
  expect(f.notifications).toHaveLength(0); expect(f.submitted).toHaveLength(1);
});

it("failed sources cannot advance cursors and notification none also suppresses authorization notices", async () => {
  const f = fixture(), rule = await f.service.save("alice", { ...f.input, notifications: "none" });
  f.setAnswer({ ...result(), sources: [{ sourceId: "gmail", status: "failed", proposedCursor: "200" }] });
  await f.service.runNow("alice", rule.id, "failed-source"); await f.service.tick();
  expect(f.store.get("cursors", `${rule.id}:gmail`)).toBeUndefined(); expect(f.notifications).toHaveLength(0);
  f.setAuthorized(false); await f.service.runNow("alice", rule.id, "expired-auth"); await f.service.tick();
  expect(f.service.rule("alice", rule.id).status).toBe("authorization_required"); expect(f.notifications).toHaveLength(0);
});

it("holds unverified cursor proposals and records the missing or rejected source proof", async () => {
  const f = fixture(), rule = await f.service.save("alice", f.input);
  delete f.port.validateCursor;
  f.setAnswer(result("99999999999999999999999999"));
  await f.service.runNow("alice", rule.id, "unverified"); await f.service.tick();
  expect(f.store.get("cursors", `${rule.id}:gmail`)).toBeUndefined();
  expect(f.service.runs("alice", rule.id)[0]!.cursorUpdates).toEqual([{ sourceId: "gmail", cursor: "99999999999999999999999999", status: "unverified" }]);
  f.port.validateCursor = async (_rule, source, cursor) => source === "gmail" && cursor === "2";
  f.setAnswer(result("100")); await f.service.runNow("alice", rule.id, "forged"); await f.service.tick();
  expect(f.store.get("cursors", `${rule.id}:gmail`)).toBeUndefined();
  f.setAnswer(result("2")); await f.service.runNow("alice", rule.id, "verified"); await f.service.tick();
  expect(f.store.get("cursors", `${rule.id}:gmail`)).toEqual({ sourceId: "gmail", cursor: "2" });
});

it("cancels queued work locally and cancels an in-flight submission without creating a replacement", async () => {
  const f = fixture(), rule = await f.service.save("alice", f.input);
  await f.service.runNow("alice", rule.id, "queued"); await f.service.cancel("alice", rule.id); await f.service.tick();
  expect(f.service.runs("alice", rule.id)[0]!.status).toBe("cancelled");
  expect(f.service.rule("alice", rule.id).activeRun).toBeUndefined(); expect(f.submitted).toHaveLength(0);
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { finish = resolve; });
  f.port.submit = async (_rule, input) => {
    f.submitted.push(input); entered(); await blocked;
    const work = { eventId: input.eventId, taskId: "task", sessionId: input.sessionId, status: "working", answer: "" };
    f.works.set(input.eventId, work); return work;
  };
  const trigger = await f.service.runNow("alice", rule.id, "submitting"), tick = f.service.tick();
  await started; await f.service.cancel("alice", rule.id);
  expect(f.service.allows({ kind: "schedule", owner: "alice", agentId: rule.agentId, reference: trigger.id, toolGrants: {} })).toBe(false);
  finish(); await tick; await f.service.tick();
  expect(f.service.runs("alice", rule.id)[0]!.status).toBe("cancelled"); expect(f.submitted).toHaveLength(1); expect(f.notifications).toHaveLength(0);
});

it("records provider notification failure distinctly and does not mint another delivery", async () => {
  const f = fixture(), rule = await f.service.save("alice", f.input);
  let calls = 0;
  f.port.deliver = async () => { calls++; return { status: "failed", error: "provider_rejected" }; };
  await f.service.runNow("alice", rule.id, "notice"); await f.service.tick(); await f.service.tick();
  expect(f.service.notices("alice", rule.id)[0]).toMatchObject({ status: "failed", error: "provider_rejected" });
  expect(calls).toBe(1);
});

it("holds paused delivery after an asynchronous lookup and reconciles notices in their original employee scope", async () => {
  const f = fixture(), rule = await f.service.save("alice", f.input);
  let paused = false;
  f.port.delivery = async () => { if (!paused) { paused = true; await f.service.state("alice", rule.id, "paused"); } return null; };
  await f.service.runNow("alice", rule.id, "pause-while-looking-up"); await f.service.tick();
  expect(f.notifications).toHaveLength(0); expect(f.service.notices("alice", rule.id)[0]!.status).toBe("queued");
  await f.service.save("alice", { ...f.input, agentId: "22222222-2222-4222-8222-222222222222" }, rule.id, rule.version);
  let queriedAgent: string | undefined;
  f.port.delivery = async original => { queriedAgent = original.agentId; return { status: "sent", externalId: "old-receipt" }; };
  await f.service.tick();
  expect(queriedAgent).toBe(rule.agentId); expect(f.notifications).toHaveLength(0);
  expect(f.service.notices("alice", rule.id)[0]).toMatchObject({ status: "sent", externalId: "old-receipt" });
});

it("stores the current rule schema, rejects removed kind fields and reuses the rule session", async () => {
  const f = fixture(), rule = await f.service.save("alice", f.input);
  expect(rule).toMatchObject({ execution: { type: "agent" }, session: { type: "rule" } });
  expect(rule).not.toHaveProperty("kind"); expect(rule).not.toHaveProperty("preset");
  expect(f.store.get("rules", rule.id)).toEqual(rule);
  expect(f.service.rule("alice", rule.id)).toEqual(rule);
  expect(f.service.list("alice")).toEqual([rule]);
  for (const kind of ["schedule", "heartbeat"]) {
    expect(proactiveRuleInput.safeParse({ ...f.input, kind }).success).toBe(false);
    await expect(f.service.save("alice", { ...f.input, kind })).rejects.toThrow();
  }
  await f.service.runNow("alice", rule.id, "rule-1"); await f.service.tick();
  await f.service.runNow("alice", rule.id, "rule-2"); await f.service.tick();
  expect(f.submitted.map(value => value.sessionId)).toEqual([`mau-rule-${rule.id}`, `mau-rule-${rule.id}`]);
  expect(f.submitted[0].input).toContain("saved task. Goal:");
});

it("applies an explicit heartbeat preset at both API and parsed tool entry points while honoring overrides", async () => {
  const f = fixture(), { schedule: _schedule, ...base } = f.input;
  const request = { ...base, preset: "heartbeat" as const };
  expect(heartbeatPreset(request)).toMatchObject({ schedule: { type: "interval", minutes: 30 },
    session: { type: "conversation", sessionId: "owner-main", idleOnly: true }, notifications: "changes" });
  const apiRule = await f.service.save("alice", request);
  expect(apiRule).toMatchObject({ preset: "heartbeat", schedule: { type: "interval", minutes: 30 },
    session: { type: "conversation", sessionId: "owner-main", idleOnly: true }, notifications: "changes" });
  const toolRule = await f.service.save("alice", proactiveRuleInput.parse(request));
  expect(toolRule.schedule).toEqual(apiRule.schedule); expect(toolRule.session).toEqual(apiRule.session);
  const overridden = await f.service.save("alice", { ...request, schedule: { type: "daily", at: "10:00" }, session: { type: "fresh" }, notifications: "none" });
  expect(overridden).toMatchObject({ schedule: { type: "daily", at: "10:00" }, session: { type: "fresh" }, notifications: "none" });
  await expect(f.service.save("alice", base)).rejects.toThrow("task_schedule_required");
});

it("delivers fixed messages without contacting Agent execution and preserves trigger identity, budgets and cancellation", async () => {
  const f = fixture();
  f.port.lookup = f.port.submit = async () => { throw new Error("must_not_contact_agent"); };
  f.port.cancel = async () => { throw new Error("must_not_cancel_agent"); };
  const rule = await f.service.save("alice", { ...f.input, goal: "", connections: [], execution: { type: "direct", message: "Take a break." }, maxRunsPerDay: 2 });
  const trigger = await f.service.runNow("alice", rule.id, "direct-1");
  expect(f.service.allows({ kind: "schedule", owner: "alice", agentId: rule.agentId, reference: trigger.id, toolGrants: {} })).toBe(false);
  await f.service.tick();
  expect(f.service.runs("alice", rule.id)[0]).toMatchObject({ status: "completed", stage: "direct", result: { reason: "direct_message" } });
  expect(f.notifications.map(value => value.text)).toEqual(["Take a break."]);
  expect((await f.service.runNow("alice", rule.id, "direct-1")).id).toBe(trigger.id);
  await f.service.tick(); expect(f.notifications).toHaveLength(1);
  await f.service.runNow("alice", rule.id, "direct-2"); await f.service.cancel("alice", rule.id); await f.service.tick();
  expect(f.service.runs("alice", rule.id)[0]!.status).toBe("cancelled"); expect(f.notifications).toHaveLength(1);
  await expect(f.service.runNow("alice", rule.id, "over-budget")).rejects.toThrow("proactive_daily_budget_exhausted");
  expect(f.submitted).toHaveLength(0);
});

it("reconciles a fixed-message delivery with the original receipt after restart instead of resending", async () => {
  const f = fixture(), rule = await f.service.save("alice", { ...f.input, connections: [], execution: { type: "direct", message: "Reminder" } });
  let deliveries = 0;
  f.port.deliver = async (_rule, input) => { deliveries++; f.deliveries.set(input.eventId, { status: "sent" }); throw new Error("lost_delivery_response"); };
  await f.service.runNow("alice", rule.id, "direct"); await f.service.tick();
  expect(f.service.notices("alice", rule.id)[0]!.status).toBe("queued");
  await f.service.close(); const reopened = new ProactiveWork(f.store, f.port, f.clock);
  await reopened.tick(); expect(deliveries).toBe(1); expect(f.submitted).toHaveLength(0);
  expect(reopened.notices("alice", rule.id)[0]!.status).toBe("sent");
  await reopened.close();
});

it("requires authorization for direct messages and rechecks it before queued notifications are delivered", async () => {
  const f = fixture(), rule = await f.service.save("alice", { ...f.input, connections: [], execution: { type: "direct", message: "Reminder" } });
  let revoke = true;
  f.port.delivery = async () => { if (revoke) { f.setAuthorized(false); revoke = false; } return null; };
  await f.service.runNow("alice", rule.id, "direct"); await f.service.tick();
  expect(f.notifications).toHaveLength(0); expect(f.service.rule("alice", rule.id).status).toBe("authorization_required");
  f.setAuthorized(true); await f.service.state("alice", rule.id, "active"); await f.service.tick();
  expect(f.notifications.map(value => value.text)).toEqual(["Reminder"]); expect(f.submitted).toHaveLength(0);
  f.setAuthorized(false); await f.service.runNow("alice", rule.id, "expired"); await f.service.tick();
  expect(f.notifications.filter(value => value.text === "Reminder")).toHaveLength(1);
  expect(f.service.rule("alice", rule.id).status).toBe("authorization_required");
});

it("uses trusted precheck snapshots to skip unchanged Agent work and advances checkpoints only after successful execution", async () => {
  const f = fixture(), checks: Array<{ eventId: string; previous?: string }> = [];
  f.port.check = async (_rule, input) => { checks.push(input); return { changed: input.previous !== "snapshot-1", checkpoint: "snapshot-1" }; };
  const rule = await f.service.save("alice", { ...f.input, precheck: { connectionId: "gmail", tool: "messages.list", arguments: { limit: 5 } } });
  f.setAnswer({ ...result(), sources: [{ sourceId: "gmail", status: "failed" }] });
  await f.service.runNow("alice", rule.id, "source-failed"); await f.service.tick();
  expect(f.store.get("precheck_checkpoints", rule.id)).toBeUndefined();
  f.setAnswer(result()); await f.service.runNow("alice", rule.id, "success"); await f.service.tick();
  expect(checks[1]!.previous).toBeUndefined();
  expect(f.store.get("precheck_checkpoints", rule.id)).toMatchObject({ checkpoint: "snapshot-1" });
  await f.service.runNow("alice", rule.id, "unchanged"); await f.service.tick();
  expect(checks[2]!.previous).toBe("snapshot-1"); expect(f.submitted).toHaveLength(2);
  expect(f.service.runs("alice", rule.id)[0]).toMatchObject({ status: "completed", result: { decision: "quiet", reason: "precheck_unchanged" } });
  expect(f.submitted[1].context.precheck).toMatchObject({ connectionId: "gmail", tool: "messages.list", checkpoint: "snapshot-1" });
  await expect(f.service.save("alice", { ...f.input, precheck: { connectionId: "foreign", tool: "read", arguments: {} } })).rejects.toThrow("precheck_source_not_granted");
  await expect(f.service.save("alice", { ...f.input, operations: ["messages.get"], precheck: { connectionId: "gmail", tool: "messages.list", arguments: {} } })).rejects.toThrow("precheck_source_not_granted");
});

it("never treats failed or unknown prechecks as unchanged and never replays a check interrupted by restart", async () => {
  const f = fixture(), rule = await f.service.save("alice", { ...f.input, notifications: "none", precheck: { connectionId: "gmail", tool: "messages.list", arguments: {} } });
  let checks = 0;
  f.port.check = async () => { checks++; throw new Error("provider_failed"); };
  await f.service.runNow("alice", rule.id, "failed"); await f.service.tick();
  expect(f.service.runs("alice", rule.id)[0]).toMatchObject({ status: "failed", error: "precheck_failed" });
  f.port.check = async () => { checks++; return { changed: false, checkpoint: "invented-baseline" }; };
  await f.service.runNow("alice", rule.id, "invalid"); await f.service.tick();
  expect(f.service.runs("alice", rule.id)[0]).toMatchObject({ status: "failed", error: "precheck_checkpoint_mismatch" });
  const interrupted = await f.service.runNow("alice", rule.id, "interrupted");
  f.store.set("triggers", interrupted.id, { ...interrupted, status: "checking", stage: "precheck" });
  await f.service.close(); const reopened = new ProactiveWork(f.store, f.port, f.clock);
  await reopened.tick(); await reopened.tick();
  expect(reopened.runs("alice", rule.id)[0]).toMatchObject({ status: "uncertain", error: "precheck_outcome_unknown" });
  expect(checks).toBe(2); expect(f.submitted).toHaveLength(0); expect(f.notifications).toHaveLength(0);
  f.port.lookup = async () => { throw new Error("must_not_contact_host"); };
  await reopened.cancel("alice", rule.id); expect(reopened.runs("alice", rule.id)[0]!.status).toBe("cancelled");
  await reopened.close();
});

it("keeps cancellation authoritative across authorization and connector checks without waking Agent execution", async () => {
  const f = fixture(), rule = await f.service.save("alice", { ...f.input, execution: { type: "direct", message: "Should not send" },
    precheck: { connectionId: "gmail", tool: "messages.list", arguments: {} } });
  let checks = 0;
  f.port.check = async () => { checks++; return { changed: true, checkpoint: "one" }; };
  f.port.authorized = async () => { await f.service.cancel("alice", rule.id); return true; };
  await f.service.runNow("alice", rule.id, "cancel-during-authorization"); await f.service.tick();
  expect(checks).toBe(0); expect(f.service.runs("alice", rule.id)[0]!.status).toBe("cancelled");
  f.port.authorized = async () => true;
  f.port.check = async () => { checks++; await f.service.cancel("alice", rule.id); return { changed: true, checkpoint: "one" }; };
  await f.service.runNow("alice", rule.id, "cancel-during-check"); await f.service.tick();
  expect(checks).toBe(1); expect(f.service.runs("alice", rule.id)[0]!.status).toBe("cancelled");
  expect(f.notifications).toHaveLength(0); expect(f.submitted).toHaveLength(0); expect(f.store.get("precheck_checkpoints", rule.id)).toBeUndefined();
});

it("chooses stable per-occurrence sessions and queues explicit conversation work until the conversation is idle", async () => {
  const f = fixture(), fresh = await f.service.save("alice", { ...f.input, session: { type: "fresh" } });
  const first = await f.service.runNow("alice", fresh.id, "fresh-1"); await f.service.tick();
  const second = await f.service.runNow("alice", fresh.id, "fresh-2"); await f.service.tick();
  expect(f.submitted[0].sessionId).toBe(`mau-run-${first.id}`); expect(f.submitted[1].sessionId).toBe(`mau-run-${second.id}`);
  const conversation = await f.service.save("alice", { ...f.input, session: { type: "conversation", sessionId: "explicit-conversation" } });
  expect(conversation.session).toMatchObject({ type: "conversation", idleOnly: true });
  let state: "busy" | "unknown" | "idle" = "busy";
  f.port.sessionState = async (_rule, id) => { expect(id).toBe("explicit-conversation"); return state; };
  await f.service.runNow("alice", conversation.id, "conversation"); await f.service.tick();
  expect(f.submitted).toHaveLength(2); expect(f.service.runs("alice", conversation.id)[0]).toMatchObject({ status: "queued", error: "scheduled_session_busy" });
  state = "unknown"; await f.service.tick(); expect(f.submitted).toHaveLength(2);
  const submit = f.port.submit; let race = true;
  f.port.submit = async (rule, input) => { if (race) { race = false; throw new RouterError("scheduled_session_busy", 409); } return submit(rule, input); };
  state = "idle"; await f.service.tick(); expect(f.submitted).toHaveLength(2);
  expect(f.service.runs("alice", conversation.id)[0]!.status).toBe("queued");
  await f.service.tick(); expect(f.submitted.at(-1)).toMatchObject({ sessionId: "explicit-conversation", idleOnly: true });
});

it("does not resubmit a missing receipt after an ambiguous Agent submission", async () => {
  const f = fixture(), rule = await f.service.save("alice", { ...f.input, notifications: "none", session: { type: "fresh" } });
  f.port.submit = async (_rule, input) => { f.submitted.push(input); throw new Error("submission_outcome_unknown"); };
  const trigger = await f.service.runNow("alice", rule.id, "unknown"); await f.service.tick();
  await f.service.close(); const reopened = new ProactiveWork(f.store, f.port, f.clock);
  await reopened.tick(); await reopened.tick();
  expect(f.submitted).toHaveLength(1); expect(f.submitted[0].sessionId).toBe(`mau-run-${trigger.id}`);
  expect(reopened.runs("alice", rule.id)[0]).toMatchObject({ status: "uncertain", error: "execution_submission_unknown" });
  await reopened.close();
});

it("does not resurrect a cancelled task when an in-flight conversation check reports busy", async () => {
  const f = fixture(), rule = await f.service.save("alice", { ...f.input, session: { type: "conversation", sessionId: "owner-main" } });
  f.port.sessionState = async () => { await f.service.cancel("alice", rule.id); return "busy"; };
  await f.service.runNow("alice", rule.id, "cancel"); await f.service.tick(); await f.service.tick();
  expect(f.service.runs("alice", rule.id)[0]).toMatchObject({ status: "cancelled", cancellationRequested: true });
  expect(f.submitted).toHaveLength(0); expect(f.service.rule("alice", rule.id).activeRun).toBeUndefined();
});
