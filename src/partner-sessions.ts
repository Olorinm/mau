import type { DurableStore } from "./store.js";

const SESSIONS = "partner_sessions", USE = "partner_session_use";
/**
 * A session is not continued once it is both large and cold: its context holds more than this many tokens, and nobody
 * has used it for this long. Continuing a large session whose cache has gone means reading all of it again at full
 * price; one that is small, or was used a moment ago, costs little to continue.
 */
export const SPENT_TOKENS = 250_000, SPENT_IDLE_MS = 24 * 3_600_000;

/**
 * A session a partner works in beside its conversation with the owner: one piece of work another partner sent it,
 * and what followed on that work. `id` is the session's key at Router. `ended`: it is not continued any more; what
 * was said in it stays readable.
 */
export interface PartnerSession {
  id: string; owner: string; agentId: string; title: string; startedBy: { agentId: string; name: string };
  createdAt: string; status: "open" | "ended"; endedAt?: string;
}
/** What Mau has seen of one session of a partner, a task session or a window of its conversation with the owner. */
export interface SessionUse { owner: string; agentId: string; sessionId: string; turns: number; lastAt: string; tokens?: number }

const iso = (time: number) => new Date(time).toISOString();
/** The first line of a text as a title: at most 60 characters. */
export function titleOf(text: string): string {
  const line = text.split("\n").map(part => part.trim()).find(Boolean) ?? "", characters = Array.from(line.replace(/\s+/g, " "));
  return characters.length > 60 ? characters.slice(0, 59).join("") + "…" : characters.join("");
}

/** The record of partners' task sessions and of how much every session was used. */
export class PartnerSessions {
  constructor(private readonly store: DurableStore) {}
  /** Record a session that begins with a message. The same id always records the same session. */
  open(session: Omit<PartnerSession, "createdAt" | "status">, at = Date.now()): PartnerSession {
    this.store.insert(SESSIONS, session.id, { ...session, createdAt: iso(at), status: "open" } satisfies PartnerSession);
    return this.store.get<PartnerSession>(SESSIONS, session.id)!;
  }
  get(id: string) { return this.store.get<PartnerSession>(SESSIONS, id); }
  /** A partner's task sessions, oldest first. */
  of(owner: string, agentId: string): PartnerSession[] {
    return this.store.newest<PartnerSession>(SESSIONS, [{ members: ["owner"], value: owner }, { members: ["agentId"], value: agentId }], 500).map(entry => entry.value).reverse();
  }
  opened(): PartnerSession[] { return this.store.entriesByStatus<PartnerSession>(SESSIONS, ["open"]).map(entry => entry.value); }
  end(id: string, at = Date.now()) {
    const session = this.get(id);
    if (session?.status === "open") this.store.set(SESSIONS, id, { ...session, status: "ended", endedAt: iso(at) } satisfies PartnerSession);
  }
  /** A turn ended in a session. `tokens`: how full its context was then, when the kernel said so. */
  used(owner: string, agentId: string, sessionId: string, tokens: number | undefined, at = Date.now()) {
    const key = `${agentId}:${sessionId}`, prior = this.store.get<SessionUse>(USE, key);
    this.store.set(USE, key, { owner, agentId, sessionId, turns: (prior?.turns ?? 0) + 1, lastAt: iso(at),
      ...(tokens !== undefined ? { tokens } : prior?.tokens !== undefined ? { tokens: prior.tokens } : {}) } satisfies SessionUse);
  }
  use(agentId: string, sessionId: string) { return this.store.get<SessionUse>(USE, `${agentId}:${sessionId}`); }
  /** What was seen of a partner's sessions, the one used last first. */
  uses(agentId: string): SessionUse[] {
    return this.store.newest<SessionUse>(USE, [{ members: ["agentId"], value: agentId }], 500).map(entry => entry.value).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }
  /** The sessions that are large and cold now. */
  spentUses(now = Date.now()): SessionUse[] { return this.store.entries<SessionUse>(USE).map(entry => entry.value).filter(use => this.spent(use, now)); }
  /** Large and cold: see `SPENT_TOKENS`. A session whose kernel reports no size is never spent. */
  spent(use: SessionUse | undefined, now = Date.now()): boolean {
    return use?.tokens !== undefined && use.tokens > SPENT_TOKENS && now - Date.parse(use.lastAt) > SPENT_IDLE_MS;
  }
  /** A deleted partner's own sessions go. The sessions it opened at others stay: they are those partners' work, and keep its name. */
  forget(agentId: string) {
    for (const { id, value } of this.store.entries<PartnerSession>(SESSIONS)) if (value.agentId === agentId) this.store.delete(SESSIONS, id);
    for (const { id, value } of this.store.entries<SessionUse>(USE)) if (value.agentId === agentId) this.store.delete(USE, id);
  }
}
