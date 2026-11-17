import { createHash } from "node:crypto";
import { z } from "zod";
import type { HostCall } from "@agent-router/server";
import type { DurableStore } from "./store.js";
import type { OperationView } from "./connector-accounts.js";
import { browserToolName } from "./connected-apps.js";

/** Trusted approval presenter: the authority key stays in Mau; Router only renders the card. */
export interface ApprovalPort {
  operation(id: string): Promise<OperationView | undefined>;
  approve(owner: string, id: string, digest: string): Promise<{ outcome?: Record<string, unknown>; refused?: string }>;
  deny(id: string): Promise<{ refused?: string }>;
}
/**
 * Where the owner is asked when the run that needs the approval has no owner conversation of its own: a card in
 * another conversation, which belongs to no run. `open` throws when there is nowhere to ask.
 */
export interface ApprovalDesk {
  open(card: { id: string; summary: string; connection: string; arguments: unknown; deadlineAt: string }): Promise<void>;
  status(id: string): Promise<"pending" | "approved" | "denied" | "expired">;
  withdraw(id: string): Promise<void>;
}
export const APPROVAL_PREFIX = "mau-approval:";
const collection = "connector_approvals";
type Phase = "pending" | "approved" | "denied" | "expired" | "resolving" | "settled";
interface ApprovalRecord {
  status: Phase;
  runId: string; callId: string; owner: string; agentId: string;
  /** Connector tool name the model asked connected_apps to call (`<connection>__<tool>`). */
  name: string; connections: string[];
  operationId: string; digest: string; inputDigest: string;
  summary: string; card: unknown; deadlineAt: string;
  /** The card is at a desk under this id instead of being a card of the run. */
  desk?: string;
  outcome?: unknown;
}
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const inputDigest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
/** Key arguments for the card; large payloads (file bytes) are summarized, never shown in chat. */
const brief = (value: unknown, depth = 0): unknown => {
  if (typeof value === "string") return value.length > 500 ? `<${value.length} characters>` : value;
  if (Array.isArray(value)) return depth > 3 ? `<${value.length} items>` : value.slice(0, 20).map(item => brief(item, depth + 1));
  if (value && typeof value === "object")
    return depth > 3 ? "<object>" : Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) =>
      [key, key === "contentBase64" && typeof item === "string" ? `<${Math.floor(item.length * 3 / 4)} bytes>` : brief(item, depth + 1)]));
  return value;
};
const denied = (record: ApprovalRecord, reason?: string) => ({ status: "failed", error: "owner_denied", operationId: record.operationId,
  ...(reason ? { reason } : {}), instruction: "The owner did not approve this operation. Do not retry it or ask for approval in chat." });
