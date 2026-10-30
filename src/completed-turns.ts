import type { WorkSessions } from "@agent-router/server";
import type { CompletedEmployeeTurn } from "./business-tools.js";
import { DurableStore } from "./store.js";
import { SessionHistory } from "./session-history.js";
import { MemoryReviewCoordinator } from "./memory-review.js";

type Record = CompletedEmployeeTurn & { status: "queued" | "completed" };
/** Durable bookkeeping queue: resolving public session identity never delays a foreground turn. */
export class CompletedTurns {
  private timer?: ReturnType<typeof setInterval>;
  private pending: Promise<void> | undefined;
  private closed = false;
  constructor(private store: DurableStore, private history: SessionHistory, private reviews: MemoryReviewCoordinator,
    private sessions: (owner: string, agentId: string) => Promise<WorkSessions>, private memoryEnabled: boolean) {}
  enqueue(turn: CompletedEmployeeTurn) {
    if (turn.admission.kind === "schedule") return;
    this.store.insert("employee_completed_turns", JSON.stringify([turn.admission.owner, turn.admission.agentId, turn.runId]), { ...turn, status: "queued" });
  }
  publicSession(owner: string, agentId: string, hostSessionId: string) {
    return this.store.get<string>("employee_session_aliases", JSON.stringify([owner, agentId, hostSessionId]));
  }
  start() { this.timer = setInterval(() => { void this.tick(); }, 1000); this.timer.unref(); void this.tick(); }
  async tick() {
    if (this.closed) return;
    if (this.pending) return this.pending;
    this.pending = this.drain().finally(() => { this.pending = undefined; }); return this.pending;
  }
  private async drain() {
    for (const { id, value: turn } of this.store.entriesByStatus<Record>("employee_completed_turns", ["queued"]).slice(0, 100)) {
      if (this.closed) return;
      try {
        const { owner, agentId } = turn.admission, work = await this.sessions(owner, agentId);
        const sessionId = work.list().find(session => session.runs.some(run => run.runId === turn.runId))?.sessionId;
        if (!sessionId) continue;
        this.store.set("employee_session_aliases", JSON.stringify([owner, agentId, turn.sessionId]), sessionId);
        this.history.append(owner, agentId, sessionId, `${turn.runId}:${turn.inputRole ?? "user"}`, turn.input);
        this.history.append(owner, agentId, sessionId, `${turn.runId}:assistant`, turn.answer);
        if (this.memoryEnabled) this.reviews.completed({ owner, agentId, sessionId, runId: turn.runId,
          origin: turn.admission.kind, status: "completed", memoryAvailable: true });
        this.store.set("employee_completed_turns", id, { ...turn, status: "completed" });
      } catch { /* Retain the durable queue for retry; never fail the owner turn. */ }
    }
  }
  async close() { this.closed = true; if (this.timer) clearInterval(this.timer); await this.pending; }
}
