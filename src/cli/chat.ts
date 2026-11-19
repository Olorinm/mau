import { randomUUID } from "node:crypto";
import { router, type Client, type Partner } from "./client.js";
import { CliError, fail, noWait, text, type Command } from "./command.js";

// Router's owner ledger (`/_agent-router/v1/web`): chats, their events, turns and cards.
const web = router + "/web";
const chatPath = (chatId: string) => `${web}/chats/${encodeURIComponent(chatId)}`;
const directChat = (partner: Partner) => `dm:${partner.id}`;
const active = new Set(["queued", "running", "waiting"]);
const waitOption = { "no-wait": { type: "boolean" as const, help: "Return at once instead of waiting for the partner's turn." } };

/** The owner's direct chat with the partner; Router creates it on first use. */
async function openDirect(client: Client, partner: Partner) {
  return client.post(web + "/chats/dm", { agentId: partner.id }) as Promise<Chat>;
}
interface Chat { chatId: string; agentIds: string[]; pendingCards: number; activeTurns: number }
/** Every chat of the owner that is not archived. */
async function allChats(client: Client): Promise<Chat[]> {
  const chats: Chat[] = [];
  for (let cursor: string | null = null;;) {
    const page = await client.get(`${web}/chats?archived=false${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    chats.push(...page.data);
    if (!(cursor = page.next)) return chats;
  }
}
/** Every event of the chat after `seq`, oldest first. */
async function eventsAfter(client: Client, chatId: string, seq: number): Promise<any[]> {
  const events: any[] = [];
  for (;;) {
    const page = await client.get(`${chatPath(chatId)}/events?limit=200&after=${seq}`);
    if (page.mode === "reset") return fail("chat_history_replaced", { chatId });
    events.push(...page.events);
    if (page.newerCursor === null || !page.events.length) return events;
    seq = page.events.at(-1).seq;
  }
}
/** The chat's events from the newest back, a page at a time, until `enough` says so or the chat's beginning. */
async function eventsBack(client: Client, chatId: string, enough: (events: any[]) => boolean): Promise<any[]> {
  let events: any[] = [], before: number | undefined;
  for (;;) {
    const page = await client.get(`${chatPath(chatId)}/events?limit=200${before === undefined ? "" : "&before=" + before}`);
    events = [...page.events, ...events];
    if (page.olderCursor === null || enough(events)) return events;
    before = page.olderCursor;
  }
}
/** Cards among the events that nobody has answered and that have not expired or been withdrawn. */
function pendingCards(events: any[]) {
  const closed = new Set(events.filter(event => event.kind === "card.update" && event.status !== "pending").map(event => event.cardId));
  return events.filter(event => event.kind === "card" && event.card.status === "pending" && !closed.has(event.card.cardId)).map(event => event.card);
}
const message = (event: any) => ({ eventId: event.eventId, seq: event.seq, at: event.at, role: event.role, sender: event.sender?.name, text: event.text,
  ...(event.redacted ? { redacted: true } : {}), ...(event.attachments?.length ? { attachments: event.attachments } : {}),
  ...(event.channel ? { channel: event.channel.kind } : {}) });

/**
 * Follow one turn of a partner from the events after `seq`: until it ends, or until it asks the owner something (a
 * pending card). `turnOf` finds the turn among the events when its id is not known yet. Waits at most 30 minutes.
 */
async function followTurn(client: Client, chatId: string, seq: number, turnOf: (events: any[]) => string | undefined) {
  const deadline = Date.now() + 30 * 60_000, events: any[] = [];
  for (;;) {
    events.push(...await eventsAfter(client, chatId, events.at(-1)?.seq ?? seq));
    const turnId = turnOf(events);
    if (turnId) {
      const turn = await client.get(`${chatPath(chatId)}/turns/${encodeURIComponent(turnId)}`);
      // The turn's state is read before its last events: read those again so the answer is among them.
      if (!active.has(turn.state)) events.push(...await eventsAfter(client, chatId, events.at(-1)?.seq ?? seq));
      const mine = events.filter(event => event.turnId === turnId), cards = pendingCards(mine);
      const outcome = { turnId, state: turn.state as string,
        replies: mine.filter(event => event.kind === "message" && event.role === "assistant").map(message), pendingCards: cards };
      if (!active.has(turn.state)) {
        if (turn.state === "completed") return outcome;
        const error = events.findLast(event => event.kind === "turn" && event.turnId === turnId)?.error;
        throw new CliError("turn_" + turn.state, { chatId, ...outcome, ...(error ? { turnError: error } : {}) });
      }
      if (cards.length) return { ...outcome, state: "waiting" };
    }
    if (Date.now() > deadline) fail("turn_still_running", { chatId, ...(turnId ? { turnId } : {}) });
    await client.wait(1000);
  }
}

export const chatCommands: Command[] = [
  { path: ["chat", "list"], summary: "Your chats: one direct chat per partner, groups and observed conversations.",
    run: async ({ client }) => ({ data: await allChats(client()) }) },
  { path: ["chat", "show"], args: "NAME", summary: "The last messages of your direct chat with the partner, oldest first.",
    options: { limit: { type: "string", value: "N", help: "How many messages (1 to 500); 20 when not given." } },
    run: async ({ args, options, client }) => {
      const limit = Number(text(options.limit) ?? "20");
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail("invalid_limit");
      const chat = await openDirect(client(), await client().partner(args[0]!));
      const messages = (events: any[]) => events.filter(event => event.kind === "message");
      const events = await eventsBack(client(), chat.chatId, found => messages(found).length >= limit);
      return { chatId: chat.chatId, activeTurns: chat.activeTurns, pendingCards: chat.pendingCards, messages: messages(events).slice(-limit).map(message) };
    } },
  { path: ["chat", "send"], args: "NAME TEXT", options: waitOption,
    summary: "Send TEXT in your direct chat with the partner and wait for its turn: prints its replies, and the cards it asks you to answer.",
    run: async ({ args, options, client }) => {
      const chat = await openDirect(client(), await client().partner(args[0]!));
      const sent = await client().post(chatPath(chat.chatId) + "/messages", { idempotencyKey: randomUUID(), text: args[1] });
      const result = { chatId: chat.chatId, eventId: sent.event.eventId as string, seq: sent.event.seq as number };
      const queued = sent.addressed.some((item: { state: string }) => item.state === "queued");
      // A control message (such as `/new`) starts no turn; `--no-wait` does not wait for the one that was started.
      if (!queued || options["no-wait"]) return { ...result, state: queued ? "queued" : "not_queued", replies: [], pendingCards: [] };
      return { ...result, ...await followTurn(client(), chat.chatId, sent.event.seq,
        events => events.find(event => event.kind === "turn" && event.inputEventIds?.includes(sent.event.eventId))?.turnId) };
    } },
  { path: ["chat", "new"], args: "NAME", summary: "Start a new conversation with the partner; the chat keeps its history. Refused (session_busy) while a turn runs.",
    run: async ({ args, client }) => {
      const chat = await openDirect(client(), await client().partner(args[0]!));
      return client().post(chatPath(chat.chatId) + "/reset", { idempotencyKey: randomUUID() });
    } },

  { path: ["card", "list"], args: "[NAME]", summary: "The cards that wait for your answer (approvals, questions, schedule confirmations): of one partner's direct chat, or of every chat.",
    run: async ({ args, client }) => {
      const partners = await client().partners(), name = (id: string) => partners.find(partner => partner.id === id)?.name ?? id;
      const partner = args[0] === undefined ? undefined : partners.find(item => item.name === args[0]) ?? fail("partner_not_found", { name: args[0] });
      // A partner nobody has written to yet has no chat, and so no cards.
      const chats = (await allChats(client())).filter(chat => chat.pendingCards > 0 && (!partner || chat.chatId === directChat(partner)));
      const data: unknown[] = [];
      for (const chat of chats) {
        const events = await eventsBack(client(), chat.chatId, found => pendingCards(found).length >= chat.pendingCards);
        data.push(...pendingCards(events).map(card => ({ ...card, chatId: chat.chatId, partner: name(card.agentId) })));
      }
      return { data };
    } },
  { path: ["card", "answer"], args: "NAME CARD_ID ANSWER", options: noWait,
    summary: "Answer a card of the partner. ANSWER is one of the card's choices (its choiceId or its label), or free text when the card takes it. Then waits for the partner's turn like `chat send`.",
    run: async ({ args, options, client }) => {
      const partner = await client().partner(args[0]!), cardId = args[1]!, answer = args[2]!;
      // The card is in the direct chat, or in another chat the partner is a member of.
      const chats = [directChat(partner), ...(await allChats(client())).filter(chat => chat.agentIds.includes(partner.id) && chat.chatId !== directChat(partner)).map(chat => chat.chatId)];
      let chatId: string | undefined, card: any;
      for (const candidate of chats) {
        const reply = await client().call("GET", `${chatPath(candidate)}/cards/${encodeURIComponent(cardId)}`);
        if (reply.status === 200) { chatId = candidate; card = reply.data; break; }
      }
      if (!chatId) return fail("card_not_found", { cardId });
      const choices: Array<{ choiceId: string; label: string }> = card.choices ?? [];
      const choice = choices.find(item => item.choiceId === answer) ?? choices.find(item => item.label === answer);
      if (!choice && !card.freeText) fail("choice_not_found", { cardId, choices });
      // A card of a run continues that run's turn; a card that belongs to no run (a schedule confirmation), or to a
      // turn that is over, continues nothing. Read before answering: the turn may end right after.
      const turn = options["no-wait"] || !card.turnId ? undefined : await client().call("GET", `${chatPath(chatId)}/turns/${encodeURIComponent(card.turnId)}`);
      const seq = (await client().get(`${chatPath(chatId)}/events?limit=1`)).lastSeq as number;
      const answered = await client().post(`${chatPath(chatId)}/cards/${encodeURIComponent(cardId)}/answer`,
        { idempotencyKey: randomUUID(), ...(choice ? { choiceId: choice.choiceId } : { text: answer }) });
      if (answered.status === "stale") fail("card_already_answered", { card: answered.card });
      const result = { chatId, card: answered.card };
      return turn?.status === 200 && active.has(turn.data.state) ? { ...result, ...await followTurn(client(), chatId, seq, () => card.turnId) } : result;
    } },
];
