import { createHash } from "node:crypto";
import { z } from "zod";
import type { WorkSessions } from "@agent-router/server";
import type { EmployeeTools } from "./business-tools.js";
import type { RunAdmission } from "./run-admission.js";
import { EmployeeContext, MemoryError, memoryInput, memoryToolSchema } from "./employee-context.js";
import { historyQuery, type SessionHistory } from "./session-history.js";
import { ConnectedApps } from "./connected-apps.js";
import { ProactiveWork, proactiveRuleInput } from "./proactive.js";

const sessionInput = z.object({
  action: z.enum(["list", "read", "history", "create", "send", "fork", "rename", "archive", "unarchive", "steer", "wait", "cancel"]),
  sessionId: z.string().max(160).optional(), targetSessionId: z.string().max(160).optional(),
  input: z.string().max(24000).optional(), name: z.string().max(200).optional(),
  eventId: z.string().max(160).optional(), eventIds: z.array(z.string().max(160)).max(8).optional(),
  cursor: z.string().max(10000).optional(), limit: z.number().int().min(1).max(1000).optional(),
  after: z.string().max(1000).optional(), timeoutMs: z.number().int().min(0).max(30000).optional(),
}).strict();
const proactiveInput = z.object({ action: z.enum(["list", "create", "update", "runs", "pause", "resume", "run"]), ruleId: z.uuid().optional(),
  expectedVersion: z.number().int().positive().optional(), rule: proactiveRuleInput.omit({ agentId: true }).optional() }).strict();
const required = (value: string | undefined, name: string) => { if (!value) throw new Error(`${name}_required`); return value; };

