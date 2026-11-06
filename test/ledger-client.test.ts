import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../web/src/api/http";
import {
  LedgerClient, chatSourcePreference, foldEvents, ledgerApi, ledgerFeatures,
  type ChatEvent, type ChatEventBody, type ChatSummary, type EventPage, type HistoryQuery, type LedgerSocket,
  type LedgerTransport, type RedactResponse, type SendRequest, type SendResponse,
} from "../web/src/api/ledger";

// A fake Router web channel implementing the ADR 0005 §8 shapes: history paging, socket replay and idempotent send.
const owner = { type: "person" as const, id: "prs_owner", name: "Owner" };
const agent = { type: "agent" as const, id: "agent-1", name: "helper" };
const chatId = "dm:agent-1";

class FakeSocket implements LedgerSocket {
  onopen: LedgerSocket["onopen"] = null;
  onmessage: LedgerSocket["onmessage"] = null;
  onclose: LedgerSocket["onclose"] = null;
  onerror: LedgerSocket["onerror"] = null;
  readonly sent: string[] = [];
  readonly subscriptions = new Set<string>();
  closed = false;
  constructor(private server: FakeLedger, readonly url: string) {
    const ticket = new URL(url).searchParams.get("ticket") ?? "";
    // Tickets are single use.
    const valid = server.tickets.delete(ticket);
    setTimeout(() => valid ? this.push({ type: "event", event: "hello", data: { socketId: "so_1", epoch: server.epoch, heartbeatMs: 30_000, limits: { maxSubscriptions: 200, maxReplayEvents: 500 } } })
      : this.serverClose(4401), 0);
  }
  push(frame: unknown) { if (!this.closed) this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) }); }
  send(data: string) {
    if (this.closed) throw new Error("socket_closed");
    this.sent.push(data);
    if (data === "ping") return this.push("pong");
    const req = JSON.parse(data) as { id: string; method: string; params: { chats?: Array<{ chatId: string; afterSeq: number; generation: number }>; chatIds?: string[] } };
    if (req.method === "unsubscribe") { for (const id of req.params.chatIds ?? []) this.subscriptions.delete(id); return this.push({ type: "res", id: req.id, ok: true, result: {} }); }
    const replay: unknown[] = [], result: unknown[] = [], errors: unknown[] = [];
    for (const want of req.params.chats ?? []) {
      if (this.server.missing.has(want.chatId)) { errors.push({ chatId: want.chatId, code: "chat_not_found" }); continue; }
      const chat = this.server.chat(want.chatId);
      this.subscriptions.add(want.chatId);
      const missed = chat.events.filter((event) => event.seq > want.afterSeq);
      const reset = want.generation !== chat.generation || missed.length > 500;
      if (reset)
        replay.push({ type: "event", event: "snapshot_required", data: { chatId: want.chatId, reason: want.generation !== chat.generation ? "generation_changed" : "gap_too_large" } });
      else replay.push(...missed.map((event) => ({ type: "event", event: "chat.event", data: event })));
      result.push({ chatId: want.chatId, mode: reset ? "reset" : "delta", lastSeq: chat.lastSeq, generation: chat.generation });
    }
    this.push({ type: "res", id: req.id, ok: true, result: { chats: result, errors } });
    for (const frame of replay) this.push(frame);
  }
  close() { this.closed = true; }
  serverClose(code: number) { if (this.closed) return; this.closed = true; this.onclose?.({ code }); }
}

