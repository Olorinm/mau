import type { WorkSessions } from "@agent-router/server";
import { z } from "zod";
import { DurableStore } from "./store.js";

export interface NativeRelayEmployee { agentId: string; owner: string; operationId: string; runtimeId: string }
/** Read access to one employee's Host. Implementations must not extend the environment idle window. */
export interface NativeRelayHost {
  nativeEvents(runtimeId: string, after?: number, limit?: number, epoch?: string): Promise<unknown>;
  nativeSessions(input: { runtimeId: string; action: "bindings" }): Promise<unknown>;
  events(runId: string, after: number, limit?: number): Promise<{ events: Array<{ event: Record<string, unknown> }>; cursor: number; hasMore: boolean }>;
}
export interface NativeRelayPort {
  employees(): NativeRelayEmployee[];
  host(employee: NativeRelayEmployee): NativeRelayHost;
  sessions(owner: string, agentId: string): Promise<WorkSessions>;
  /** Public Router session for a Host session, known after its first completed owner turn. */
  publicSession(owner: string, agentId: string, hostSessionId: string): string | undefined;
  touch(agentId: string): void;
  record?(owner: string, agentId: string, sessionId: string, source: string, text: string): void;
}
export interface NativeRelayOptions { intervalMs?: number; keepAliveMs?: number; clock?: () => number }

const page = z.object({
  epoch: z.string(), cursor: z.number().int().nonnegative(), hasMore: z.boolean(), historyTruncated: z.boolean().optional(),
  events: z.array(z.object({ sequence: z.number().int(), event: z.record(z.string(), z.unknown()) }).passthrough()),
}).passthrough();
const turnSchema = z.object({ id: z.string().min(1), status: z.string().optional(),
  items: z.array(z.record(z.string(), z.unknown())).default([]) }).passthrough();
interface Turn { agentId: string; owner: string; sessionId: string; threadId: string; turnId: string; text: string;
  status: "queued" | "delivered" | "managed" | "empty" | "failed"; attempts: number }
interface Live { threads: Map<string, { sessionId: string | null; checkedAt: number }>; active: Set<string>; activeSince?: number }

/**
 * Delivers Codex turns that Router did not start (a root woken by its subagent's result) to the
 * owner's private conversation, and keeps the environment awake while native threads still run.
 */
