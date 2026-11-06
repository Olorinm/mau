import type { RunAdmission } from "./run-admission.js";

/**
 * Connections whose tools act as the owner's personal identity (Agent Connectors `usage: "owner_private"`, for
 * example Feishu through the owner's user authorization) are admitted only in the owner's private conversation.
 * This is a hard check where Mau admits connected-app calls; the Agent's instructions are not relied on.
 */
export interface OwnerPrivatePolicy {
  /** IDs of owner-private connections; undefined when unknown, in which case every connection is treated as private. */
  connections(): Promise<Set<string> | undefined>;
  /** True only for a run admitted from the owner's private conversation (or an owner-created schedule, see below). */
  admitted(admission: RunAdmission): Promise<boolean>;
}

/** Minimal public Router surfaces used for the decision (`ServiceExtension.communication` and `.sessions`). */
interface InputRecord { source: { scope?: string }; conversationId: string }
export interface RouterConversations {
  communication?: { input(taskId: string): InputRecord | undefined; isOwnerInput(input: InputRecord): boolean } | undefined;
  sessions?: { lookup(eventId: string): { sessionId: string } | null;
    getSession(sessionId: string): { runs: Array<{ taskId: string }> } } | undefined;
}

export const OWNER_PRIVATE_ONLY = "connected_app_owner_private_only";
export const ownerPrivateRefusal = (connection: string) => ({ status: "failed", error: OWNER_PRIVATE_ONLY, connection,
  message: "这个连接使用你的个人身份（例如飞书个人权限），只能在你与 Agent 的私聊中使用，群聊、其他人或委派任务中不可用。",
  instruction: "Do not retry here. Tell the requester this works only in the owner's private conversation with you." });

/**
 * Decide whether a run is the owner's private conversation, from Router's own records:
 * - `owner` admission for a channel message: the message must be the owner's direct input (Router `isOwnerInput`:
 *   direct scope from the owner's address, or the owner-main conversation). Router also admits the owner's turns in
 *   private groups (owner plus the owner's Agents) as `owner`; those are groups and are refused.
 * - `owner` admission for an owner-authenticated work event (Router's work-events API): allowed unless its session
 *   contains any message that is not the owner's direct input (a group or visitor session).
 * - `schedule`: rules are created by the owner, their target and conversation sessions must be owner conversations
 *   (Router `validateTarget`), and they stay read-only, so owner-created schedules count as the owner's.
 * - `delegation` (delegated work, memory review) and anything unresolvable: refused.
 */
export async function ownerPrivateAdmission(admission: RunAdmission, router: RouterConversations | undefined): Promise<boolean> {
  if (admission.kind === "schedule") return true;
  if (admission.kind !== "owner" || !router?.communication) return false;
  const communication = router.communication;
  const input = communication.input(admission.reference);
  if (input) return communication.isOwnerInput(input);
  const event = router.sessions?.lookup(admission.reference);
  if (!event) return false;
  const runs = router.sessions!.getSession(event.sessionId).runs;
  return runs.every(run => { const other = communication.input(run.taskId); return !other || communication.isOwnerInput(other); });
}

/** Owner-private connection IDs: configured ones plus those the connector service reports, cached briefly. */
export class OwnerPrivateConnections {
  private cached?: { at: number; ids: Set<string> };
  constructor(private readonly configured: string[], private readonly reported?: () => Promise<Array<{ id: string; usage?: string | undefined }>>,
    private readonly ttlMs = 60_000) {}
  async ids(): Promise<Set<string> | undefined> {
    if (!this.reported) return new Set(this.configured);
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.ids;
    try {
      const ids = new Set([...this.configured, ...(await this.reported()).filter(c => c.usage === "owner_private").map(c => c.id)]);
      this.cached = { at: Date.now(), ids };
      return ids;
    } catch {
      // Fail closed: without the service's answer, outside the owner's private conversation nothing is admitted.
      return undefined;
    }
  }
}