class FakeLedger implements LedgerTransport {
  epoch = "ep_1";
  pageLimit = 3;
  tickets = new Set<string>();
  /** Chats the socket reports in `result.errors` (deleted agent, foreign chat). */
  missing = new Set<string>();
  issued = 0;
  sockets: FakeSocket[] = [];
  history: HistoryQuery[] = [];
  sends: SendRequest[] = [];
  redacts: Array<{ eventId: string; idempotencyKey: string }> = [];
  /** Fail the next N sends before the server stores anything (connection refused). */
  failSends = 0;
  reads: number[] = [];
  /** Store the message, then fail the response, as a dropped connection would. */
  loseNextSendResponse = false;
  private readonly store = new Map<string, { generation: number; lastSeq: number; events: ChatEvent[]; readSeq: number }>();
  private readonly keys = new Map<string, { text: string; event: ChatEvent }>();
  private readonly redactKeys = new Map<string, { target: string; event: ChatEvent }>();
  chat(id: string) {
    let chat = this.store.get(id);
    if (!chat) { chat = { generation: 1, lastSeq: 0, events: [], readSeq: 0 }; this.store.set(id, chat); }
    return chat;
  }
  /** Append a durable event. `publish: false` simulates a frame lost on the way to this socket. */
  append(body: ChatEventBody, extra: Partial<ChatEvent> = {}, publish = true): ChatEvent {
    const chat = this.chat(chatId);
    const event = { chatId, seq: ++chat.lastSeq, generation: chat.generation, eventId: "ev_" + chat.lastSeq + "_" + chat.generation,
      at: new Date(0).toISOString(), sender: agent, ...extra, ...body } as ChatEvent;
    chat.events.push(event);
    if (publish) this.publish(event);
    return event;
  }
  publish(event: ChatEvent) {
    for (const socket of this.sockets) if (socket.subscriptions.has(event.chatId)) socket.push({ type: "event", event: "chat.event", data: event });
  }
  /** Rewrite history (backfill or purge): generation bumps and seq starts over. */
  rewrite(texts: string[]) {
    const chat = this.chat(chatId);
    chat.generation++; chat.lastSeq = 0; chat.events = [];
    for (const text of texts) this.append({ kind: "message", role: "assistant", text }, {}, false);
  }
  socket = (url: string) => { const socket = new FakeSocket(this, url); this.sockets.push(socket); return socket; };
  get live() { return this.sockets.at(-1)!; }

  async socketTicket() { const ticket = "tk_" + ++this.issued; this.tickets.add(ticket); return { ticket, expiresAt: new Date(60_000).toISOString() }; }
  async chats(): Promise<{ data: ChatSummary[]; next: string | null }> {
    const chat = this.chat(chatId);
    return { data: [{ chatId, kind: "dm", title: "helper", agentIds: ["agent-1"], readOnly: false, lastSeq: chat.lastSeq, generation: chat.generation,
      readSeq: chat.readSeq, unread: 0, lastEvent: null, activeTurns: 0, pendingCards: 0, updatedAt: new Date(0).toISOString() }], next: null };
  }
  async events(id: string, query: HistoryQuery = {}): Promise<EventPage> {
    this.history.push(query);
    const chat = this.chat(id), limit = query.limit ?? this.pageLimit;
    const base = { chatId: id, generation: chat.generation, lastSeq: chat.lastSeq, inflight: [] };
    if (query.after !== undefined) {
      if (query.generation !== chat.generation || chat.lastSeq - query.after > 1000)
        return { ...base, mode: "reset", reset: { reason: query.generation !== chat.generation ? "generation_changed" : "gap_too_large" }, events: [], olderCursor: null, newerCursor: null };
      const after = chat.events.filter((event) => event.seq > query.after!), events = after.slice(0, limit);
      return { ...base, mode: "delta", events, olderCursor: null, newerCursor: after.length > limit ? events.at(-1)!.seq : null };
    }
    const older = query.before === undefined ? chat.events : chat.events.filter((event) => event.seq < query.before!);
    const events = older.slice(-limit), first = events[0]?.seq ?? 1;
    return { ...base, mode: "page", events, olderCursor: first > 1 ? first : null, newerCursor: null };
  }
  async send(id: string, body: SendRequest): Promise<SendResponse> {
    this.sends.push(body);
    if (this.failSends > 0) { this.failSends--; throw new ApiError("network_error", 0); }
    const known = this.keys.get(body.idempotencyKey);
    if (known) {
      if (known.text !== body.text) throw new ApiError("idempotency_key_reused", 409);
      return { status: "duplicate", event: known.event, addressed: [] };
    }
    const event = this.append({ kind: "message", role: "user", text: body.text }, { chatId: id, sender: owner, idempotencyKey: body.idempotencyKey });
    this.keys.set(body.idempotencyKey, { text: body.text, event });
    if (this.loseNextSendResponse) { this.loseNextSendResponse = false; throw new ApiError("network_error", 0); }
    return { status: "accepted", event, addressed: [{ agentId: "agent-1", state: "queued" }] };
  }
  /** Owners withdraw only their own web messages; the stored redaction event is the answer. */
  async redact(id: string, eventId: string, idempotencyKey: string): Promise<RedactResponse> {
    this.redacts.push({ eventId, idempotencyKey });
    if (this.failSends > 0) { this.failSends--; throw new ApiError("network_error", 0); }
    const known = this.redactKeys.get(idempotencyKey);
    if (known) {
      if (known.target !== eventId) throw new ApiError("idempotency_key_reused", 409);
      return { status: "duplicate", event: known.event };
    }
    const target = this.chat(id).events.find((event) => event.eventId === eventId);
    if (!target) throw new ApiError("event_not_found", 404);
    if (target.sender.id !== owner.id || !target.idempotencyKey) throw new ApiError("redaction_not_allowed", 403);
    const event = this.append({ kind: "redaction", targetEventId: eventId }, { chatId: id, sender: owner });
    this.redactKeys.set(idempotencyKey, { target: eventId, event });
    return { status: "accepted", event };
  }
  async read(id: string, seq: number) {
    this.reads.push(seq);
    const chat = this.chat(id);
    chat.readSeq = Math.max(chat.readSeq, seq);
    return { readSeq: chat.readSeq, unread: 0 };
  }
}

