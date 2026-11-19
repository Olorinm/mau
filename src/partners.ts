import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { OwnerRequestResult, ServiceExtension, WorkEventResult, WorkPendingCard, WorkSessions } from "@agent-router/server";
import type { DurableStore } from "./store.js";
import type { RunAdmission } from "./run-admission.js";
import type { ModelSettingsView } from "./model-settings.js";
import { APPROVAL_DISPLAY_LIMIT, type ApprovalDesk } from "./connector-approvals.js";
import type { MemorySource } from "./partner-context.js";
import { dutySchema } from "./environments.js";
import { CARRIED_NOTES, EXTERNAL_PARTNERS, GUIDE, OWNER_APPROVAL, KERNEL_KEPT, NEXT, OTHER_KERNELS, WAITING_LIMIT, contextText, externalIncomingText, incomingText, noticeText, resultView, returnText, shortened } from "./partner-text.js";

const MESSAGES = "partner_messages", RETURNS = "partner_returns", CURSORS = "partner_cursors", RECRUITS = "partner_recruits",
  DISMISSALS = "partner_dismissals", ACTIVITY = "partner_activity", WAKES = "partner_failure_wakes", CARDS = "partner_cards";
/** Results handed to a sender in one turn. */
const BATCH = 8;
/** A turn started by a result may message again; this many generations may follow one owner message. */
const CHAIN_LIMIT = 4;
/** Hand-overs of a result to its sender's conversation before it is dropped; the delays between them, in seconds. */
const DELIVERY_ATTEMPTS = 8, RETRY_SECONDS = [5, 15, 60, 300, 900, 3600, 10_800];
/** A result that could not be handed over for this long is dropped. It stays readable. */
const UNDELIVERED_MS = 48 * 3_600_000;
/** Consecutive turns a sender is woken for failed results only. After that a failure leaves a notice. */
const FAILURE_WAKES = 3;
/** A message that could not be given to its recipient's work queue is retried for this long, then fails. */
const SENDING_MS = 5 * 60_000;
/** A message whose recipient has not ended its turn, or a hand-over whose turn has not ended, is given up after this long. */
const UNANSWERED_MS = UNDELIVERED_MS;
/**
 * A turn's outcome is reported as unknown when it has been unknown for this long. Router finds a run again on its own
 * after an interrupted submission, which takes a moment.
 */
const UNKNOWN_GRACE_MS = 2 * 60_000;
/** How often a turn that the settlement feed has not reported is read directly. */
const DIRECT_CHECK_MS = 15_000;
/** Informs that may wait for one partner's next turn. A further one is refused. */
const NOTE_LIMIT = 20;
/** Environment states in which a partner cannot be woken by a message. */
const UNREACHABLE = ["paused", "pausing", "deleting", "deleted", "needs_action"];
/**
 * Where a partner is found. `state` is `ready` when it can work now, and otherwise what a roster shows. `reachable`:
 * a message can be left for it. `external`: it is an agent on the owner's own computer, which Mau only messages.
 */
export interface Presence { state: string; reachable: boolean; external: boolean }
/** The presence of a partner that runs in an environment of Mau's, from that environment's state. */
export const environmentPresence = (state: string | undefined): Presence | undefined =>
  state === undefined ? undefined : { state, reachable: !UNREACHABLE.includes(state), external: false };
const MESSAGE_BYTES = 16_000;
/** The answers a hand-over shows the owner share this many bytes; Router admits 64,000 for what an input shows. */
const SHOWN_ANSWER_BYTES = 48_000;
/** A message or a hand-over that reached its end is kept this long, then removed. */
const KEPT_MS = 30 * 24 * 3_600_000;
/** How often the records past that age are removed. */
const CLEANUP_MS = 3_600_000;
const FINAL_MESSAGES: Status[] = ["returned", "collected", "seen", "dropped"], FINAL_RETURNS = ["completed", "failed"];
/** The states of a work event whose turn has ended. */
const ENDED = ["completed", "failed", "cancelled", "rejected"];

export const partnerName = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const setting = z.string().min(1).max(200);
export const partnersInput = z.object({
  action: z.enum(["roster", "recruit", "message", "wait", "dismiss"]).describe(
    "roster: list the partners, what a recruit may choose, and the guide. recruit: add a partner (name, duty; optionally kernel, model, effort, and a first message with intent). " +
    "message: send text to a partner (to, text, intent). wait: wait up to a minute for replies (optionally messageIds, timeoutSeconds). dismiss: archive a partner (name)."),
  name: z.string().max(48).optional().describe("recruit, dismiss: the partner's name."),
  duty: z.string().max(200).optional().describe("recruit: one line saying what the partner is responsible for."),
  kernel: setting.optional().describe("recruit: a kernel listed by roster. Empty: yours."),
  model: setting.optional().describe("recruit: a model listed by roster. Empty: yours."),
  effort: setting.optional().describe("recruit: an effort listed by roster for the model. Empty: yours."),
  message: z.string().max(24_000).optional().describe("recruit: a first message for the new partner. Needs intent."),
  to: z.string().max(48).optional().describe("message: the name of the partner to send to."),
  text: z.string().max(24_000).optional().describe("message: what the partner is to read."),
  intent: z.enum(["relay", "ask", "inform"]).optional().describe(
    "relay: you pass on what the owner asked for. ask: you need an answer for your own work. inform: for the partner to know; no reply comes."),
  messageIds: z.array(z.string().max(64)).min(1).max(BATCH).optional().describe("wait: the messages to wait for. Empty: every message of yours that waits for a reply."),
  timeoutSeconds: z.number().int().min(1).max(60).optional().describe("wait: how long to wait, at most 60. Empty: 30."),
  includeDismissed: z.boolean().optional().describe("roster: also list dismissed partners."),
}).strict();
type Input = z.infer<typeof partnersInput>;
export type Intent = "relay" | "ask" | "inform";

export interface Party { agentId: string; name: string; duty?: string }
/** What a turn may use, as the product enforces it for that turn. */
export interface Authorization {
  feishu: boolean; connections: string[]; operations?: string[];
  /** Connected-app writes can ask the owner. */
  write: boolean;
  expiresAt?: string; maxToolCalls?: number;
}
/** The owner conversation a message was sent from: where its reply and its approvals go. */
interface Origin { sessionId: string; connectionId: string; chain: number; taskId: string }
/**
 * `queued`: an inform waiting for its recipient's next turn. `sending`: recorded, not yet in the recipient's work queue.
 * `running`: the recipient's turn has not ended. `settled`: the result is known and waits for its sender.
 * `returning`: handed to the sender in a turn that has not ended. Final: `returned` (a turn or a notice carried it),
 * `collected` (the sender read it with wait, or was told at once that it was not sent), `seen` (an inform its
 * recipient's turn carried), `dropped` (never handed over; the result stays readable).
 */
type Status = "queued" | "sending" | "running" | "settled" | "returning" | "returned" | "collected" | "seen" | "dropped";
export interface PartnerMessage {
  id: string; owner: string; from: Party; to: Party; intent: Intent; text: string; status: Status; createdAt: string;
  origin: Origin;
  /** What the sending turn could use, and what the recipient's turn may use: the former within the recipient's connections. */
  sender: Authorization; grants: Authorization;
  /** The kernel, model and effort the recipient's turn was submitted with. What the kernel then used is not read back. */
  sentTo?: { kernel: string | null; model: string | null; effort: string | null };
  result?: { status: "completed" | "failed" | "cancelled" | "rejected" | "unknown"; answer: string; error?: string; settledAt: string; durationMs: number };
  delivery?: { attempts: number; nextAttemptAt: string; batchId?: string; via?: "turn" | "wait" | "notice" | "call"; reason?: string;
    /** The wait call that returned this result to the turn that sent the message. It counts once that call's answer has reached the Host. */
    readBy?: string };
  /** Since when the outcome of the recipient's turn has been unknown. */
  unknownSince?: string;
  /** An inform: the turn whose context carries it, or the message it is sent with to an agent on the owner's computer. */
  offeredTo?: string;
}
interface ReturnBatch {
  id: string; owner: string; agentId: string; messageIds: string[]; status: "submitted" | "completed" | "failed";
  origin: Omit<Origin, "taskId">; authorization: Authorization; attempt: number; createdAt: string;
  reply: { connectionId?: string };
  /** Marks where each answer begins and ends in the turn's input. Chosen after the answers were written. */
  boundary: string;
  /** Since when the outcome of the hand-over's turn has been unknown. */
  unknownSince?: string;
}
/**
 * A card the turn that handles a message put in its partner's own conversation with the owner: the partner's kernel
 * asks before it goes on. `desk` is the copy of an approval in the conversation the message was sent from, where the
 * owner is; other cards, and an approval too long to show there, are answered in the partner's conversation only.
 */
interface PartnerCard { status: "open" | "closed"; owner: string; agentId: string; messageId: string; cardId: string; desk?: string; choices: string[]; createdAt: string }
type Turn = { kind: "owner" } | { kind: "message"; message: PartnerMessage } | { kind: "return"; batch: ReturnBatch };
type Conversations = Pick<NonNullable<ServiceExtension["communication"]>, "input" | "isOwnerInput">;