/** Product tools compose native operations; no model argument may choose owner, Host or runtime. */
export class NativeEmployeeTools implements EmployeeTools {
  readonly definitions;
  constructor(private readonly owner: string, private readonly agentId: string,
    private readonly sessions: () => Promise<WorkSessions>, private readonly facts: EmployeeContext,
    private readonly apps: ConnectedApps, private readonly proactive: ProactiveWork, private readonly enabled: boolean,
    private readonly options: { history?: Pick<SessionHistory, "search">; isMemoryReview?: (admission: RunAdmission) => boolean;
      reminders?: (admission: RunAdmission, sessionId: string) => string } = {}) {
    this.definitions = enabled ? [
      { name: "work_sessions", description: "Manage this employee's work sessions. Create independent work, read native history, send follow-up work, wait for changes, steer or cancel a known task. Return event IDs for later inspection. Delegated work keeps its own session and tools; sending a message is not new human authorization.", inputSchema: z.toJSONSchema(sessionInput), timeoutMs: 60_000 },
      { name: "employee_memory", description: "Maintain concise durable notes: memory (MEMORY.md, 2200 Unicode characters) for reusable knowledge, user (USER.md, 1375) for user preferences and profile. Read, add, replace or remove entries; batch operations on one file are atomic. add requires content, replace requires old_text and content, remove requires old_text, batch requires operations. old_text must uniquely identify an entry by exact literal text; replace replaces the WHOLE entry. Duplicate writes are rejected. Do not store secrets, transient task progress or instructions that override safety. Free space with remove/replace when full. Writes are autonomous unless staged for owner approval. The current session's initial snapshot stays frozen; updates load in new sessions.", inputSchema: memoryToolSchema, timeoutMs: 10_000 },
      { name: "session_search", description: "Search original stored conversation text for this employee. Returns exact text excerpts, session IDs and coverage; this is separate from curated memory and may not include older native history until explicitly imported.", inputSchema: z.toJSONSchema(historyQuery), timeoutMs: 10_000 },
      { name: "proactive_work", description: "Create, inspect, edit, pause, resume or run a proactive rule for this employee only when requested by the owner. Show the concrete goal, schedule, time zone, sources and notification destination. Source grants remain limited to the employee's assigned connections. New rules default paused; explicitly requested activation uses status=active. Saving a rule never grants new account access.", inputSchema: z.toJSONSchema(proactiveInput), timeoutMs: 60_000 },
    ] : [];
  }
  context(admission: RunAdmission, _input = "", sessionKey?: string) {
    if (!this.enabled || admission.owner !== this.owner || admission.agentId !== this.agentId || admission.kind === "schedule" || !sessionKey) return undefined;
    return this.facts.snapshot(this.owner, this.agentId, sessionKey);
  }
  scheduledContext(admission: RunAdmission) {
    if (!this.enabled || admission.owner !== this.owner || admission.agentId !== this.agentId || admission.kind !== "schedule") return undefined;
    return this.facts.scheduledContext(this.owner, this.agentId);
  }
  reminders(admission: RunAdmission, sessionId: string) {
    if (!this.enabled || admission.owner !== this.owner || admission.agentId !== this.agentId || admission.kind !== "owner") return "";
    return this.options.reminders?.(admission, sessionId) ?? "";
  }
  async execute(name: string, raw: unknown, admission: RunAdmission, callId: string, runId: string): Promise<unknown> {
    if (!this.enabled || admission.owner !== this.owner || admission.agentId !== this.agentId || admission.kind === "schedule") throw new Error("employee_tool_not_authorized");
    const review = this.options.isMemoryReview?.(admission) ?? false;
    if (review && name !== "employee_memory") throw new Error("memory_review_tool_not_authorized");
    if (name === "employee_memory") {
      try {
        const input = memoryInput.parse(raw);
        if (input.action === "read") {
          const data = this.facts.read(this.owner, this.agentId);
          return { ...data, files: input.target ? data.files.filter(file => file.target === input.target) : data.files };
        }
        return this.facts.mutate(this.owner, this.agentId, input, { origin: review ? "review" : admission.kind });
      } catch (error) {
        if (error instanceof MemoryError) {
          let live: unknown; try { live = this.facts.read(this.owner, this.agentId).files; } catch { /* Preserve the original fail-closed error. */ }
          return { isError: true, error: error.message, ...error.details, ...(live ? { files: live } : {}) };
        }
        if (error instanceof z.ZodError) return { isError: true, error: "memory_invalid_input", issues: error.issues };
        throw error;
      }
    }
    if (name === "session_search") {
      if (!this.options.history) throw new Error("session_search_unavailable");
      return this.options.history.search(this.owner, this.agentId, historyQuery.parse(raw));
    }
    const eventId = `mau-tool-${createHash("sha256").update(JSON.stringify([this.owner, this.agentId, admission.reference, callId])).digest("hex")}`;
    if (name === "proactive_work") {
      const input = proactiveInput.parse(raw);
      if (admission.kind !== "owner" && !["list", "runs"].includes(input.action)) throw new Error("proactive_owner_admission_required");
      if (input.action === "list") return { rules: this.proactive.list(this.owner).filter(r => r.agentId === this.agentId) };
      if (input.action === "create") {
        if (!input.rule) throw new Error("rule_required");
        return this.proactive.save(this.owner, { ...input.rule, agentId: this.agentId });
      }
      const id = required(input.ruleId, "rule_id"), rule = this.proactive.rule(this.owner, id);
      if (rule.agentId !== this.agentId) throw new Error("employee_tool_not_authorized");
      if (input.action === "update") {
        if (!input.rule || !input.expectedVersion) throw new Error("rule_and_version_required");
        return this.proactive.save(this.owner, { ...input.rule, agentId: this.agentId }, id, input.expectedVersion);
      }
      if (input.action === "runs") return { runs: this.proactive.runs(this.owner, id) };
      if (input.action === "run") return this.proactive.runNow(this.owner, id, eventId);
      return this.proactive.state(this.owner, id, input.action === "pause" ? "paused" : "active");
    }
    if (name !== "work_sessions") throw new Error("employee_tool_unknown");
    const input = sessionInput.parse(raw), sessions = await this.sessions();
    if (input.action === "list") return { data: sessions.list() };
    if (input.action === "wait") return sessions.wait(input.eventIds ?? [], {
      waitingRunId: runId, waitingReference: admission.reference, waitingCallId: callId,
      ...(input.after ? { after: input.after } : {}), ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}) });
    if (input.action === "cancel") return sessions.cancel(required(input.eventId, "event_id"));
    if (input.action === "create" || input.action === "send") {
      if (input.action === "send") sessions.getSession(required(input.sessionId, "session_id"));
      return sessions.submit({ eventId, ...(input.action === "send" ? { sessionId: input.sessionId! } : {}),
        input: required(input.input, "input"), context: { source: "delegated_work", parentReference: admission.reference, callId },
        admission: { kind: "delegation", owner: this.owner, agentId: this.agentId, reference: callId,
          toolGrants: admission.toolGrants ?? { business: true, feishu: true,
            connectedApps: { connections: this.apps.connections(this.agentId, this.owner) } },
          ...(admission.expiresAt ? { expiresAt: admission.expiresAt } : {}),
          ...(admission.maxToolCalls ? { maxToolCalls: admission.maxToolCalls } : {}) } });
    }
    const id = required(input.sessionId, "session_id");
    if (input.action === "read") return sessions.read(id);
    if (input.action === "history") return sessions.history(id, { ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.limit ? { limit: input.limit } : {}) });
    if (input.action === "fork") return sessions.fork(id, required(input.targetSessionId, "target_session_id"));
    if (input.action === "steer") {
      if (admission.kind !== "owner") throw new Error("steer_owner_admission_required");
      await sessions.steer(id, required(input.input, "input")); return { status: "accepted" };
    }
    return sessions.native(id, { action: input.action, ...(input.action === "rename" ? { name: required(input.name, "name") } : {}) });
  }
}