const say = (text: string, role: "user" | "assistant" = "assistant") => ({ kind: "message" as const, role, text });
const texts = (client: LedgerClient) => client.view(chatId).events.flatMap((event) => event.kind === "message" ? [event.text] : []);
const seqs = (client: LedgerClient) => client.view(chatId).events.map((event) => event.seq);
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
let keyCounter = 0;
function setup(server = new FakeLedger()) {
  const client = new LedgerClient(server, {
    socket: server.socket, socketUrl: (ticket) => "wss://console.test/_agent-router/v1/web/socket?ticket=" + ticket,
    clock: { now: () => Date.now(), random: () => 0, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle as never) },
    idempotencyKey: () => "key_" + String(++keyCounter).padStart(16, "0"),
  });
  return { server, client };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("loads the latest page, subscribes after its seq, pages older history and applies live events once", async () => {
  const { server, client } = setup();
  for (const text of ["a", "b", "c", "d", "e"]) server.append(say(text), {}, false);
  await client.openChat(chatId);
  expect(texts(client)).toEqual(["c", "d", "e"]);
  expect(client.view(chatId).hasOlder).toBe(true);
  client.connect();
  await tick();
  expect(client.connection.state).toBe("open");
  expect(JSON.parse(server.live.sent[0]!)).toMatchObject({ type: "req", method: "subscribe", params: { chats: [{ chatId, afterSeq: 5, generation: 1 }], index: true } });
  const live = server.append(say("f"));
  server.publish(live);           // at-least-once: the same frame twice
  expect(texts(client)).toEqual(["c", "d", "e", "f"]);
  await client.loadOlder(chatId);
  expect(seqs(client)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(client.view(chatId).hasOlder).toBe(false);
});

it("repairs a seq gap from history and drops the frames it already has", async () => {
  const { server, client } = setup();
  server.append(say("one"), {}, false);
  await client.openChat(chatId);
  client.connect(); await tick();
  for (const text of ["two", "three", "four", "five"]) server.append(say(text), {}, false);   // lost frames
  server.append(say("six"));                                                                   // seq 6 arrives after a gap
  server.append(say("seven"));                                                                 // arrives while catching up
  await tick();
  expect(seqs(client)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(texts(client)).toEqual(["one", "two", "three", "four", "five", "six", "seven"]);
  // after=1 then the next delta page from its newerCursor
  expect(server.history.filter((query) => query.after !== undefined)).toEqual([{ after: 1, generation: 1 }, { after: 4, generation: 1 }]);
});

it("reloads the latest page on snapshot_required, a changed generation and a reset catch-up page", async () => {
  const { server, client } = setup();
  server.append(say("old"), {}, false);
  await client.openChat(chatId);
  client.connect(); await tick();
  // A live frame from a new generation.
  server.rewrite(["new 1", "new 2"]);
  server.publish(server.append(say("new 3"), {}, false));
  await tick();
  expect(client.view(chatId).generation).toBe(2);
  expect(texts(client)).toEqual(["new 1", "new 2", "new 3"]);
  // snapshot_required from the server.
  server.rewrite(["again"]);
  server.live.push({ type: "event", event: "snapshot_required", data: { chatId, reason: "generation_changed" } });
  await tick();
  expect(texts(client)).toEqual(["again"]);
  // A gap whose catch-up answers mode:"reset" (history rewritten in between).
  const stale = { ...server.append(say("x"), {}, false), seq: 9 };
  server.rewrite(["final"]);
  server.live.push({ type: "event", event: "chat.event", data: { ...stale, generation: 3 } });
  await tick();
  expect(client.view(chatId).generation).toBe(4);
  expect(texts(client)).toEqual(["final"]);
});

it("dedupes an optimistic send by idempotencyKey across a lost response, retry and socket echo", async () => {
  const { server, client } = setup();
  await client.openChat(chatId);
  client.connect(); await tick();
  server.loseNextSendResponse = true;
  // The socket delivered the stored event before the response was lost, so the send counts as done.
  await expect(client.send(chatId, { text: "hello" })).resolves.toBeUndefined();
  expect(client.view(chatId).pending).toEqual([]);
  expect(texts(client)).toEqual(["hello"]);
  // A failure before the server stored anything keeps the bubble and its key for retry.
  server.loseNextSendResponse = false;
  const send = server.send.bind(server);
  server.send = async () => { throw new ApiError("network_error", 0); };
  await expect(client.send(chatId, { text: "second" })).rejects.toBeInstanceOf(ApiError);
  const [pending] = client.view(chatId).pending;
  expect(pending).toMatchObject({ text: "second", state: "failed" });
  server.send = send;
  const response = await client.retry(pending!.idempotencyKey);
  expect(response?.status).toBe("accepted");
  // Retrying again answers duplicate with the original event; nothing is added.
  client["pending"].set(pending!.idempotencyKey, { ...pending!, state: "failed" });
  expect((await client.retry(pending!.idempotencyKey))?.status).toBe("duplicate");
  expect(texts(client)).toEqual(["hello", "second"]);
  expect(client.view(chatId).pending).toEqual([]);
  expect(server.sends.map((body) => body.idempotencyKey)).toEqual(["key_0000000000000001", "key_0000000000000002", "key_0000000000000002"]);
  // 4xx is final: the bubble is rejected, not retried.
  server.send = async () => { throw new ApiError("message_too_large", 413); };
  await expect(client.send(chatId, { text: "big" })).rejects.toMatchObject({ status: 413 });
  expect(client.view(chatId).pending[0]).toMatchObject({ state: "rejected", error: "message_too_large" });
});

it("shows the send response before the socket echo and replaces it without duplication", async () => {
  const { server, client } = setup();
  await client.openChat(chatId);         // not connected: the HTTP response is the only source
  await client.send(chatId, { text: "offline socket" });
  expect(texts(client)).toEqual(["offline socket"]);
  expect(client.view(chatId).pending).toEqual([]);
  client.connect(); await tick();        // subscribe afterSeq=1 replays nothing new
  server.publish(server.chat(chatId).events[0]!);
  expect(texts(client)).toEqual(["offline socket"]);
});

it("reconnects with jittered backoff, a fresh ticket and replay after the last seq; stops on 4401", async () => {
  const { server, client } = setup();
  server.append(say("before"), {}, false);
  await client.openChat(chatId);
  client.connect(); await tick();
  server.live.serverClose(1006);
  expect(client.connection.state).toBe("reconnecting");
  server.append(say("while away"), {}, false);
  await tick(499);
  expect(server.sockets).toHaveLength(1);
  await tick(1); await tick(1);  // attempt 0: 1 s ceiling, jitter floor 500 ms
  expect(server.sockets).toHaveLength(2);
  expect(server.live.url).toContain("ticket=tk_2");
  expect(client.connection).toMatchObject({ state: "open", attempt: 0 });
  expect(texts(client)).toEqual(["before", "while away"]);
  // Backpressure close reconnects and catches up the same way.
  server.live.serverClose(4408);
  server.append(say("after backpressure"), {}, false);
  await tick(500); await tick(1);
  expect(texts(client)).toEqual(["before", "while away", "after backpressure"]);
  // An expired login is final: no more dialing.
  server.live.serverClose(4401);
  await tick(120_000);
  expect(client.connection).toMatchObject({ state: "closed", error: "unauthorized" });
  expect(server.sockets).toHaveLength(3);
});

it("backs off exponentially while the socket cannot be opened", async () => {
  const { server, client } = setup();
  server.socketTicket = async () => { throw new ApiError("network_error", 0); };
  client.connect(); await tick();
  const delays: number[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const start = Date.now(), before = client.connection.attempt;
    while (client.connection.attempt === before) await tick(100);
    delays.push(Date.now() - start);
  }
  expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 15000]);   // ceiling/2 with random=0, capped at 30 s
  client.disconnect();
});