/** Everything the partners feature needs from the rest of the product; nothing here comes from model arguments. */
export interface PartnersPort {
  agents(owner: string): Array<{ id: string; name: string; status: string }>;
  create(owner: string, name: string): Promise<{ id: string; name: string }>;
  sessions(owner: string, agentId: string): Promise<WorkSessions>;
  conversations(agentId: string): Promise<Conversations | undefined>;
  /**
   * Whether the turn of a task has ended and its answer is recorded in its conversation (a turn with an unknown
   * outcome has not ended). A result handed over earlier would stand before that answer in the transcript.
   */
  turnEnded(agentId: string, taskId: string): Promise<boolean>;
  duty(agentId: string): string | undefined;
  /** The partner whose environment the agent runs in: itself, or the one it shares. */
  environmentHolder(agentId: string): string;
  /** The kernel the agent runs on. */
  kernel(agentId: string): string | undefined;
  /** The kernels a partner in the agent's environment can run on. */
  kernels(agentId: string): string[];
  /** `undefined`: the partner has neither an environment nor a computer. */
  presence(owner: string, agentId: string): Presence | undefined;
  /** What ends with a dismissal beside the partner's place in the roster: the pairing of a computer. */
  dismissed(owner: string, agentId: string): Promise<void>;
  /** Refuses when another partner cannot run in the holder's environment on that kernel. */
  assertShareable(owner: string, holder: string, kernel: string | undefined): Promise<void>;
  share(owner: string, agentId: string, holder: string, duty: string, kernel: string | undefined): Promise<unknown>;
  models(owner: string, agentId: string): Promise<ModelSettingsView>;
  /** What another kernel of the agent's environment offers; nobody's selection. */
  kernelModels(owner: string, agentId: string, kernel: string): Promise<ModelSettingsView>;
  /** The model a partner's runtime uses when none is selected, as far as it was read. */
  defaultModel(agentId: string): string | undefined;
  connections(owner: string, agentId: string): string[];
  /** Answer a card of the partner's own conversation with what the owner chose where the card was copied to. */
  answerCard(owner: string, agentId: string, cardId: string, answer: { key: string; by: string | null; surface: "web" | "channel"; choiceId: string }): Promise<unknown>;
  /** Withdraw the owner cards a finished run left open. */
  closeApprovals(agentId: string, runId: string, withdraw: (requestId: string) => Promise<void>): Promise<void>;
}

/** A refusal the model is told as it is: a code and what to do about it. */
export class PartnerError extends Error {
  constructor(code: string, readonly details: Record<string, unknown> = {}) { super(code); }
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/**
 * The arguments of an operation as the owner reads them on its approval card: all of them, never shortened. When they
 * do not fit the card, the card is not shown and the operation is refused.
 */
function shownArguments(value: unknown): string {
  const json = JSON.stringify(value);
  if (json.length > APPROVAL_DISPLAY_LIMIT) throw new Error("approval_too_long_to_display");
  return json;
}
const iso = (time = Date.now()) => new Date(time).toISOString();
const expectsReply = (message: PartnerMessage) => message.intent !== "inform";
const failed = (message: PartnerMessage) => message.result?.status !== "completed";
const code = (error: unknown, fallback: string) => error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : fallback;
/** One line for operators about a delivery step that failed: an error code, or the error's name and message. */
const report = (event: string, error: unknown) => console.warn(JSON.stringify({ event,
  ...(code(error, "") ? { error: code(error, "") } : { name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) }) }));

/**
 * The owner's partners as they work together: the roster, recruiting and dismissing, messages between partners, and
 * the way a reply comes back. A message to a partner runs as a turn of that partner's own conversation with the
 * owner. Its result returns to the conversation the message was sent from as a turn of the sender, whose answer goes
 * to the owner there. The record of every message is durable; the endings of turns are read from Router's settlement
 * feed by a cursor per agent, so nothing is lost when either side restarts.
 */
export class Partners {
  private timer?: ReturnType<typeof setInterval>;
  private pending: Promise<void> | undefined;
  private closed = false;
  /** Runs seen running at each partner's Host, to say who is working without reading Router's records every turn. */
  private readonly active = new Map<string, Set<string>>();
  /** When each agent's open turns were last read directly. */
  private readonly checked = new Map<string, number>();
  private cleanedAt = 0;
  constructor(private readonly store: DurableStore, private readonly port: PartnersPort) {}
  start() { this.timer = setInterval(() => { void this.tick(); }, 1000); this.timer.unref(); void this.tick(); }
  async tick() {
    if (this.closed) return;
    if (this.pending) return this.pending;
    this.pending = this.cycle().finally(() => { this.pending = undefined; }); return this.pending;
  }
  async close() { this.closed = true; if (this.timer) clearInterval(this.timer); await this.pending; }

  // ---- What a turn is, and what it may do ----

  /** The turn an admission started, as far as partners are concerned. */
  private turn(admission: RunAdmission): Turn | undefined {
    if (admission.kind === "owner") return { kind: "owner" };
    if (admission.kind !== "delegation") return undefined;
    const message = admission.reference.startsWith("pm-") ? this.store.get<PartnerMessage>(MESSAGES, admission.reference) : undefined;
    if (message) return message.owner === admission.owner && message.to.agentId === admission.agentId ? { kind: "message", message } : undefined;
    const batch = admission.reference.startsWith("pr-") ? this.store.get<ReturnBatch>(RETURNS, admission.reference) : undefined;
    return batch && batch.owner === admission.owner && batch.agentId === admission.agentId ? { kind: "return", batch } : undefined;
  }
  /** Whose message a partner turn is handling, for the record of what it writes to its memory. */
  memorySource(admission: RunAdmission): MemorySource | undefined {
    const turn = this.turn(admission), party = ({ agentId, name }: Party) => ({ id: agentId, name });
    if (turn?.kind === "message") return { kind: "message", partners: [party(turn.message.from)] };
    if (turn?.kind !== "return") return undefined;
    const senders = new Map(turn.batch.messageIds.flatMap(id => { const to = this.store.get<PartnerMessage>(MESSAGES, id)?.to; return to ? [[to.agentId, party(to)] as const] : []; }));
    return { kind: "result", partners: [...senders.values()] };
  }
  /** Whether a partner turn's admission still stands. `undefined`: the admission is not a partner turn's. */
  allows(admission: RunAdmission): boolean | undefined {
    if (admission.kind !== "delegation" || !/^p[mr]-/.test(admission.reference)) return undefined;
    const turn = this.turn(admission);
    return turn?.kind === "message" ? ["sending", "running"].includes(turn.message.status) : turn?.kind === "return" ? turn.batch.status === "submitted" : false;
  }
  /**
   * What the product grants a partner turn beyond its tool grants: whether its connected-app writes can ask the
   * owner, and for a turn that handles a message, where the owner is asked. `undefined` for every other turn.
   * Connections that act as the owner's personal identity are not part of it: no partner turn is the owner's own.
   */
  authority(admission: RunAdmission): { write: boolean; approvals?: ApprovalDesk; tool: string } | undefined {
    const turn = this.turn(admission);
    if (turn?.kind === "message") return { write: turn.message.grants.write, approvals: this.desk(turn.message), tool: "partners" };
    if (turn?.kind === "return") return { write: turn.batch.authorization.write, tool: "partners" };
    return undefined;
  }
  /** The owner conversation a turn runs in, or a refusal: partners are messaged only from there. */
  private async conversation(admission: RunAdmission, turn: Turn): Promise<Omit<Origin, "taskId">> {
    if (turn.kind === "return") return { ...turn.batch.origin, chain: turn.batch.origin.chain + 1 };
    const refused = new PartnerError("partner_owner_conversation_required", { instruction:
      "Partners can be recruited, messaged and dismissed only from the owner's private conversation with you, because a reply returns there. Tell the owner to ask there. action=roster works here." });
    if (turn.kind !== "owner") throw refused;
    const core = await this.port.conversations(admission.agentId), input = core?.input(admission.reference);
    if (!core || !input || input.routed || !core.isOwnerInput(input)) throw refused;
    const { sessionId } = (await this.port.sessions(admission.owner, admission.agentId)).openOwnerConversation();
    if (input.conversationId !== sessionId) throw refused;
    return { sessionId, connectionId: input.connectionId, chain: 0 };
  }
  /** Router's task of the running turn. An owner's channel turn is admitted under its task id. */
  private async task(admission: RunAdmission, turn: Turn): Promise<string | undefined> {
    if (turn.kind === "owner") return admission.reference;
    return (await this.port.sessions(admission.owner, admission.agentId)).lookup(turn.kind === "return" ? turn.batch.id : turn.message.id)?.taskId;
  }
  private async origin(admission: RunAdmission, turn: Turn): Promise<Origin> {
    const conversation = await this.conversation(admission, turn), taskId = await this.task(admission, turn);
    if (!taskId) throw new PartnerError("partner_tool_unavailable");
    return { ...conversation, taskId };
  }
  /** What the running turn may use: an owner's turn everything assigned to its partner, a result turn what its messages' turns could. */
  private authorization(admission: RunAdmission, turn: Turn): Authorization {
    const own = this.port.connections(admission.owner, admission.agentId);
    if (turn.kind === "return") return { ...turn.batch.authorization, connections: turn.batch.authorization.connections.filter(id => own.includes(id)) };
    const granted = admission.toolGrants;
    return { feishu: granted ? Boolean(granted.feishu) : true,
      connections: !granted ? own : own.filter(id => granted.connectedApps?.connections.includes(id)),
      ...(granted?.connectedApps?.operations ? { operations: granted.connectedApps.operations } : {}),
      write: true,
      ...(admission.expiresAt ? { expiresAt: admission.expiresAt } : {}), ...(admission.maxToolCalls ? { maxToolCalls: admission.maxToolCalls } : {}) };
  }

