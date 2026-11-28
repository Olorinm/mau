import type { DurableStore } from "./store.js";

const SESSIONS = "partner_sessions", USE = "partner_session_use", CONTINUED = "partner_session_continued";
/**
 * A context is not continued once it is both large and cold: it holds more than this many tokens, and nobody has used
 * it for this long. Continuing a large context whose cache has gone means reading all of it again at full price; one
 * that is small, or was used a moment ago, costs little to continue.
 */
export const SPENT_TOKENS = 250_000, SPENT_IDLE_MS = 24 * 3_600_000;

/**
 * A session a partner works in beside its conversation with the owner: one piece of work another partner sent it,
 * and what followed on that work. `id` is the session's key at Router. A session never ends: when its context has
 * grown large and cold it goes on in a new one (`Partners.retire`), and what was said stays one history.
 */
export interface PartnerSession {
  id: string; owner: string; agentId: string; title: string; startedBy: { agentId: string; name: string };
  createdAt: string;
}
/**
 * What Mau has seen of one context of a partner: the model's working memory of a session, between two of its new
 * starts. `sessionId` is Router's execution context: the session's key for its first context, then `<key>.w<n>`.
 */
export interface SessionUse { owner: string; agentId: string; sessionId: string; turns: number; lastAt: string; tokens?: number }
/** The session a context belongs to. */
export const sessionOf = (contextId: string) => contextId.replace(/\.w\d+$/, "");
/** The context a session had before this one, if it had one. */
export function earlierContext(contextId: string): string | undefined {
  const window = /^(.*)\.w(\d+)$/.exec(contextId);
  return !window ? undefined : Number(window[2]) <= 2 ? window[1]! : `${window[1]}.w${Number(window[2]) - 1}`;
}
/**
 * A session that went on in a new context, until a turn there has been told where the earlier part is. `offeredTo`:
 * the turn that was told; it counts once that turn has completed.
 */
export interface Continuation { agentId: string; sessionId: string; earlier: string; offeredTo?: string }

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
    this.store.insert(SESSIONS, session.id, { ...session, createdAt: iso(at) } satisfies PartnerSession);
    return this.store.get<PartnerSession>(SESSIONS, session.id)!;
  }
  get(id: string) { return this.store.get<PartnerSession>(SESSIONS, id); }
  /**
   * A partner's task sessions, the one that began last first: at most `limit` of them, after `offset` or older than
   * the session `before`. `startedBy`: only the ones that partner opened.
   */
  began(owner: string, agentId: string, limit: number, page: { before?: string | undefined; offset?: number | undefined; startedBy?: string | undefined } = {}): PartnerSession[] {
    return this.store.newest<PartnerSession>(SESSIONS, [{ members: ["owner"], value: owner }, { members: ["agentId"], value: agentId },
      ...(page.startedBy !== undefined ? [{ members: ["startedBy.agentId"], value: page.startedBy }] : [])], limit, { before: page.before, offset: page.offset }).map(entry => entry.value);
  }
  /** A turn ended in a context. `tokens`: how full the context was then, when the kernel said so. */
  used(owner: string, agentId: string, sessionId: string, tokens: number | undefined, at = Date.now()) {
    const key = `${agentId}:${sessionId}`, prior = this.store.get<SessionUse>(USE, key);
    this.store.set(USE, key, { owner, agentId, sessionId, turns: (prior?.turns ?? 0) + 1, lastAt: iso(at),
      ...(tokens !== undefined ? { tokens } : prior?.tokens !== undefined ? { tokens: prior.tokens } : {}) } satisfies SessionUse);
  }
  use(agentId: string, sessionId: string) { return this.store.get<SessionUse>(USE, `${agentId}:${sessionId}`); }
  /** What was seen of a partner's contexts, the one used last first: at most `limit` of them, after `offset`. */
  uses(agentId: string, limit: number, offset = 0): SessionUse[] {
    return this.store.newest<SessionUse>(USE, [{ members: ["agentId"], value: agentId }], limit, { by: "lastAt", offset }).map(entry => entry.value);
  }
  /** What was seen of the contexts one session had, the first one first. */
  usesOf(agentId: string, sessionId: string): SessionUse[] {
    const uses: SessionUse[] = [];
    for (let window = 1, use = this.use(agentId, sessionId); use; use = this.use(agentId, `${sessionId}.w${++window}`)) uses.push(use);
    return uses;
  }
  /** The contexts that are large and cold now. */
  spentUses(now = Date.now()): SessionUse[] { return this.store.entries<SessionUse>(USE).map(entry => entry.value).filter(use => this.spent(use, now)); }
  /** Large and cold: see `SPENT_TOKENS`. A context whose kernel reports no size is never spent. */
  spent(use: SessionUse | undefined, now = Date.now()): boolean {
    return use?.tokens !== undefined && use.tokens > SPENT_TOKENS && now - Date.parse(use.lastAt) > SPENT_IDLE_MS;
  }
  /** The session went on in a new context: `earlier` is the one that held what was said so far. */
  continued(agentId: string, sessionId: string, earlier: string) {
    this.store.set(CONTINUED, `${agentId}:${sessionId}`, { agentId, sessionId, earlier } satisfies Continuation);
  }
  /** What a turn of the session is to be told about its earlier part, and that this turn is told it. */
  continuation(agentId: string, sessionId: string, turn: string): Continuation | undefined {
    const key = `${agentId}:${sessionId}`, record = this.store.get<Continuation>(CONTINUED, key);
    if (record && record.offeredTo !== turn) this.store.set(CONTINUED, key, { ...record, offeredTo: turn } satisfies Continuation);
    return record;
  }
  /** A turn completed: what it was told about an earlier part is not told again. */
  told(agentId: string, turn: string) {
    for (const { id, value } of this.store.entries<Continuation>(CONTINUED)) if (value.agentId === agentId && value.offeredTo === turn) this.store.delete(CONTINUED, id);
  }
  /** A deleted partner's own sessions go. The sessions it opened at others stay: they are those partners' work, and keep its name. */
  forget(agentId: string) {
    for (const { id, value } of this.store.entries<PartnerSession>(SESSIONS)) if (value.agentId === agentId) this.store.delete(SESSIONS, id);
    for (const { id, value } of this.store.entries<SessionUse>(USE)) if (value.agentId === agentId) this.store.delete(USE, id);
    for (const { id, value } of this.store.entries<Continuation>(CONTINUED)) if (value.agentId === agentId) this.store.delete(CONTINUED, id);
  }
}