it("sends heartbeats and treats a silent socket as dead", async () => {
  const { server, client } = setup();
  await client.openChat(chatId);
  client.connect(); await tick();
  await tick(30_000);
  expect(server.live.sent.at(-1)).toBe("ping");
  const silent = server.live;
  silent.send = (data) => { silent.sent.push(data); };     // no more pong
  await tick(91_000);
  expect(silent.sent.filter((data) => data === "ping").length).toBeGreaterThan(1);
  expect(server.sockets.length).toBeGreaterThan(1);
});

it("restores in-flight text from streams and clears it with the final message", async () => {
  const { server, client } = setup();
  await client.openChat(chatId);
  client.connect(); await tick();
  server.live.push({ type: "event", event: "chat.stream", data: { chatId, turnId: "t1", agentId: "agent-1", state: "delta", text: "Hel", afterSeq: 0 } });
  server.live.push({ type: "event", event: "chat.stream", data: { chatId, turnId: "t1", agentId: "agent-1", state: "delta", text: "Hello", afterSeq: 0 } });
  expect(client.view(chatId).inflight).toMatchObject([{ turnId: "t1", text: "Hello" }]);
  server.append({ ...say("Hello world"), final: true }, { turnId: "t1" });
  expect(client.view(chatId).inflight).toEqual([]);
});