export class NativeRelay {
  private timer?: ReturnType<typeof setInterval>;
  private pending: Promise<void> | undefined;
  private closed = false;
  private readonly live = new Map<string, Live>();
  private readonly clock: () => number;
  constructor(private readonly store: DurableStore, private readonly port: NativeRelayPort, private readonly options: NativeRelayOptions = {}) {
    this.clock = options.clock ?? Date.now;
  }
  start() { this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs ?? 2000); this.timer.unref(); void this.tick(); }
  async tick() {
    if (this.closed) return;
    if (this.pending) return this.pending;
    this.pending = this.run().finally(() => { this.pending = undefined; }); return this.pending;
  }
  async close() { this.closed = true; if (this.timer) clearInterval(this.timer); await this.pending; }
  private async run() {
    const employees = this.port.employees();
    for (const employee of employees) {
      if (this.closed) return;
      // Sleeping or unreachable environments are retried next tick; stale activity never keeps them awake.
      try { await this.poll(employee); } catch { this.live.delete(employee.agentId); }
      this.keepAlive(employee.agentId);
    }
    for (const id of this.live.keys()) if (!employees.some(e => e.agentId === id)) this.live.delete(id);
    await this.drain();
  }
  private state(agentId: string) {
    let live = this.live.get(agentId);
    if (!live) { live = { threads: new Map(), active: new Set() }; this.live.set(agentId, live); }
    return live;
  }
  private async poll(employee: NativeRelayEmployee) {
    const host = this.port.host(employee), key = employee.agentId;
    const saved = this.store.get<{ epoch: string; cursor: number }>("native_relay_cursors", key);
    let current;
    try { current = page.parse(await host.nativeEvents(employee.runtimeId, saved?.cursor ?? 0, 200, saved?.epoch)); }
    catch (error) {
      // A restarted Host has a new log; never replay it. Begin again from its current end.
      if (/native_event_epoch_changed|invalid_native_event_cursor/.test(String(error instanceof Error ? error.message : error))) {
        this.store.delete("native_relay_cursors", key); this.live.delete(key);
      }
      throw error;
    }
    const replaying = !saved || saved.epoch !== current.epoch || Boolean(current.historyTruncated);
    if (replaying) this.live.delete(key);
    for (let pages = 0; ; pages++) {
      for (const { event } of current.events) await this.observe(employee, event, replaying);
      this.store.set("native_relay_cursors", key, { epoch: current.epoch, cursor: current.cursor });
      if (!current.hasMore || pages >= 20 || this.closed) break;
      current = page.parse(await host.nativeEvents(employee.runtimeId, current.cursor, 200, current.epoch));
    }
  }
  private async observe(employee: NativeRelayEmployee, event: Record<string, unknown>, replaying: boolean) {
    if (event.type !== "notification") return;
    const params = z.record(z.string(), z.unknown()).catch({}).parse(event.params), live = this.state(employee.agentId);
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (!threadId) return;
    if (event.method === "thread/status/changed") {
      const status = z.object({ type: z.string() }).passthrough().safeParse(params.status);
      if (status.success && status.data.type === "active") live.active.add(threadId); else live.active.delete(threadId);
      return;
    }
    // Events from before this relay saw the log only rebuild activity; they are never delivered late.
    if (event.method !== "turn/completed" || replaying) return;
    const turn = turnSchema.safeParse(params.turn);
    if (!turn.success || this.store.get("native_relay_turns", turn.data.id)) return;
    const sessionId = await this.ownerSession(employee, threadId);
    if (!sessionId) return;
    const answer = [...turn.data.items].reverse().find(item => item.type === "agentMessage" && (item.phase === "final_answer" || item.phase === undefined));
    const text = typeof answer?.text === "string" ? answer.text.trim() : "";
    this.store.set("native_relay_turns", turn.data.id, { agentId: employee.agentId, owner: employee.owner, sessionId, threadId,
      turnId: turn.data.id, text, status: turn.data.status && turn.data.status !== "completed" ? "empty" : "queued", attempts: 0 } satisfies Turn);
  }
  /** Only the native thread of an owner private conversation qualifies; child and delegated threads do not. */
  private async ownerSession(employee: NativeRelayEmployee, threadId: string) {
    const live = this.state(employee.agentId), known = live.threads.get(threadId);
    if (known && (known.sessionId || this.clock() - known.checkedAt < 60_000)) return known.sessionId;
    const response = z.object({ bindings: z.array(z.object({ sessionId: z.string(), nativeSessionId: z.string() }).passthrough()).default([]) })
      .passthrough().parse(await this.port.host(employee).nativeSessions({ runtimeId: employee.runtimeId, action: "bindings" }));
    const work = await this.port.sessions(employee.owner, employee.agentId), checkedAt = this.clock();
    for (const binding of response.bindings) {
      const sessionId = this.port.publicSession(employee.owner, employee.agentId, binding.sessionId);
      let owner = false;
      if (sessionId) try { work.validateTarget(sessionId); owner = true; } catch { /* Not an owner conversation. */ }
      live.threads.set(binding.nativeSessionId, { sessionId: owner ? sessionId! : null, checkedAt });
    }
    if (!live.threads.has(threadId)) live.threads.set(threadId, { sessionId: null, checkedAt });
    return live.threads.get(threadId)!.sessionId;
  }
  private async drain() {
    for (const { id, value: turn } of this.store.entriesByStatus<Turn>("native_relay_turns", ["queued"]).slice(0, 20)) {
      if (this.closed) return;
      try {
        if (!turn.text) { this.store.set("native_relay_turns", id, { ...turn, status: "empty" }); continue; }
        const employee = this.port.employees().find(e => e.agentId === turn.agentId);
        if (!employee) continue;
        const work = await this.port.sessions(turn.owner, turn.agentId);
        if (await this.managed(employee, work, turn)) { this.store.set("native_relay_turns", id, { ...turn, status: "managed" }); continue; }
        work.deliver({ eventId: `wake-${turn.turnId}`, targetSessionId: turn.sessionId, text: turn.text });
        this.port.record?.(turn.owner, turn.agentId, turn.sessionId, `${turn.turnId}:assistant`, turn.text);
        this.store.set("native_relay_turns", id, { ...turn, status: "delivered" });
      } catch {
        const attempts = turn.attempts + 1;
        this.store.set("native_relay_turns", id, { ...turn, attempts, status: attempts >= 20 ? "failed" : "queued" });
      }
    }
  }
  /** Router already answers turns it started; those appear in its recent Host run events. */
  private async managed(employee: NativeRelayEmployee, work: WorkSessions, turn: Turn) {
    const runs = work.getSession(turn.sessionId).runs.filter(run => run.runId).slice(-5);
    for (const run of runs) {
      const cached = this.store.get<string[]>("native_relay_run_turns", run.runId!);
      const turns = cached ?? await this.runTurns(this.port.host(employee), run.runId!, turn.threadId);
      if (!cached && run.phase === "finished") this.store.set("native_relay_run_turns", run.runId!, turns);
      if (turns.includes(turn.turnId)) return true;
    }
    return false;
  }
  private async runTurns(host: NativeRelayHost, runId: string, threadId: string) {
    const turns = new Set<string>();
    let after = 0;
    for (let pages = 0; pages < 20; pages++) {
      const result = await host.events(runId, after, 500);
      for (const { event } of result.events) {
        if (event.type !== "native.notification") continue;
        const notification = z.object({ method: z.string(), params: z.record(z.string(), z.unknown()).optional() }).passthrough().safeParse(event.notification);
        const params = notification.success ? notification.data.params : undefined;
        const id = z.object({ id: z.string() }).passthrough().safeParse(params?.turn);
        if (params?.threadId === threadId && id.success) turns.add(id.data.id);
      }
      if (!result.hasMore) break;
      after = result.cursor;
    }
    return [...turns];
  }
  private keepAlive(agentId: string) {
    const live = this.live.get(agentId);
    if (!live?.active.size) { if (live) delete live.activeSince; return; }
    live.activeSince ??= this.clock();
    if (this.clock() - live.activeSince <= (this.options.keepAliveMs ?? 2 * 60 * 60_000)) this.port.touch(agentId);
  }
}