  // ---- The tool ----

  /** One call of the partners tool. Refusals come back as results the model can act on. */
  async execute(admission: RunAdmission, raw: unknown, callId: string): Promise<unknown> {
    try {
      const input = partnersInput.parse(raw), turn = this.turn(admission);
      if (!turn) throw new PartnerError("partner_tool_not_authorized");
      if (input.action === "roster") return await this.roster(admission, input.includeDismissed ?? false);
      if (input.action === "wait") return await this.wait(admission, turn, input, callId);
      if (turn.kind === "message") throw new PartnerError("partner_layer_limit", { instruction:
        "This turn handles a partner's message, so it cannot recruit, message or dismiss partners. If another partner is needed, say so in your answer; the sender decides." });
      if (input.action === "recruit") return await this.recruit(admission, turn, input, callId);
      if (input.action === "message") return await this.message(admission, turn, input, callId);
      return await this.dismiss(admission, turn, input);
    } catch (error) {
      if (error instanceof PartnerError) return { isError: true, error: error.message, ...error.details };
      if (error instanceof z.ZodError) return { isError: true, error: "partners_invalid_input", issues: error.issues };
      throw error;
    }
  }
  private partners(owner: string) { return this.port.agents(owner).filter(agent => agent.status !== "deleting"); }
  private party(agent: { id: string; name: string }): Party {
    const duty = this.port.duty(agent.id);
    return { agentId: agent.id, name: agent.name, ...(duty ? { duty } : {}) };
  }
  private self(admission: RunAdmission): Party {
    const agent = this.partners(admission.owner).find(item => item.id === admission.agentId);
    if (!agent) throw new PartnerError("partner_tool_not_authorized");
    return this.party(agent);
  }
  private dismissed(agentId: string) { return this.store.get<{ at: string }>(DISMISSALS, agentId); }
  /** When a partner was dismissed, for the owner's list. */
  dismissedAt(agentId: string) { return this.dismissed(agentId)?.at; }
  /** Another partner of the owner by its name, as a message's recipient. */
  private recipient(admission: RunAdmission, name: string | undefined): Party {
    const partners = this.partners(admission.owner), found = partners.find(agent => agent.name === name);
    if (!name || !found) throw new PartnerError("partner_not_found", { partners: partners.filter(agent => agent.id !== admission.agentId && !this.dismissed(agent.id)).map(agent => agent.name),
      instruction: "Use the exact name of a listed partner, or recruit a new one." });
    if (found.id === admission.agentId) throw new PartnerError("partner_is_self", { instruction: "That is you. Do the work yourself." });
    if (this.dismissed(found.id)) throw new PartnerError("partner_dismissed", { instruction: "This partner was dismissed. Recruit the same name to bring it back, then send the message." });
    return this.party(found);
  }
  private outstanding(owner: string, statuses: Status[]) {
    return this.store.entriesByStatus<PartnerMessage>(MESSAGES, statuses).map(entry => entry.value).filter(message => message.owner === owner);
  }
  private state(owner: string, agentId: string) {
    if (this.dismissed(agentId)) return "dismissed";
    const presence = this.port.presence(owner, agentId);
    if (!presence) return "no_environment";
    // A computer that is not connected is not working, whatever waits for it.
    if (presence.external && presence.state !== "ready") return presence.state;
    if (this.active.get(agentId)?.size || this.outstanding(owner, ["sending", "running"]).some(message => message.to.agentId === agentId)) return "working";
    return presence.state === "ready" ? "idle" : presence.state;
  }
  /** Name, duty and state of the owner's partners: what every turn in the owner conversation is shown. */
  private summary(owner: string, includeDismissed: boolean) {
    return this.partners(owner).filter(agent => includeDismissed || !this.dismissed(agent.id))
      .map(agent => ({ id: agent.id, name: agent.name, duty: this.port.duty(agent.id) ?? null, status: this.state(owner, agent.id),
        ...(this.external(owner, agent.id) ? { external: true } : {}) }));
  }
  private external(owner: string, agentId: string) { return this.port.presence(owner, agentId)?.external === true; }
  /** The owner's partners with their settings, activity and what waits at each: the roster, and the owner's list. */
  async list(owner: string, includeDismissed = true) {
    const waiting = this.outstanding(owner, ["sending", "running"]);
    const approvals = this.store.entriesByStatus<{ agentId: string; desk?: unknown }>("connector_approvals", ["pending"]).map(entry => entry.value).filter(record => record.desk);
    const cards = this.openCards(owner);
    return Promise.all(this.summary(owner, includeDismissed).map(async partner => {
      const settings = await this.port.sessions(owner, partner.id).then(work => work.defaultSettings(), () => ({} as Record<string, unknown>));
      // Router runs the turns of an agent on the owner's computer without Mau's Host, so its open runs are read from Router.
      const busy = partner.external && partner.status === "idle" && await this.port.sessions(owner, partner.id)
        .then(work => work.list().some(session => session.runs.some(run => run.phase !== "finished")), () => false);
      const holder = this.port.environmentHolder(partner.id), recruit = this.store.get<{ by: Party; at: string }>(RECRUITS, JSON.stringify([owner, partner.name]));
      const dismissal = this.dismissed(partner.id);
      return { ...partner, ...(busy ? { status: "working" } : {}), kernel: this.port.kernel(partner.id) ?? null,
        model: typeof settings.model === "string" ? settings.model : null, effort: typeof settings.effort === "string" ? settings.effort : null,
        lastActivityAt: this.store.get<{ at: string }>(ACTIVITY, partner.id)?.at ?? null,
        waiting: { messages: waiting.filter(message => message.to.agentId === partner.id).length,
          approvals: approvals.filter(record => record.agentId === partner.id).length + cards.filter(card => card.agentId === partner.id).length },
        ...(holder !== partner.id ? { sharesEnvironmentOf: holder } : {}),
        ...(recruit ? { recruitedBy: { id: recruit.by.agentId, name: recruit.by.name }, recruitedAt: recruit.at } : {}), ...(dismissal ? { dismissedAt: dismissal.at } : {}) };
    }));
  }
  private async roster(admission: RunAdmission, includeDismissed: boolean) {
    const self = this.self(admission), owner = admission.owner;
    const names = new Map(this.partners(owner).map(agent => [agent.id, agent.name]));
    const mine = this.outstanding(owner, ["sending", "running", "settled", "returning"]).filter(message => message.from.agentId === self.agentId);
    const asked = new Set(this.openCards(owner).map(card => card.messageId));
    let options: ModelSettingsView | undefined;
    try { options = await this.port.models(owner, self.agentId); } catch { /* Listed as unavailable below. */ }
    const kernel = this.port.kernel(self.agentId), others = this.port.kernels(self.agentId).filter(name => name !== kernel);
    const partners = (await this.list(owner, includeDismissed)).filter(partner => partner.id !== self.agentId);
    const choices = (view: ModelSettingsView | undefined) => ({
      models: view?.models.map(({ id, label, description, efforts, defaultEffort }) => ({ id, label, ...(description ? { description } : {}), efforts, ...(defaultEffort ? { defaultEffort } : {}) })) ?? [],
      efforts: view?.efforts ?? [] });
    // What the other kernels of the environment offer is read one after the other: each reading starts that kernel.
    const otherKernels: Array<Record<string, unknown>> = [];
    for (const name of others) {
      let view: ModelSettingsView | undefined;
      try { view = await this.port.kernelModels(owner, self.agentId, name); } catch { /* Listed as unavailable below. */ }
      otherKernels.push({ kernel: name, ...choices(view), default: { model: view?.defaultModel ?? "default", effort: "default" },
        ...(view && view.source !== "none" ? {} : { unavailable: "The model list of this kernel could not be read now. Recruit on it without model and effort, or call roster again later." }) });
    }
    return {
      you: { name: self.name, duty: self.duty ?? null },
      partners: partners.map(({ id: _id, sharesEnvironmentOf, ...partner }) => ({ ...partner,
        // The model reads names. Each member keeps its place, so a roster reads as it did before.
        ...(partner.recruitedBy ? { recruitedBy: partner.recruitedBy.name } : {}),
        model: partner.model ?? "default", effort: partner.effort ?? "default",
        ...(sharesEnvironmentOf ? { sharesEnvironmentOf: names.get(sharesEnvironmentOf) ?? "another partner" } : {}) })),
      waitingForReplies: mine.map(message => ({ messageId: message.id, to: message.to.name, intent: message.intent, sentAt: message.createdAt,
        state: message.status === "settled" || message.status === "returning" ? "answered, on its way to you"
          : asked.has(message.id) ? "waiting for the owner's approval" : "not answered yet" })),
      ...(asked.size ? { ownerApprovalNote: OWNER_APPROVAL } : {}),
      recruit: {
        kernels: kernel ? [kernel, ...others] : others,
        ...choices(options),
        yours: { kernel: kernel ?? null, model: options?.selection.model ?? options?.defaultModel ?? "default", effort: options?.selection.effort ?? "default" },
        ...(options && options.source !== "none" ? {} : { unavailable: "The model list could not be read now. Recruit without model and effort, or call roster again later." }),
        ...(otherKernels.length ? { otherKernels, otherKernelsNote: OTHER_KERNELS } : {}),
      },
      ...(partners.some(partner => partner.external) ? { externalNote: EXTERNAL_PARTNERS } : {}),
      limits: { waitingMessages: WAITING_LIMIT },
      guide: GUIDE,
    };
  }
  private async recruit(admission: RunAdmission, turn: Turn, input: Input, callId: string) {
    const origin = await this.origin(admission, turn), owner = admission.owner, self = this.self(admission);
    const name = partnerName.safeParse(input.name);
    if (!name.success) throw new PartnerError("partner_name_invalid", { instruction: "name: lowercase letters, digits and hyphens, starting with a letter, at most 48 characters." });
    const described = dutySchema.safeParse(input.duty);
    if (!described.success) throw new PartnerError("partner_duty_invalid", { instruction: "duty: one line of plain text, at most 200 characters, saying what the partner is responsible for." });
    if (input.message !== undefined && !input.intent) throw new PartnerError("partner_intent_required", { instruction: "A first message needs intent: relay, ask or inform." });
    if (input.message === undefined && input.intent) throw new PartnerError("partner_message_required", { instruction: "intent goes with a first message. Leave both out to recruit without one." });
    if (input.message !== undefined) this.checkText(input.message);
    const key = JSON.stringify([owner, name.data]), existing = this.partners(owner).find(agent => agent.name === name.data);
    const record = this.store.get<{ agentId?: string }>(RECRUITS, key);
    // A dismissed partner comes back as it was: on its own kernel, whatever the recruit names.
    const returning = existing && this.dismissed(existing.id) && existing.id !== self.agentId ? existing : undefined;
    if (returning && this.external(owner, returning.id)) throw new PartnerError("partner_not_recruitable", { instruction:
      `"${returning.name}" is an agent on the owner's own computer that was dismissed. The owner connects such a partner; a recruit cannot bring it back. Tell the owner to restore it.` });
    const selection = await this.selection(admission, input, returning?.id);
    let restored = false, agent: { id: string; name: string } | undefined = existing;
    if (returning) { this.store.delete(DISMISSALS, returning.id); restored = true; }
    else if (existing && !(record && !record.agentId)) throw new PartnerError("partner_name_taken", {
      partner: { name: existing.name, duty: this.port.duty(existing.id) ?? null },
      instruction: existing.id === self.agentId ? "That is your own name. Choose another." : "A partner with this name exists. Send it a message, or choose another name." });
    else {
      const holder = this.port.environmentHolder(self.agentId);
      try { await this.port.assertShareable(owner, holder, selection.kernel); }
      catch (error) {
        // The profile offers the kernel, but the environment's Host does not have its runtime available.
        if (code(error, "") === "environment_kernel_not_ready") throw new PartnerError("partner_kernel_not_available", { kernel: selection.kernel, reason: "kernel_runtime_unavailable",
          instruction: "This kernel is listed, but its runtime is not available in your environment now. Nothing was recruited. Recruit on another listed kernel, or tell the owner." });
        throw new PartnerError("partner_environment_unavailable", { reason: code(error, "environment_unavailable"), instruction: "A new partner runs in your environment, which cannot take one now. Tell the owner." });
      }
      // The intent is recorded first: a recruit that stopped half way is finished by repeating it.
      this.store.set(RECRUITS, key, { owner, name: name.data, by: { agentId: self.agentId, name: self.name }, at: iso() });
      try {
        agent = await this.port.create(owner, name.data);
        await this.port.share(owner, agent.id, holder, described.data, selection.kernel);
      } catch (error) {
        throw new PartnerError(code(error, "") === "agent_limit_reached" ? "partner_limit_reached" : "partner_recruit_failed", { reason: code(error, "recruit_failed"),
          instruction: "The partner was not recruited. Tell the owner; repeating the same recruit finishes one that stopped half way." });
      }
      this.store.set(RECRUITS, key, { owner, name: name.data, by: { agentId: self.agentId, name: self.name }, at: iso(), agentId: agent.id });
    }
    const partner = this.party(agent!);
    const settings = await this.applySelection(owner, partner.agentId,
      restored ? { ...(input.model !== undefined && selection.model ? { model: selection.model } : {}), ...(input.effort !== undefined && selection.effort ? { effort: selection.effort } : {}) }
        : { ...(selection.model ? { model: selection.model } : {}), ...(selection.effort ? { effort: selection.effort } : {}) }, restored);
    const sent = input.message === undefined ? undefined
      : await this.send(admission, turn, origin, callId, partner, input.intent!, input.message).catch((error: unknown) => {
        if (error instanceof PartnerError) return { isError: true as const, error: error.message, ...error.details };
        throw error;
      });
    const kept = restored && partner.duty !== described.data, kernel = this.port.kernel(partner.agentId);
    return { status: restored ? "restored" : "recruited",
      partner: { name: partner.name, duty: partner.duty ?? null, kernel: kernel ?? null, model: settings.model ?? "default", effort: settings.effort ?? "default" },
      ...(kept ? { dutyKept: "This partner already had a duty, which cannot be changed. It is the one shown." } : {}),
      ...(restored && input.kernel !== undefined && input.kernel !== kernel ? { kernelKept: KERNEL_KEPT } : {}),
      ...(selection.dropped && !restored ? { effortNote: `Your effort "${selection.dropped}" is not offered for this model, so the partner uses the model's default.` } : {}),
      ...(sent ? { message: sent } : {}),
      next: [restored ? NEXT.restored(partner.name) : NEXT.recruited(partner.name),
        sent && !("isError" in sent) ? sent.next : sent ? NEXT.firstMessageFailed : NEXT.noFirstMessage].join(" ") };
  }
  /**
   * kernel, model and effort of a recruit, and only values the roster lists. On the recruiter's kernel what is left
   * out is the recruiter's own. On another kernel of the environment nothing is carried over: what is left out is that
   * kernel's default. A partner that returns (`returning`) stays on its kernel and is checked against it.
   */
  private async selection(admission: RunAdmission, input: Input, returning?: string): Promise<{ kernel?: string; model?: string; effort?: string; dropped?: string }> {
    const own = this.port.kernel(admission.agentId), offered = this.port.kernels(admission.agentId);
    if (!returning && input.kernel !== undefined && !offered.includes(input.kernel)) throw new PartnerError("partner_kernel_not_available", { allowed: offered,
      instruction: "Use a kernel listed by roster, or leave kernel empty to use your own." });
    const kernel = returning ? this.port.kernel(returning) : input.kernel ?? own, inherits = kernel === own;
    let view: ModelSettingsView | undefined;
    try {
      view = returning && !inherits ? await this.port.models(admission.owner, returning)
        : inherits || !kernel ? await this.port.models(admission.owner, admission.agentId) : await this.port.kernelModels(admission.owner, admission.agentId, kernel);
    } catch { /* Refused below when a value was asked for. */ }
    if ((!view || view.source === "none") && (input.model !== undefined || input.effort !== undefined)) throw new PartnerError("partner_model_options_unavailable", {
      instruction: inherits ? "The model list cannot be read now, so model and effort cannot be checked. Recruit without them to use your own settings."
        : "The model list of this kernel cannot be read now, so model and effort cannot be checked. Recruit without them to use the kernel's default." });
    if (!view) return { ...(kernel ? { kernel } : {}) };
    if (input.model !== undefined && !view.models.some(option => option.id === input.model)) throw new PartnerError("partner_model_not_available", { allowed: view.models.map(option => option.id),
      instruction: inherits ? "Use a listed model id, or leave model empty to use your own." : "Use a model id listed for this kernel, or leave model empty to use the kernel's default." });
    const model = input.model ?? (inherits ? view.selection.model : undefined);
    const efforts = view.models.find(option => option.id === (model ?? view.defaultModel))?.efforts ?? view.efforts;
    if (input.effort !== undefined && !efforts.includes(input.effort)) throw new PartnerError("partner_effort_not_available", { allowed: efforts,
      instruction: "Use an effort listed for the model, or leave effort empty." });
    const inherited = inherits ? view.selection.effort : undefined, effort = input.effort ?? (inherited && efforts.includes(inherited) ? inherited : undefined);
    return { ...(kernel ? { kernel } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(input.effort === undefined && inherited && !effort ? { dropped: inherited } : {}) };
  }
  /** A new partner starts with the selection; a restored one keeps its own settings unless values were given. */
  private async applySelection(owner: string, agentId: string, selection: { model?: string; effort?: string }, restored: boolean) {
    try {
      const work = await this.port.sessions(owner, agentId);
      const { model: priorModel, effort: priorEffort, ...rest } = work.defaultSettings();
      const model = selection.model ?? (restored && typeof priorModel === "string" ? priorModel : undefined);
      const effort = selection.effort ?? (restored && typeof priorEffort === "string" ? priorEffort : undefined);
      if (model !== priorModel || effort !== priorEffort) work.setDefaultSettings({ ...rest, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    } catch (error) {
      throw new PartnerError("partner_settings_not_applied", { reason: code(error, "settings_unavailable"),
        instruction: "The partner exists, but its model settings could not be set, so it is not ready for work. Tell the owner; do not send it messages yet." });
    }
  }
  private async dismiss(admission: RunAdmission, turn: Turn, input: Input) {
    if (turn.kind !== "owner") throw new PartnerError("partner_owner_turn_required", { instruction: "A partner is dismissed only in a turn the owner started. Ask the owner first." });
    await this.conversation(admission, turn);
    const partners = this.partners(admission.owner), found = partners.find(agent => agent.name === input.name);
    if (!input.name || !found) throw new PartnerError("partner_not_found", { partners: partners.filter(agent => agent.id !== admission.agentId).map(agent => agent.name) });
    if (found.id === admission.agentId) throw new PartnerError("partner_is_self", { instruction: "A partner cannot dismiss itself." });
    await this.archive(admission.owner, found.id, this.self(admission).name);
    return { status: "dismissed", name: found.name, next: NEXT.dismissed };
  }
  /** Dismiss: archive. The partner keeps everything and is hidden from the roster; `restore` or a recruit of its name brings it back. */
  async archive(owner: string, agentId: string, by: string) {
    if (!this.partners(owner).some(agent => agent.id === agentId)) throw new PartnerError("partner_not_found");
    if (!this.dismissed(agentId)) this.store.set(DISMISSALS, agentId, { owner, at: iso(), by });
    await this.port.dismissed(owner, agentId);
  }
  restore(owner: string, agentId: string) {
    if (!this.partners(owner).some(agent => agent.id === agentId)) throw new PartnerError("partner_not_found");
    this.store.delete(DISMISSALS, agentId);
  }
  private checkText(text: string, external: () => boolean = () => false) {
    if (!text.trim()) throw new PartnerError("partner_message_empty", { instruction: "Write the message: the partner sees nothing else of this conversation." });
    if (Buffer.byteLength(text) > MESSAGE_BYTES) throw new PartnerError("partner_message_too_large", { limitBytes: MESSAGE_BYTES,
      instruction: external() ? "Shorten the message, or send it in parts: this partner is on the owner's own computer and cannot read files of your environment."
        : "Shorten the message, or put long material in a file in the shared environment and name the file." });
  }
  private async message(admission: RunAdmission, turn: Turn, input: Input, callId: string) {
    if (!input.intent || input.text === undefined || !input.to) throw new PartnerError("partners_invalid_input", { instruction: "action=message needs to, text and intent." });
    const { text, to } = input;
    this.checkText(text, () => this.external(admission.owner, this.recipient(admission, to).agentId));
    const origin = await this.origin(admission, turn);
    return this.send(admission, turn, origin, callId, this.recipient(admission, to), input.intent, text);
  }
  private async send(admission: RunAdmission, turn: Turn, origin: Origin, callId: string, to: Party, intent: Intent, text: string) {
    const owner = admission.owner, from = this.self(admission);
    if (intent !== "inform") {
      if (origin.chain >= CHAIN_LIMIT) throw new PartnerError("partner_chain_limit", { instruction:
        "Too many rounds of messages have followed one request of the owner. Tell the owner where things stand and wait for the owner's next message." });
      const waiting = this.outstanding(owner, ["sending", "running"]).filter(message => message.from.agentId === from.agentId);
      if (waiting.length >= WAITING_LIMIT) throw new PartnerError("partner_message_limit_reached", { waiting: waiting.map(message => ({ messageId: message.id, to: message.to.name })),
        instruction: `${WAITING_LIMIT} of your messages are waiting for replies, which is the limit. Nothing was queued. End this turn; send this one after a reply has come back.` });
    }
    const presence = this.port.presence(owner, to.agentId);
    if (presence?.external && !presence.reachable) throw new PartnerError("partner_unavailable", { device: presence.state,
      instruction: `"${to.name}" is an agent on the owner's own computer, and no computer is paired with it now. Nothing was sent. Tell the owner to pair it again.` });
    if (!presence?.reachable) throw new PartnerError("partner_unavailable", { environment: presence?.state ?? "none",
      instruction: `"${to.name}" cannot be woken by a message now: its environment is ${presence?.state ?? "missing"}. Nothing was sent. Tell the owner.` });
    if (intent === "inform" && this.outstanding(owner, ["queued"]).filter(message => message.to.agentId === to.agentId).length >= NOTE_LIMIT)
      throw new PartnerError("partner_note_limit_reached", { instruction: `${NOTE_LIMIT} notes already wait for "${to.name}" to read. Nothing was recorded. Send what matters as a message with intent ask or relay.` });
    const sender = this.authorization(admission, turn), theirs = this.port.connections(owner, to.agentId);
    const grants: Authorization = { ...sender, connections: sender.connections.filter(id => theirs.includes(id)) };
    const id = `pm-${digest([owner, from.agentId, admission.reference, callId]).slice(0, 32)}`;
    const message: PartnerMessage = { id, owner, from, to, intent, text, status: intent === "inform" ? "queued" : "sending", createdAt: iso(), origin, sender, grants };
    if (!this.store.insert(MESSAGES, id, message)) return this.receipt(this.store.get<PartnerMessage>(MESSAGES, id)!);
    // An owner's own turn starts a new line of work; what failed before it no longer counts against the sender.
    if (origin.chain === 0) this.store.delete(WAKES, from.agentId);
    if (intent === "inform") return this.receipt(message);
    try { await this.submit(message); }
    catch (error) {
      // The sender is told now, so nothing comes back later.
      const reason = code(error, "partner_unavailable");
      this.transition(id, ["sending"], current => ({ ...current, status: "collected", delivery: { attempts: 0, nextAttemptAt: iso(), via: "call", reason },
        result: { status: "rejected", answer: "", error: reason, settledAt: iso(), durationMs: 0 } }));
      throw new PartnerError("partner_message_not_sent", { reason, instruction: `The message did not reach "${to.name}" and nothing will come back for it. Tell the owner, or try again later.` });
    }
    return this.receipt(this.store.get<PartnerMessage>(MESSAGES, id)!);
  }
  private receipt(message: PartnerMessage) {
    const base = { status: message.intent === "inform" ? "recorded" : "sent", messageId: message.id, to: message.to.name, intent: message.intent };
    const presence = this.port.presence(message.owner, message.to.agentId);
    if (message.intent === "inform") return { ...base, expectsReply: false, next: presence?.external ? NEXT.informedExternal(message.to.name) : NEXT.informed(message.to.name) };
    return { ...base, expectsReply: true, next: presence?.external ? NEXT.sentExternal(message.to.name, presence.state === "ready") : NEXT.sent(message.to.name) };
  }
  private async wait(admission: RunAdmission, turn: Turn, input: Input, callId: string) {
    const owner = admission.owner, self = admission.agentId, task = await this.task(admission, turn);
    const ids = input.messageIds ?? this.outstanding(owner, ["sending", "running", "settled"]).filter(message => message.from.agentId === self).map(message => message.id).slice(0, BATCH);
    const read = () => ids.map(id => {
      const message = this.store.get<PartnerMessage>(MESSAGES, id);
      if (!message || message.owner !== owner || message.from.agentId !== self || !expectsReply(message)) throw new PartnerError("partner_message_not_found", { messageId: id,
        instruction: "Use the messageId a message action returned to you. An inform has no reply to wait for." });
      return message;
    });
    const deadline = Date.now() + (input.timeoutSeconds ?? 30) * 1000;
    let messages = read();
    // A turn that asks the owner does not end within a wait: the call returns as soon as one does.
    const asked = () => new Set(this.openCards(owner).map(card => card.messageId));
    while (messages.some(message => ["sending", "running"].includes(message.status)) && !messages.some(message => asked().has(message.id)) && Date.now() < deadline && !this.closed) {
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
      messages = read();
    }
    const approval = asked();
    // A result the sending turn reads here is not handed over a second time, once this call's answer has reached that
    // turn (`delivered`). A result of an earlier turn's message is only read: it is on its way as a turn of its own.
    const own = (message: PartnerMessage) => message.status === "settled" && message.origin.taskId === task;
    for (const message of messages) if (own(message))
      this.transition(message.id, ["settled"], current => ({ ...current, delivery: { ...current.delivery!, readBy: callId } }));
    const waiting = messages.filter(message => ["sending", "running"].includes(message.status));
    const results = messages.filter(message => message.result).map(message => ({ ...resultView(message),
      ...(message.status === "returning" || message.status === "settled" && !own(message) ? { alsoArriving: "This result also reaches you as a turn of its own." } : {}) }));
    return { results, pending: waiting.map(message => ({ messageId: message.id, to: message.to.name, sentAt: message.createdAt,
        ...(approval.has(message.id) ? { waitingFor: "owner_approval" } : {}) })),
      ...(waiting.some(message => approval.has(message.id)) ? { ownerApprovalNote: OWNER_APPROVAL } : {}),
      next: [results.length ? NEXT.results : "", waiting.length ? NEXT.stillWaiting : "", !results.length && !waiting.length ? NEXT.nothingWaiting : ""].filter(Boolean).join(" ") };
  }
  /** The answer of a partners call has reached the Host: what that call's wait returned to the sending turn counts as read. */
  delivered(admission: RunAdmission, callId: string) {
    for (const message of this.outstanding(admission.owner, ["settled"]))
      if (message.from.agentId === admission.agentId && message.delivery?.readBy === callId)
        this.transition(message.id, ["settled"], current => ({ ...current, status: "collected", delivery: { ...current.delivery!, via: "wait" } }));
  }

  // ---- What each turn is shown ----

  /**
   * What a turn is told beside its input: for a turn in the owner conversation (the owner's own, or one that hands
   * results over) the current roster and who it waits for, when its session has the tool to work with them; and for
   * every such turn and every turn that handles a message, the informs left for the partner.
   */
  async turnContext(admission: RunAdmission, roster: boolean): Promise<{ partners?: string; partnerNotes?: string }> {
    const turn = this.turn(admission);
    if (!turn) return {};
    try { if (turn.kind === "owner") await this.conversation(admission, turn); } catch { return {}; }
    const owner = admission.owner, self = admission.agentId;
    const notes = this.outstanding(owner, ["queued"]).filter(message => message.to.agentId === self).slice(0, 10);
    for (const note of notes) this.transition(note.id, ["queued"], current => ({ ...current, offeredTo: admission.reference }));
    const context = contextText({
      you: this.partners(owner).find(agent => agent.id === self)?.name ?? "",
      roster: turn.kind === "message" || !roster ? undefined : this.summary(owner, false).filter(partner => partner.id !== self).map(({ name, duty, status }) => ({ name, duty, status })),
      waiting: turn.kind === "message" || !roster ? [] : this.outstanding(owner, ["sending", "running", "settled", "returning"]).filter(message => message.from.agentId === self)
        .map(message => ({ to: message.to.name, intent: message.intent, sentAt: message.createdAt, answered: message.status !== "sending" && message.status !== "running" })),
      notes: notes.map(note => ({ from: note.from.name, sentAt: note.createdAt, text: note.text })),
    });
    return context;
  }
  /** A completed turn has read the informs its context carried. */
  turnCompleted(admission: RunAdmission) {
    for (const note of this.outstanding(admission.owner, ["queued"]))
      if (note.to.agentId === admission.agentId && note.offeredTo === admission.reference) this.transition(note.id, ["queued"], current => ({ ...current, status: "seen" }));
  }
  /** A run seen at a partner's Host: who is working now, and when a partner was last active. */
  observe(agentId: string, run: { id: string; status: string }) {
    const runs = this.active.get(agentId) ?? new Set<string>(), known = runs.has(run.id);
    if (run.status === "running") { if (!known) { runs.add(run.id); this.active.set(agentId, runs); this.store.set(ACTIVITY, agentId, { at: iso() }); } }
    else if (known) { runs.delete(run.id); this.store.set(ACTIVITY, agentId, { at: iso() }); }
  }
  // ---- Owner API ----

  /** The owner's messages between partners, newest first. */
  messages(owner: string, filter: { agentId?: string | undefined; limit?: number | undefined } = {}) {
    return this.store.newest<PartnerMessage>(MESSAGES, [{ members: ["owner"], value: owner },
      ...(filter.agentId ? [{ members: ["from.agentId", "to.agentId"], value: filter.agentId }] : [])], filter.limit ?? 50)
      .map(entry => entry.value).map(message => ({ id: message.id, from: { id: message.from.agentId, name: message.from.name }, to: { id: message.to.agentId, name: message.to.name },
        intent: message.intent, text: message.text, status: message.status, createdAt: message.createdAt, connectionId: message.origin.connectionId,
        ...(message.sentTo ? { sentTo: message.sentTo } : {}), ...(message.result ? { result: message.result } : {}),
        ...(message.delivery?.via ? { deliveredBy: message.delivery.via } : {}), ...(message.delivery?.reason ? { reason: message.delivery.reason } : {}) }));
  }
  /**
   * A deleted partner: its records go, with the messages it sent and the finished messages it received. A message
   * another partner still waits on ends as failed, and a result on its way to its sender is still handed over.
   */
  forget(owner: string, agentId: string) {
    for (const collection of [CURSORS, DISMISSALS, ACTIVITY, WAKES]) this.store.delete(collection, agentId);
    this.active.delete(agentId);
    for (const { id, value } of this.store.entries<{ agentId?: string; owner: string }>(RECRUITS)) if (value.owner === owner && value.agentId === agentId) this.store.delete(RECRUITS, id);
    for (const { id, value } of this.store.entries<ReturnBatch>(RETURNS)) if (value.agentId === agentId) this.store.delete(RETURNS, id);
    for (const { id, value: message } of this.store.entries<PartnerMessage>(MESSAGES)) {
      if (message.from.agentId === agentId) this.store.delete(MESSAGES, id);
      else if (message.to.agentId !== agentId) continue;
      else if (["sending", "running"].includes(message.status)) this.settle(message, { status: "failed", answer: "", error: "partner_deleted" });
      else if (!["settled", "returning"].includes(message.status)) this.store.delete(MESSAGES, id);
    }
  }

  // ---- Delivery ----

  private transition(id: string, from: Status[], change: (current: PartnerMessage) => PartnerMessage) {
    return this.store.transaction(() => {
      const current = this.store.get<PartnerMessage>(MESSAGES, id);
      if (!current || !from.includes(current.status)) return undefined;
      const next = change(current); this.store.set(MESSAGES, id, next); return next;
    });
  }
  /** Put a message in its recipient's work queue as a turn of the recipient's conversation with the owner. The same record always submits the same event. */
  private async submit(message: PartnerMessage) {
    const work = await this.port.sessions(message.owner, message.to.agentId), { sessionId } = work.openOwnerConversation();
    const settings = work.defaultSettings(), grants = message.grants;
    const sentTo = { kernel: this.port.kernel(message.to.agentId) ?? null,
      model: typeof settings.model === "string" ? settings.model : this.port.defaultModel(message.to.agentId) ?? null,
      effort: typeof settings.effort === "string" ? settings.effort : null };
    await work.submit({ eventId: message.id, sessionId,
      input: this.external(message.owner, message.to.agentId) ? externalIncomingText(message, this.carried(message)) : incomingText(message),
      sender: { kind: "agent", id: message.from.agentId, name: message.from.name },
      // What the owner is shown in the recipient's conversation: the message as its sender wrote it.
      display: { partnerMessage: { id: message.id, intent: message.intent, from: { id: message.from.agentId, name: message.from.name }, text: message.text } },
      context: { partnerMessage: { id: message.id, intent: message.intent, from: message.from.name } },
      admission: { kind: "delegation", owner: message.owner, agentId: message.to.agentId, reference: message.id,
        toolGrants: { feishu: grants.feishu, connectedApps: { connections: grants.connections, ...(grants.operations ? { operations: grants.operations } : {}) } },
        ...(grants.expiresAt ? { expiresAt: grants.expiresAt } : {}), ...(grants.maxToolCalls ? { maxToolCalls: grants.maxToolCalls } : {}) } });
    this.transition(message.id, ["sending"], current => ({ ...current, status: "running", sentTo }));
  }
  /**
   * The informs a message takes along to an agent on the owner's computer: those left before it that no message still
   * on its way carries. They are marked before the message is submitted, so that the same message always carries the same.
   */
  private carried(message: PartnerMessage) {
    const notes = this.outstanding(message.owner, ["queued"]).filter(note => note.to.agentId === message.to.agentId && note.createdAt <= message.createdAt);
    const free = (note: PartnerMessage) => !note.offeredTo || !["sending", "running"].includes(this.store.get<PartnerMessage>(MESSAGES, note.offeredTo)?.status ?? "");
    const taken = notes.filter(note => note.offeredTo === message.id);
    for (const note of notes.filter(free).slice(0, CARRIED_NOTES - taken.length))
      taken.push(this.transition(note.id, ["queued"], current => ({ ...current, offeredTo: message.id })) ?? note);
    return taken.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  private settle(message: PartnerMessage, result: { status: NonNullable<PartnerMessage["result"]>["status"]; answer: string; error?: string }, at = Date.now()) {
    return this.transition(message.id, ["sending", "running"], current => ({ ...current, status: "settled", delivery: { attempts: 0, nextAttemptAt: iso(at) },
      result: { ...result, settledAt: iso(at), durationMs: Math.max(0, at - Date.parse(current.createdAt)) } }));
  }
  private async cycle() {
    for (const step of [() => this.resume(), () => this.expire(), () => this.readSettlements(), () => this.passCards(), () => this.handOver(), () => this.cleanUp()]) {
      if (this.closed) return;
      try { await step(); } catch (error) { report("partner_delivery_failed", error); }
    }
  }
  /**
   * Records are not kept for ever either: a message that reached its end, and a hand-over that did, is removed 30
   * days after it was created. What the partners said stays in their conversations.
   */
  private cleanUp(now = Date.now()) {
    if (now - this.cleanedAt < CLEANUP_MS) return;
    this.cleanedAt = now;
    const before = iso(now - KEPT_MS);
    this.store.deleteBefore(MESSAGES, FINAL_MESSAGES, before);
    this.store.deleteBefore(RETURNS, FINAL_RETURNS, before);
    this.store.deleteBefore(CARDS, ["closed"], before);
  }
  private openCards(owner: string) {
    return this.store.entriesByStatus<PartnerCard>(CARDS, ["open"]).map(entry => entry.value).filter(card => card.owner === owner);
  }
  /**
   * What the kernel of a partner asks the owner in a turn that handles a message stands as a card in that partner's
   * own conversation, where the owner seldom is. An approval is copied to the conversation the message was sent from,
   * through the same desk a connector write is asked at; the owner's choice there answers the partner's card, and the
   * copy is withdrawn when that card is answered elsewhere, expires or its turn ends.
   */
  private async passCards() {
    const pending = new Map<string, WorkPendingCard>(), key = (agentId: string, cardId: string) => `${agentId}:${cardId}`;
    for (const { value: message } of this.store.entriesByStatus<PartnerMessage>(MESSAGES, ["running"])) {
      let cards: WorkPendingCard[];
      try { cards = (await this.port.sessions(message.owner, message.to.agentId)).lookup(message.id)?.pendingCards ?? []; }
      catch (error) { report("partner_cards_unread", error); continue; }
      for (const card of cards) {
        const id = key(message.to.agentId, card.cardId);
        pending.set(id, card);
        if (this.store.get<PartnerCard>(CARDS, id)) continue;
        // The owner approves what the card shows in full; a connector write that waits is already at the desk.
        const shown = card.kind === "approval" && card.choices.length > 0 && card.text.length <= APPROVAL_DISPLAY_LIMIT;
        const record: PartnerCard = { status: "open", owner: message.owner, agentId: message.to.agentId, messageId: message.id, cardId: card.cardId, createdAt: iso(),
          choices: card.choices.map(choice => choice.choiceId), ...(shown ? { desk: `partner-card-${digest(id).slice(0, 40)}` } : {}) };
        if (!this.store.insert(CARDS, id, record) || !record.desk) continue;
        try {
          await this.desk(message).open({ id: record.desk, summary: card.text, choices: card.choices.map(choice => ({ id: choice.choiceId, label: choice.label })),
            deadlineAt: card.deadlineAt ?? iso(Date.parse(message.createdAt) + UNANSWERED_MS) });
        } catch (error) {
          // Nowhere to ask there: the card stays in the partner's own conversation.
          report("partner_card_not_shown", error);
          const { desk: _desk, ...kept } = record; this.store.set(CARDS, id, kept);
        }
      }
    }
    for (const { id, value: card } of this.store.entriesByStatus<PartnerCard>(CARDS, ["open"])) {
      const message = this.store.get<PartnerMessage>(MESSAGES, card.messageId), close = () => this.store.set(CARDS, id, { ...card, status: "closed" });
      const desk = message && card.desk ? this.desk(message) : undefined;
      if (!pending.has(id)) { await desk?.withdraw(card.desk!).catch(() => undefined); close(); continue; }
      if (!desk) continue;
      const request = await desk.request(card.desk!).catch(() => undefined);
      if (!request || request.status === "pending") continue;
      // Only a choice of the card itself is passed on; anything else leaves the partner's own card as it is.
      if (request.status === "answered" && request.choice !== undefined && card.choices.includes(request.choice))
        await this.port.answerCard(card.owner, card.agentId, card.cardId, { key: card.desk!, by: request.answeredBy ?? null, surface: request.surface ?? "web", choiceId: request.choice });
      close();
    }
  }
  /** Messages recorded but not yet in their recipient's work queue: the call that sent them was interrupted. */
  private async resume() {
    for (const { value: message } of this.store.entriesByStatus<PartnerMessage>(MESSAGES, ["sending"])) {
      const age = Date.now() - Date.parse(message.createdAt);
      if (age < 10_000) continue;
      try { await this.submit(message); }
      catch (error) { if (age > SENDING_MS) this.settle(message, { status: "failed", answer: "", error: code(error, "partner_message_not_sent") }); }
    }
  }
  /**
   * Nothing waits for ever. A message whose recipient has not ended its turn in 48 hours (its environment stays
   * paused, its conversation stays busy) fails, and its turn is cancelled. A hand-over whose turn has not ended in
   * 48 hours is given up, and its results are dropped.
   */
  private async expire() {
    const now = Date.now(), cancel = (owner: string, agentId: string, eventId: string) =>
      this.port.sessions(owner, agentId).then(work => work.cancel(eventId)).catch(() => undefined);
    for (const { value: message } of this.store.entriesByStatus<PartnerMessage>(MESSAGES, ["sending", "running"])) {
      if (now - Date.parse(message.createdAt) <= UNANSWERED_MS) continue;
      if (this.settle(message, { status: "failed", answer: "", error: "no_answer_after_48_hours" })) await cancel(message.owner, message.to.agentId, message.id);
    }
    for (const { value: batch } of this.store.entriesByStatus<ReturnBatch>(RETURNS, ["submitted"])) {
      if (now - Date.parse(batch.createdAt) <= UNANSWERED_MS) continue;
      this.store.transaction(() => {
        this.store.set(RETURNS, batch.id, { ...batch, status: "failed" });
        for (const id of batch.messageIds) this.transition(id, ["returning"], current => ({ ...current, status: "dropped", delivery: { ...current.delivery!, reason: "undelivered_after_48_hours" } }));
      });
      await cancel(batch.owner, batch.agentId, batch.id);
    }
  }
  /** Read what ended at every agent that has a partner turn open, from where the last reading stopped. */
  private async readSettlements() {
    const open = new Map<string, string>();
    for (const { value } of this.store.entriesByStatus<PartnerMessage>(MESSAGES, ["running"])) open.set(value.to.agentId, value.owner);
    for (const { value } of this.store.entriesByStatus<ReturnBatch>(RETURNS, ["submitted"])) open.set(value.agentId, value.owner);
    for (const agentId of this.checked.keys()) if (!open.has(agentId)) this.checked.delete(agentId);
    for (const [agentId, owner] of open) {
      if (this.closed) return;
      // One agent whose records cannot be read does not hold up the others.
      try { await this.readAgent(owner, agentId); } catch (error) { report("partner_settlements_unread", error); }
    }
  }
  private async readAgent(owner: string, agentId: string) {
    const work = await this.port.sessions(owner, agentId);
    let cursor = this.store.get<number>(CURSORS, agentId) ?? 0;
    for (;;) {
      const page = work.settlements({ after: cursor, limit: 100 });
      for (const entry of page.data) if (entry.kind === "work") await this.ended(entry.event, Date.parse(entry.settledAt));
      if (page.cursor === cursor) break;
      cursor = page.cursor; this.store.set(CURSORS, agentId, cursor);
    }
    // What the feed does not say is read from the work events themselves, less often: a turn whose outcome is unknown
    // is not in the feed until someone closes it, and a turn that ended while a release without the feed was running
    // has no entry at all.
    const now = Date.now();
    if (now - (this.checked.get(agentId) ?? 0) < DIRECT_CHECK_MS) return;
    this.checked.set(agentId, now);
    for (const { value } of this.store.entriesByStatus<PartnerMessage>(MESSAGES, ["running"])) if (value.to.agentId === agentId) {
      const since = await this.direct(work, value.id, value.unknownSince);
      if (since !== value.unknownSince) this.transition(value.id, ["running"], ({ unknownSince: _since, ...current }) => ({ ...current, ...(since ? { unknownSince: since } : {}) }));
    }
    for (const { value } of this.store.entriesByStatus<ReturnBatch>(RETURNS, ["submitted"])) if (value.agentId === agentId) {
      if (!work.lookup(value.id)) {
        // Recorded, but the process stopped before the turn was submitted.
        try { await this.submitBatch(value); } catch (error) { this.retry(value, code(error, "turn_not_submitted")); }
        continue;
      }
      const since = await this.direct(work, value.id, value.unknownSince), current = this.store.get<ReturnBatch>(RETURNS, value.id);
      if (since !== value.unknownSince && current?.status === "submitted") {
        const { unknownSince: _since, ...rest } = current;
        this.store.set(RETURNS, value.id, { ...rest, ...(since ? { unknownSince: since } : {}) });
      }
    }
  }
  /**
   * Read one open turn from its work event. Returns since when its outcome has been unknown, if it still is. Router
   * finds a run again by itself after an interrupted submission, so an unknown outcome is reported only when it has
   * lasted.
   */
  private async direct(work: WorkSessions, eventId: string, unknownSince: string | undefined): Promise<string | undefined> {
    const event = work.lookup(eventId), now = Date.now();
    if (!event) return undefined;
    if (event.outcomeUnknown || event.status === "unknown") {
      const since = unknownSince ?? iso(now);
      if (now - Date.parse(since) < UNKNOWN_GRACE_MS) return since;
      await this.ended({ ...event, status: "unknown" }, now);
    } else if (ENDED.includes(event.status)) await this.ended(event, now);
    return undefined;
  }
  private async ended(event: WorkEventResult, at: number) {
    const status = (["completed", "failed", "cancelled", "rejected", "unknown"] as const).find(value => value === event.status) ?? "failed";
    const message = event.eventId.startsWith("pm-") ? this.store.get<PartnerMessage>(MESSAGES, event.eventId) : undefined;
    if (message) {
      this.settle(message, { status, answer: event.answer, ...(event.error ? { error: event.error } : status === "unknown" ? { error: "outcome_unknown" } : {}) }, at);
      // A completed turn has read the informs its message carried.
      if (status === "completed") for (const note of this.outstanding(message.owner, ["queued"]))
        if (note.offeredTo === message.id) this.transition(note.id, ["queued"], current => ({ ...current, status: "seen" }));
      // Repeated after a crash: the cards the run left open are closed whichever reading settled the message.
      if (event.runId) await this.port.closeApprovals(message.to.agentId, event.runId, id => this.desk(message).withdraw(id)).catch(() => undefined);
      return;
    }
    const batch = event.eventId.startsWith("pr-") ? this.store.get<ReturnBatch>(RETURNS, event.eventId) : undefined;
    if (!batch || batch.status !== "submitted") return;
    // The turn ran, or the owner stopped it, or its outcome is unknown: none of these is handed over again.
    if (status === "completed" || status === "cancelled" || status === "unknown") {
      this.store.transaction(() => {
        this.store.set(RETURNS, batch.id, { ...batch, status: "completed" });
        for (const id of batch.messageIds) this.transition(id, ["returning"], current => ({ ...current, status: "returned",
          delivery: { ...current.delivery!, via: "turn", ...(status === "completed" ? {} : { reason: status === "cancelled" ? "turn_cancelled" : "turn_outcome_unknown" }) } }));
      });
      return;
    }
    this.retry(batch, event.error ?? "turn_failed");
  }
  /** A hand-over that did not happen: its results wait for the next attempt, or are dropped after the last one. */
  private retry(batch: ReturnBatch, reason: string) {
    this.store.transaction(() => {
      this.store.set(RETURNS, batch.id, { ...batch, status: "failed" });
      for (const id of batch.messageIds) this.transition(id, ["returning"], current => batch.attempt >= DELIVERY_ATTEMPTS
        ? { ...current, status: "dropped", delivery: { attempts: batch.attempt, nextAttemptAt: iso(), reason: "delivery_attempts_exhausted" } }
        : { ...current, status: "settled", delivery: { attempts: batch.attempt, nextAttemptAt: iso(Date.now() + RETRY_SECONDS[batch.attempt - 1]! * 1000), reason } });
    });
  }
  /** Hand settled results to their senders: one turn per sender and route, after the turn that sent them has ended. */
  private async handOver() {
    const groups = new Map<string, PartnerMessage[]>(), now = Date.now();
    for (const { value: message } of this.store.entriesByStatus<PartnerMessage>(MESSAGES, ["settled"])) {
      if (now - Date.parse(message.result!.settledAt) > UNDELIVERED_MS) {
        this.transition(message.id, ["settled"], current => ({ ...current, status: "dropped", delivery: { ...current.delivery!, reason: "undelivered_after_48_hours" } })); continue;
      }
      if (Date.parse(message.delivery!.nextAttemptAt) > now) continue;
      const key = JSON.stringify([message.owner, message.from.agentId, message.origin.sessionId, message.origin.connectionId]);
      groups.set(key, [...groups.get(key) ?? [], message]);
    }
    for (const group of groups.values()) {
      if (this.closed) return;
      const { owner, from } = group[0]!;
      // A result is not handed over while the turn that sent its message still runs: that turn may be waiting for it.
      const ready: PartnerMessage[] = [];
      for (const message of group) if (ready.length < BATCH && await this.port.turnEnded(from.agentId, message.origin.taskId).catch(() => false)) ready.push(message);
      if (!ready.length) continue;
      const attempt = Math.max(...ready.map(message => message.delivery!.attempts)) + 1;
      const origin = { sessionId: ready[0]!.origin.sessionId, connectionId: ready[0]!.origin.connectionId, chain: Math.max(...ready.map(message => message.origin.chain)) };
      const authorization: Authorization = { feishu: ready.every(message => message.sender.feishu),
        connections: ready[0]!.sender.connections.filter(id => ready.every(message => message.sender.connections.includes(id))),
        write: ready.every(message => message.sender.write) };
      const operations = ready.map(message => message.sender.operations).filter((value): value is string[] => !!value);
      if (operations.length) authorization.operations = operations[0]!.filter(name => operations.every(list => list.includes(name)));
      let batch: ReturnBatch | undefined;
      try {
        const work = await this.port.sessions(owner, from.agentId);
        const wakes = this.store.get<number>(WAKES, from.agentId) ?? 0, failures = ready.every(failed);
        const connected = work.deliveryConnections().includes(origin.connectionId);
        if (failures && wakes >= FAILURE_WAKES) {
          // The sender was woken for failures often enough. The owner gets a line; the results stay readable.
          work.deliver({ eventId: `partner-notice-${digest(ready.map(message => message.id)).slice(0, 32)}`, targetSessionId: origin.sessionId, text: noticeText(ready),
            ...(connected ? { connectionId: origin.connectionId } : {}) });
          for (const message of ready) this.transition(message.id, ["settled"], current => ({ ...current, status: "returned", delivery: { ...current.delivery!, via: "notice", reason: "failure_wake_limit" } }));
          continue;
        }
        // Only what is still waiting now goes into the turn: a result may have been read with wait a moment ago.
        batch = this.store.transaction(() => {
          const taken = ready.filter(message => this.transition(message.id, ["settled"], current => ({ ...current, status: "returning" }))).map(message => message.id);
          if (!taken.length) return undefined;
          const record: ReturnBatch = { id: `pr-${digest([taken, attempt]).slice(0, 32)}`, owner, agentId: from.agentId, messageIds: taken, status: "submitted", origin, authorization,
            attempt, createdAt: iso(), reply: connected ? { connectionId: origin.connectionId } : {}, boundary: randomBytes(6).toString("hex") };
          for (const id of taken) this.transition(id, ["returning"], current => ({ ...current, delivery: { ...current.delivery!, batchId: record.id } }));
          this.store.set(RETURNS, record.id, record);
          return record;
        });
        if (!batch) continue;
        await this.submitBatch(batch);
        this.store.set(WAKES, from.agentId, failures ? wakes + 1 : 0);
      } catch (error) {
        report("partner_return_not_submitted", error);
        if (batch) this.retry(batch, code(error, "turn_not_submitted"));
        else for (const message of ready) this.transition(message.id, ["settled"], current => attempt >= DELIVERY_ATTEMPTS
          ? { ...current, status: "dropped", delivery: { attempts: attempt, nextAttemptAt: iso(), reason: "delivery_attempts_exhausted" } }
          : { ...current, delivery: { attempts: attempt, nextAttemptAt: iso(Date.now() + RETRY_SECONDS[attempt - 1]! * 1000), reason: code(error, "turn_not_submitted") } });
      }
    }
  }
  /** The turn that hands a batch to its sender. It answers the owner where the messages were sent from. The same batch always submits the same event. */
  private async submitBatch(batch: ReturnBatch) {
    const work = await this.port.sessions(batch.owner, batch.agentId);
    const messages = batch.messageIds.map(id => this.store.get<PartnerMessage>(MESSAGES, id)).filter((message): message is PartnerMessage => !!message);
    const senders = new Map(messages.map(message => [message.to.agentId, message.to.name])), authorization = batch.authorization;
    const share = Math.floor(SHOWN_ANSWER_BYTES / Math.max(1, messages.length));
    await work.submit({ eventId: batch.id, sessionId: batch.origin.sessionId, input: returnText(messages, batch.boundary),
      // What the owner is shown in the sender's conversation: each partner's result, apart from the lines written for the model.
      display: { partnerResults: messages.map(message => {
        const result = message.result!, answer = shortened(result.answer.trim(), share);
        return { messageId: message.id, partner: { id: message.to.agentId, name: message.to.name }, intent: message.intent, status: result.status,
          ...(result.error ? { error: result.error } : {}), answer: answer.text, ...(answer.cut ? { cut: answer.cut } : {}), durationMs: result.durationMs };
      }) },
      // One partner's results are that partner's; several partners' are the system's.
      ...(senders.size === 1 ? { sender: { kind: "agent" as const, id: [...senders.keys()][0]!, name: [...senders.values()][0]! } } : {}),
      reply: batch.reply, context: { partnerResults: batch.messageIds },
      admission: { kind: "delegation", owner: batch.owner, agentId: batch.agentId, reference: batch.id,
        toolGrants: { feishu: authorization.feishu, connectedApps: { connections: authorization.connections, ...(authorization.operations ? { operations: authorization.operations } : {}) } } } });
  }
  /** Where the owner is asked for a turn that handles a message: the conversation the message was sent from. */
  private desk(message: PartnerMessage): ApprovalDesk & { request(id: string): Promise<OwnerRequestResult | undefined> } {
    const work = () => this.port.sessions(message.owner, message.from.agentId);
    return {
      open: async card => {
        const sessions = await work(), connection = message.origin.connectionId;
        // The text is what a channel shows and what stands in the transcript. `display` carries the same as members, for a
        // console to show in its own words and language.
        const operation = card.connection === undefined ? undefined : { connection: card.connection, arguments: shownArguments(card.arguments) };
        sessions.request({ eventId: card.id, kind: "approval", title: `伙伴「${message.to.name}」请求批准`,
          text: [`处理「${message.from.name}」转来的消息时需要执行：${card.summary}`,
            ...(operation ? [`连接：${operation.connection}`, `参数：${operation.arguments}`] : [])].join("\n"),
          choices: card.choices ?? [{ id: "allow", label: "批准这次操作" }, { id: "deny", label: "拒绝这次操作", style: "danger" }], expiresAt: card.deadlineAt,
          display: { partnerApproval: { partner: { id: message.to.agentId, name: message.to.name }, from: { id: message.from.agentId, name: message.from.name },
            messageId: message.id, summary: card.summary, ...operation } },
          ...(sessions.deliveryConnections().includes(connection) ? { connectionId: connection } : {}) });
      },
      status: async id => {
        const request = (await work()).lookupRequest(id);
        if (!request || request.status === "expired") return "expired";
        if (request.status === "pending") return "pending";
        return request.status === "answered" && request.choice === "allow" ? "approved" : "denied";
      },
      withdraw: async id => { (await work()).withdrawRequest(id); },
      request: async id => (await work()).lookupRequest(id) ?? undefined,
    };
  }
}