it("keeps read markers monotonic", async () => {
  const { server, client } = setup();
  for (const text of ["a", "b", "c"]) server.append(say(text), {}, false);
  await client.loadChats();
  await client.openChat(chatId);
  await client.markRead(chatId, 3);
  await client.markRead(chatId, 2);
  await client.markRead(chatId, 3);
  expect(server.reads).toEqual([3]);
  expect(client.view(chatId).readSeq).toBe(3);
});

it("folds edits, redactions, reactions, card updates, deliveries and turns into bubbles", () => {
  const event = (seq: number, body: ChatEventBody, extra: Partial<ChatEvent> = {}) =>
    ({ chatId, seq, generation: 1, eventId: "ev_" + seq, at: "", sender: agent, ...extra, ...body }) as ChatEvent;
  const card = { cardId: "cd_1", agentId: "agent-1", turnId: "t1", claimId: "c1", callId: "call", kind: "approval" as const, text: "Allow?",
    choices: [], freeText: false, deadlineAt: null, status: "pending" as const };
  const fold = foldEvents([
    event(1, say("hi", "user"), { sender: owner }),
    event(2, { kind: "turn", agentId: "agent-1", state: "running", inputEventIds: ["ev_1"] }, { turnId: "t1" }),
    event(3, { kind: "card", card }, { turnId: "t1" }),
    event(4, { kind: "card.update", cardId: "cd_1", status: "approved" }),
    event(5, { ...say("draft"), final: true }, { turnId: "t1" }),
    event(6, { kind: "edit", targetEventId: "ev_5", text: "edited" }),
    event(7, { kind: "edit", targetEventId: "ev_5", text: "not the author" }, { sender: owner }),
    event(8, { kind: "reaction", targetEventId: "ev_5", key: "👍", removed: false }, { sender: owner }),
    event(9, { kind: "delivery", targetEventId: "ev_5", delivery: { deliveryId: "d1", channel: { kind: "feishu" }, status: "queued" } }),
    event(10, { kind: "delivery", targetEventId: "ev_5", delivery: { deliveryId: "d1", channel: { kind: "feishu" }, status: "sent" } }),
    event(11, say("oops")),
    event(12, { kind: "redaction", targetEventId: "ev_11" }),
    event(13, { kind: "turn", agentId: "agent-1", state: "completed", inputEventIds: [] }, { turnId: "t1" }),
  ]);
  // A redacted message stays as a placeholder (rendered as 撤回), with its text cleared.
  expect(fold.items.map((item) => [item.kind, item.text, !!item.redacted])).toEqual([["message", "hi", false], ["card", "Allow?", false], ["message", "edited", false], ["message", "", true]]);
  expect(fold.items[2]).toMatchObject({ edited: true, reactions: [{ key: "👍", senders: ["prs_owner"] }], deliveries: [{ deliveryId: "d1", status: "sent" }] });
  expect(fold.cards.get("cd_1")?.status).toBe("approved");
  expect(fold.turns.get("t1")).toMatchObject({ state: "completed", inputEventIds: ["ev_1"], seq: 2 });
});