const deskId = (key: string) => `partner-approval-${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;

/**
 * A run ended: the desk cards it left unanswered are withdrawn and their operations denied. A card of a run needs
 * no such step, because Router closes the cards of a run that ended.
 */
export async function closeRunApprovals(store: DurableStore, port: ApprovalPort, agentId: string, runId: string, withdraw: (deskId: string) => Promise<void>) {
  for (const { id, value } of store.entriesByStatus<ApprovalRecord>(collection, ["pending"])) {
    if (value.agentId !== agentId || value.runId !== runId || !value.desk) continue;
    const closed = store.transaction(() => {
      if (store.get<ApprovalRecord>(collection, id)?.status !== "pending") return false;
      store.set(collection, id, { ...value, status: "settled", outcome: denied(value, "run_ended") }); return true;
    });
    if (!closed) continue;
    await withdraw(value.desk).catch(() => undefined);
    await port.deny(value.operationId).catch(() => undefined);
  }
}

export class ConnectorApprovals {
  private readonly settling = new Map<string, Promise<void>>();
  constructor(private readonly store: DurableStore, private readonly scope: string, private readonly port: ApprovalPort,
    private readonly finish: (record: ApprovalRecord, outcome: unknown) => Promise<void>) {}
  private key(runId: string, callId: string) { return `${this.scope}:${runId}:${callId}`; }
  /**
   * A write returned approval_required. Bind the card to the connector's own view of the operation
   * (owner, Agent, tool, digest) so a later approval signs exactly what the owner saw.
   */
  async request(call: HostCall, name: string, principal: { owner: string; agentId: string; connections: string[] }, pending: { operationId: string; expiresAt?: string | undefined },
    desk?: ApprovalDesk) {
    const key = this.key(call.runId, call.id), prior = this.store.get<ApprovalRecord>(collection, key);
    if (prior) return prior.status === "settled" ? { settled: true as const } : { pending: true as const };
    const view = await this.port.operation(pending.operationId);
    if (!view || view.id !== pending.operationId || view.owner !== principal.owner || view.agentId !== principal.agentId || view.status !== "pending" ||
      !principal.connections.includes(view.connectionId) || browserToolName(view.connectionId, view.tool) !== name) {
      if (view?.status === "pending") await this.port.deny(pending.operationId).catch(() => undefined);
      return { result: { status: "failed", error: "operation_unverifiable", operationId: pending.operationId } };
    }
    const deadlines = [view.expiresAt, call.deadlineAt, pending.expiresAt].map(value => Date.parse(value ?? "")).filter(Number.isFinite);
    const deadlineAt = new Date(Math.min(...deadlines)).toISOString();
    const record: ApprovalRecord = { status: "pending", runId: call.runId, callId: call.id, owner: principal.owner, agentId: principal.agentId,
      name, connections: principal.connections, operationId: view.id, digest: view.digest, inputDigest: inputDigest(view.input),
      summary: view.summary, deadlineAt,
      // question/input feed Router's chat card; tool (title) and choices feed the web console's approval view.
      card: { question: view.summary, tool: view.summary, choices: ["once", "deny"],
        input: { tool: name, connection: view.connectionId, arguments: brief(view.input) } } };
    if (desk) record.desk = deskId(key);
    // The record comes first: a card without one would be a question nobody reads the answer to.
    if (!this.store.insert(collection, key, record) || !desk) return { pending: true as const };
    // Nowhere to ask is a refusal now, never a call left waiting.
    try { await desk.open({ id: record.desk!, summary: view.summary, connection: view.connectionId, arguments: brief(view.input), deadlineAt }); }
    catch {
      this.store.delete(collection, key);
      await this.port.deny(pending.operationId).catch(() => undefined);
      return { result: { status: "failed", error: "owner_approval_unavailable", operationId: pending.operationId,
        instruction: "The owner could not be asked in the conversation this work came from, so the operation was not run. Do not retry it; say so in your answer." } };
    }
    return { pending: true as const };
  }
  private records(runId: string) {
    const prefix = `${this.scope}:${runId}:`;
    return this.store.entriesByStatus<ApprovalRecord>(collection, ["pending", "approved", "denied", "expired", "resolving"])
      .filter(entry => entry.id.startsWith(prefix));
  }
  /**
   * Cards for this run, plus settlement of decided ones. Synthetic IDs are never sent to Host. A record whose card is
   * at a desk gets no card here: its answer is read from the desk, and the card is withdrawn when the call is gone.
   */
  async synthetic(runId: string, hostCalls: HostCall[], desk?: ApprovalDesk): Promise<HostCall[]> {
    const cards: HostCall[] = [];
    for (const { id, value } of this.records(runId)) {
      let record = value;
      if (record.status === "pending") {
        const live = hostCalls.some(call => call.id === record.callId && call.status === "pending");
        if (!live || Date.parse(record.deadlineAt) <= Date.now()) {
          record = this.transition(id, "pending", "expired") ?? this.store.get<ApprovalRecord>(collection, id)!;
          if (record.desk && record.status === "expired") await desk?.withdraw(record.desk).catch(() => undefined);
        } else if (record.desk) {
          // An unreachable desk is asked again on the next poll; the deadline above still ends the wait.
          const answer = desk ? await desk.status(record.desk).catch(() => "pending" as const) : "expired";
          if (answer !== "pending") record = this.transition(id, "pending", answer) ?? this.store.get<ApprovalRecord>(collection, id)!;
        }
      }
      if (record.status === "pending") {
        if (record.desk) continue;
        cards.push({ id: APPROVAL_PREFIX + record.callId, runId, kind: "interaction", name: "approval", input: record.card,
          status: "pending", deadlineAt: record.deadlineAt });
        continue;
      }
      // An unreachable connector leaves the record decided; the next poll retries.
      await this.settle(id).catch(() => undefined);
    }
    return cards;
  }
  /** The owner's choice from Router's card. Unknown, decided or expired cards are ignored. */
  async decide(runId: string, syntheticId: string, result: unknown) {
    const callId = syntheticId.slice(APPROVAL_PREFIX.length), id = this.key(runId, callId);
    const choice = z.object({ choice: z.enum(["once", "deny"]) }).passthrough().safeParse(result).data?.choice ?? "deny";
    const record = this.store.get<ApprovalRecord>(collection, id);
    if (!record) throw new Error("approval_not_found");
    if (record.status === "pending")
      this.transition(id, "pending", Date.parse(record.deadlineAt) <= Date.now() ? "expired" : choice === "once" ? "approved" : "denied");
    // Settlement runs outside Router's input handling; calls() awaits it on the next poll.
    void this.settle(id).catch(() => undefined);
  }
  async waitFor(runId: string) {
    const prefix = `${this.scope}:${runId}:`;
    await Promise.all([...this.settling].filter(([id]) => id.startsWith(prefix)).map(([, work]) => work));
  }
  private transition(id: string, from: Phase, to: Phase, patch: Partial<ApprovalRecord> = {}) {
    return this.store.transaction(() => {
      const current = this.store.get<ApprovalRecord>(collection, id);
      if (current?.status !== from) return undefined;
      const next = { ...current, ...patch, status: to };
      this.store.set(collection, id, next);
      return next;
    });
  }
  private settle(id: string): Promise<void> {
    let work = this.settling.get(id);
    if (!work) {
      work = this.settleOnce(id).finally(() => this.settling.delete(id));
      this.settling.set(id, work);
    }
    return work;
  }
  private async settleOnce(id: string) {
    let record = this.store.get<ApprovalRecord>(collection, id);
    if (!record || record.status === "pending" || record.status === "settled") return;
    if (record.status !== "resolving") {
      const outcome = await this.outcome(record);
      if (outcome === undefined) return; // Outcome not known yet; retried on the next poll.
      record = this.transition(id, record.status, "resolving", { outcome });
      if (!record) return;
    }
    await this.finish(record, record.outcome);
    this.transition(id, "resolving", "settled");
  }
  /** Single execution is enforced upstream (pending -> executing once); Mau re-reads the view instead of guessing. */
  private async outcome(record: ApprovalRecord): Promise<unknown> {
    const view = await this.port.operation(record.operationId);
    if (record.status !== "approved") {
      if (view?.status === "pending") await this.port.deny(record.operationId);
      return denied(record, record.status === "expired" ? "approval_expired" : undefined);
    }
    if (!view) return { status: "failed", error: "operation_not_found", operationId: record.operationId };
    if (view.digest !== record.digest || inputDigest(view.input) !== record.inputDigest || view.owner !== record.owner ||
      view.agentId !== record.agentId || browserToolName(view.connectionId, view.tool) !== record.name) {
      if (view.status === "pending") await this.port.deny(record.operationId).catch(() => undefined);
      return { status: "failed", error: "operation_changed", operationId: record.operationId };
    }
    const terminal = (current: OperationView) => current.status === "completed" || current.status === "failed" || current.status === "uncertain"
      ? current.outcome ?? { status: current.status, operationId: current.id }
      : current.status === "denied" || current.status === "expired" ? denied(record, current.status === "expired" ? "approval_expired" : undefined) : undefined;
    if (view.status !== "pending") return terminal(view) ?? this.unknownAfterDeadline(record);
    try {
      const approved = await this.port.approve(record.owner, record.operationId, record.digest);
      if (approved.outcome) return approved.outcome;
    } catch { /* The approval may have executed; read the authoritative state below. */ }
    const after = await this.port.operation(record.operationId).catch(() => undefined);
    return (after && terminal(after)) ?? this.unknownAfterDeadline(record);
  }
  private unknownAfterDeadline(record: ApprovalRecord) {
    // Executing or unreachable: keep polling while the tool call can still be answered.
    return Date.parse(record.deadlineAt) + 300_000 <= Date.now()
      ? { status: "uncertain", error: "approval_outcome_unknown", operationId: record.operationId,
        instruction: "The approved operation may have run. Check it with operation_status before any retry." } : undefined;
  }
}