it("keeps Matrix unless the browser opts in, and reads features from the boolean map only", () => {
  const storage = (value: string | null) => ({ getItem: () => value });
  expect(chatSourcePreference(storage(null))).toBe("matrix");
  expect(chatSourcePreference(storage("matrix"))).toBe("matrix");
  expect(chatSourcePreference(storage("ledger"))).toBe("ledger");
  expect(chatSourcePreference({ getItem: () => { throw new Error("denied"); } })).toBe("matrix");
  const me = (features: unknown) => ({ person: { id: "p", name: "n" }, ownerId: "o", identities: [], limits: { features } }) as never;
  expect([...ledgerFeatures(me(["history", "send", "bogus"]))]).toEqual([]);
  expect([...ledgerFeatures(me({ history: true, send: false, cards: false, attachments: false, reset: false, groups: false, bogus: true }))]).toEqual(["history"]);
  expect([...ledgerFeatures(me({ history: true, cards: false, groups: true }))]).toEqual(["history", "groups"]);
  expect(ledgerFeatures(me(undefined)).size).toBe(0);
});

it("calls the web API with encoded chat ids, cursors, idempotency keys and raw attachment uploads", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const api = ledgerApi("token");
  await api.events("room:rm/1", { after: 4, generation: 2, limit: 10 });
  await api.events(chatId);
  await api.send(chatId, { idempotencyKey: "0123456789abcdef", text: "hi" });
  expect(() => api.send(chatId, { idempotencyKey: "short", text: "hi" })).toThrow("invalid_idempotency_key");
  await api.redact(chatId, "ev_1:x", "0123456789abcdef");
  expect(() => api.redact(chatId, "ev_1", "bad key")).toThrow("invalid_idempotency_key");
  await api.updateGroup("rm_1", { title: "t" });
  await api.uploadAttachment(new Blob(["abc"], { type: "text/plain" }), "笔记 1.txt");
  expect(calls.map(({ url, init }) => [init.method, url])).toEqual([
    ["GET", "/_agent-router/v1/web/chats/room%3Arm%2F1/events?after=4&generation=2&limit=10"],
    ["GET", "/_agent-router/v1/web/chats/dm%3Aagent-1/events"],
    ["POST", "/_agent-router/v1/web/chats/dm%3Aagent-1/messages"],
    ["POST", "/_agent-router/v1/web/chats/dm%3Aagent-1/messages/ev_1%3Ax/redact"],
    ["PATCH", "/_agent-router/v1/web/groups/rm_1"],
    ["POST", "/_agent-router/v1/web/attachments"],
  ]);
  expect(JSON.parse(calls[2]!.init.body as string)).toEqual({ idempotencyKey: "0123456789abcdef", text: "hi" });
  expect(JSON.parse(calls[3]!.init.body as string)).toEqual({ idempotencyKey: "0123456789abcdef" });
  expect(calls.map(({ init }) => init.credentials)).toEqual(["same-origin", "same-origin", "same-origin", "same-origin", "same-origin", "same-origin"]);
  expect(calls[5]!.init.headers).toMatchObject({
    Authorization: "Bearer token", "Content-Type": "text/plain", "X-File-Name": "UTF-8''%E7%AC%94%E8%AE%B0%201.txt",
    "X-Sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  });
});

it("retries a send whose response was lost with the same key and shows one message", async () => {
  const { server, client } = setup();
  await client.openChat(chatId);           // no socket: nothing echoes the stored event
  server.loseNextSendResponse = true;
  await expect(client.send(chatId, { text: "once" })).rejects.toMatchObject({ code: "network_error" });
  expect(client.view(chatId).pending).toMatchObject([{ text: "once", state: "failed" }]);
  const response = await client.retry(client.view(chatId).pending[0]!.idempotencyKey);
  expect(response?.status).toBe("duplicate");
  expect(texts(client)).toEqual(["once"]);
  expect(client.view(chatId).pending).toEqual([]);
  expect(server.chat(chatId).events).toHaveLength(1);
});

it("marks only the chats a subscribe reports in errors, and reloads a reset chat once", async () => {
  const { server, client } = setup();
  server.append(say("one"), {}, false);
  await client.openChat(chatId);
  await client.openChat("dm:gone");
  server.missing.add("dm:gone");
  client.connect(); await tick();
  expect(client.view(chatId).error).toBeUndefined();
  expect(client.view("dm:gone").error).toBe("chat_not_found");
  // Reconnect after a rewrite: the result says mode "reset" and a snapshot_required frame follows; one reload.
  server.rewrite(["new"]);
  const loads = server.history.filter((query) => query.after === undefined && query.before === undefined).length;
  server.live.serverClose(1012);
  await tick(2000);
  expect(texts(client)).toEqual(["new"]);
  expect(server.history.filter((query) => query.after === undefined && query.before === undefined).length - loads).toBe(1);
});

it("resends automatically after network failures with the same key, then waits for a manual retry", async () => {
  const { server, client } = setup();
  await client.openChat(chatId);
  client.connect(); await tick();
  server.failSends = 2;
  await expect(client.send(chatId, { text: "flaky" })).rejects.toMatchObject({ code: "network_error" });
  expect(client.view(chatId).pending).toMatchObject([{ text: "flaky", state: "failed", attempts: 1, retryAt: expect.any(Number) }]);
  await tick(1000);                 // second attempt fails too; the next waits 2 s
  expect(client.view(chatId).pending).toMatchObject([{ state: "failed", attempts: 2 }]);
  await tick(1999);
  expect(server.sends).toHaveLength(2);
  await tick(1);                    // third attempt is stored and echoed once
  expect(client.view(chatId).pending).toEqual([]);
  expect(texts(client)).toEqual(["flaky"]);
  expect(new Set(server.sends.map((body) => body.idempotencyKey)).size).toBe(1);

  // Retries are bounded; afterwards the bubble stays failed with a manual retry and no timer.
  server.failSends = 10;
  await expect(client.send(chatId, { text: "offline" })).rejects.toMatchObject({ code: "network_error" });
  await tick(1000); await tick(2000); await tick(4000);
  const [stuck] = client.view(chatId).pending;
  expect(stuck).toMatchObject({ state: "failed", attempts: 4 });
  expect(stuck!.retryAt).toBeUndefined();
  await tick(60_000);
  expect(server.sends.filter((body) => body.text === "offline")).toHaveLength(4);
  server.failSends = 0;
  expect((await client.retry(stuck!.idempotencyKey))?.status).toBe("accepted");
  expect(texts(client)).toEqual(["flaky", "offline"]);
  // A dismissed bubble cancels its scheduled resend.
  server.failSends = 1;
  await expect(client.send(chatId, { text: "dropped" })).rejects.toBeInstanceOf(ApiError);
  client.discard(client.view(chatId).pending[0]!.idempotencyKey);
  await tick(5000);
  expect(server.sends.filter((body) => body.text === "dropped")).toHaveLength(1);
});

it("rejects an idempotency conflict (409) without retrying", async () => {
  const { server, client } = setup();
  await client.openChat(chatId);
  await client.send(chatId, { text: "first" });
  // A second intent that reuses the key with a different body (for example a restored draft) is a conflict.
  const reused = server.sends[0]!.idempotencyKey;
  const conflicting = new LedgerClient(server, { socket: server.socket, idempotencyKey: () => reused,
    clock: { now: () => Date.now(), random: () => 0, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle as never) } });
  await conflicting.openChat(chatId);
  await expect(conflicting.send(chatId, { text: "different" })).rejects.toMatchObject({ status: 409, code: "idempotency_key_reused" });
  expect(conflicting.view(chatId).pending).toMatchObject([{ state: "rejected", error: "idempotency_key_reused" }]);
  expect(conflicting.view(chatId).pending[0]!.retryAt).toBeUndefined();
  await tick(10_000);
  expect(server.sends).toHaveLength(2);
  expect(texts(conflicting)).toEqual(["first"]);
});

it("redacts an own web message once, retrying with the same key, and folds it into a placeholder", async () => {
  const { server, client } = setup();
  await client.openChat(chatId);
  client.connect(); await tick();
  await client.send(chatId, { text: "take this back" });
  const target = client.view(chatId).events.find((event) => event.kind === "message")!;
  server.failSends = 1;
  await expect(client.redact(chatId, target.eventId)).rejects.toMatchObject({ code: "network_error" });
  expect(client.view(chatId).redactions).toMatchObject([{ eventId: target.eventId, state: "failed" }]);
  expect((await client.redact(chatId, target.eventId))?.status).toBe("accepted");
  expect(client.view(chatId).redactions).toEqual([]);
  expect(server.redacts.map((item) => item.idempotencyKey)).toEqual([server.redacts[0]!.idempotencyKey, server.redacts[0]!.idempotencyKey]);
  // The socket echo of the redaction is applied once.
  expect(client.view(chatId).events.filter((event) => event.kind === "redaction")).toHaveLength(1);
  const fold = foldEvents(client.view(chatId).events);
  expect(fold.items).toMatchObject([{ eventId: target.eventId, redacted: true, text: "" }]);
  // Agent messages and other channels cannot be withdrawn: the server refuses and nothing is retried.
  const reply = server.append(say("agent reply"));
  await expect(client.redact(chatId, reply.eventId)).rejects.toMatchObject({ status: 403 });
  expect(client.view(chatId).redactions).toMatchObject([{ eventId: reply.eventId, state: "rejected", error: "redaction_not_allowed" }]);
  client.dismissRedaction(chatId, reply.eventId);
  expect(client.view(chatId).redactions).toEqual([]);
});

it("keeps the origin channel of merged owner messages for badges", () => {
  const event = (seq: number, channel: ChatEvent["channel"]) =>
    ({ chatId, seq, generation: 1, eventId: "ev_" + seq, at: "", sender: owner, ...(channel ? { channel } : {}), ...say("hi " + seq, "user") }) as ChatEvent;
  const fold = foldEvents([event(1, { kind: "feishu" }), event(2, { kind: "grove-mail", label: "work mail" }), event(3, { kind: "web" }), event(4, undefined)]);
  expect(fold.items.map((item) => item.channel)).toEqual([{ kind: "feishu" }, { kind: "grove-mail", label: "work mail" }, { kind: "web" }, undefined]);
});
