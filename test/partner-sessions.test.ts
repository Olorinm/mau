import { afterEach, expect, it, vi } from "vitest";
import { contextTokens, runContextTokens } from "../src/context-size.js";
import { PartnerSessions, SPENT_IDLE_MS, SPENT_TOKENS, titleOf, type SessionUse } from "../src/partner-sessions.js";
import { DurableStore } from "../src/store.js";
import { SESSION_REFUSED, SESSIONS_NOTE, continuedText } from "../src/partner-text.js";
import { alice } from "./fixtures/mau.js";
import { partnersFixture, type PartnersFixture, type Turn } from "./fixtures/partners.js";

// The sessions a partner works in: one for each piece of work another partner sent it, beside its conversation with the
// owner. Through real Router runtimes and a scripted Host, like `partners.test.ts`.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const duty = "Plans the Korea trip and tracks its bookings";

/** The partners tool called as an owner turn that is open at the Host. */
async function ownerTurn(f: PartnersFixture, agentId: string, index = 0) {
  await f.say(agentId, "Work with my partners");
  const turn = await f.turnOf(agentId, index), admission = await f.admission(turn);
  let calls = 0;
  return { turn, call: (input: Record<string, unknown>) => f.mau.partners.execute(admission, input, `${turn.runId}-direct-${++calls}`) as Promise<any> };
}
/** The kernel of a run reports how full its session's context is, as Codex does: the thread the session is bound to, then that thread's usage. */
const reports = (f: PartnersFixture, turn: Turn, tokens: number) => f.runs.get(turn.runId)!.events.push({ type: "session.bound", runId: turn.runId, threadId: "main", resumed: false },
  { type: "native.notification", runId: turn.runId, threadId: "main",
    notification: { method: "thread/tokenUsage/updated", params: { threadId: "main", tokenUsage: { total: { inputTokens: tokens * 3 }, last: { inputTokens: tokens } } } } });
/** Everything that ended has been counted, and nothing else is on its way into the count. */
const quiet = async (f: PartnersFixture) => {
  for (let n = 0; n < 40; n++) {
    await f.mau.completedTurns.tick(); await f.mau.partners.tick();
    if (!f.store(store => store.entriesByStatus("employee_completed_turns", ["queued"]).length)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("timeout_quiet");
};
/** What Mau has counted of a partner's session, once the turns that ended there are counted. */
const use = (f: PartnersFixture, agentId: string, sessionId: string, turns: number) => f.until(async () => {
  await quiet(f);
  const record = f.store(store => store.get<SessionUse>("partner_session_use", `${agentId}:${sessionId}`));
  return record && record.turns >= turns ? record : undefined;
}, `use of ${sessionId}`);
/** A session as if it had last been used two days ago. */
const cold = (f: PartnersFixture, agentId: string, sessionId: string) => f.store(store => {
  const key = `${agentId}:${sessionId}`, record = store.get<SessionUse>("partner_session_use", key)!;
  store.set("partner_session_use", key, { ...record, lastAt: new Date(Date.now() - 2 * SPENT_IDLE_MS).toISOString() });
});
const window = async (f: PartnersFixture, agentId: string) => (await f.events(agentId)).filter(event => event.kind === "window").length;
/** How often a session of a partner went on in a new context. */
const windows = async (f: PartnersFixture, agentId: string, sessionId: string) => (await f.thread(agentId, sessionId)).filter(event => event.kind === "window").length;

it("reads the size of a session's context from what each kernel reports", async () => {
  const event = (method: string, params: unknown) => ({ type: "native.notification", runId: "run", notification: { method, params } });
  const bound = { type: "session.bound", runId: "run", threadId: "main" };
  const served = (events: unknown[]) => ({ events: async () => ({ events: events.map(item => ({ event: item as Record<string, unknown> })), cursor: events.length, hasMore: false }) });
  // The last request of a Codex thread, not the thread's running total.
  expect(contextTokens(event("thread/tokenUsage/updated", { threadId: "main", tokenUsage: { total: { inputTokens: 900_000 }, last: { inputTokens: 120_000, cachedInputTokens: 100_000, outputTokens: 800 } } }), "main")).toBe(120_000);
  // A Claude request counts what it read from and wrote to the cache apart from its input.
  expect(contextTokens(event("claude.message", { type: "assistant", message: { usage: { input_tokens: 12, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 4_000, output_tokens: 900 } } }))).toBe(84_012);
  expect(contextTokens(event("claude.message", { type: "result", usage: { input_tokens: 500_000 } }))).toBeUndefined();
  expect(contextTokens(event("session/update", { update: { sessionUpdate: "usage_update", used: 53_000, size: 200_000 } }))).toBe(53_000);
  expect(contextTokens(event("item/completed", { item: { type: "commandExecution" } }))).toBeUndefined();
  expect(contextTokens({ type: "usage", runId: "run", scope: "session", inputTokens: 900_000 })).toBeUndefined();
  // The size after a run is what its last event that states one says, however many pages the events take.
  const pages = [[bound, event("thread/tokenUsage/updated", { threadId: "main", tokenUsage: { last: { inputTokens: 10_000 } } }), event("item/completed", {})],
    [event("thread/tokenUsage/updated", { threadId: "main", tokenUsage: { last: { inputTokens: 30_000 } } }), event("turn/completed", {})]];
  const host = { events: async (_runId: string, after: number) => ({ events: (pages[after] ?? []).map(item => ({ event: item })), cursor: after + 1, hasMore: after + 1 < pages.length }) };
  expect(await runContextTokens(host, "run")).toBe(30_000);
  expect(await runContextTokens({ events: async () => ({ events: [], cursor: 0, hasMore: false }) }, "run")).toBeUndefined();
  // A kernel's sub-agent works in a context of its own, and its Host puts what it reports in the same run. A thread Codex
  // spawned reports under its own id, here after the session's own thread has reported for the last time.
  const usage = (threadId: string, tokens: number) => ({ ...event("thread/tokenUsage/updated", { threadId, tokenUsage: { last: { inputTokens: tokens } } }), threadId });
  expect(await runContextTokens(served([bound, usage("main", 32_000), usage("child", 270_000)]), "run")).toBe(32_000);
  expect(contextTokens(usage("child", 270_000), "main")).toBeUndefined();
  // The Host no longer has the beginning of the run, with the event that says which thread is the session's: whose
  // usage each one is cannot be told, and the size is not known. A wrong size would be acted on; an unknown one is not.
  expect(await runContextTokens(served([usage("main", 32_000), usage("child", 270_000)]), "run")).toBeUndefined();
  expect(contextTokens(usage("main", 32_000))).toBeUndefined();
  // A run with more events than are read is not read to its end: what was read is an earlier size, not the size after the run.
  let asked = 0;
  const endless = { events: async (_runId: string, after: number) => { asked++; return { events: [{ event: after ? usage("main", 40_000 + after) : bound }], cursor: after + 1, hasMore: true }; } };
  expect(await runContextTokens(endless, "run")).toBeUndefined(); expect(asked).toBe(200);
  // Neither is a run whose Host stops serving before the end.
  expect(await runContextTokens({ events: async () => ({ events: [], cursor: 0, hasMore: true }) }, "run")).toBeUndefined();
  // A Claude sub-agent's message names the tool call that started it; OpenCode marks what a child session reports.
  expect(contextTokens(event("claude.message", { type: "assistant", parent_tool_use_id: "toolu_1", message: { usage: { input_tokens: 9, cache_read_input_tokens: 300_000 } } }))).toBeUndefined();
  expect(contextTokens(event("claude.message", { type: "assistant", parent_tool_use_id: null, message: { usage: { input_tokens: 9, cache_read_input_tokens: 70_000 } } }))).toBe(70_009);
  expect(contextTokens(event("session/update", { update: { sessionUpdate: "usage_update", used: 300_000, _meta: { "opencode/child-session": true } } }))).toBeUndefined();
  // Pi ends each assistant message with the usage of the request that produced it.
  expect(contextTokens(event("pi/message_end", { event: { type: "message_end", entry: { model: [{ role: "assistant", usage: { input: 1_200, output: 50, cacheRead: 40_000, cacheWrite: 800 } }] } } }))).toBe(42_000);
  expect(contextTokens(event("pi/message_end", { event: { type: "message_end", entry: { model: [{ role: "toolResult" }] } } }))).toBeUndefined();
  expect(titleOf("\n  Find hotels   in Seoul.\nFive nights in May.")).toBe("Find hotels in Seoul.");
  expect(Array.from(titleOf("长".repeat(200)))).toHaveLength(60);
});

it("keeps the sessions a deleted partner opened at others, and removes its own", () => {
  const store = new DurableStore(":memory:", "sessions"), sessions = new PartnerSessions(store);
  try {
    sessions.open({ id: "ps-a", owner: alice, agentId: "trip", title: "Hotels", startedBy: { agentId: "desk", name: "desk" } });
    sessions.open({ id: "ps-b", owner: alice, agentId: "desk", title: "Budget", startedBy: { agentId: "trip", name: "trip" } });
    sessions.used(alice, "trip", "ps-a", 12_000); sessions.used(alice, "desk", "ps-b", undefined); sessions.used(alice, "desk", "ps-b", 9_000);
    expect(sessions.use("desk", "ps-b")).toMatchObject({ turns: 2, tokens: 9_000 });
    // A size reported once is kept when a later run reports none.
    sessions.used(alice, "trip", "ps-a", undefined);
    expect(sessions.use("trip", "ps-a")).toMatchObject({ turns: 2, tokens: 12_000 });
    sessions.forget("desk");
    expect(sessions.began(alice, "trip", 10)).toMatchObject([{ id: "ps-a", startedBy: { name: "desk" } }]);
    expect(sessions.began(alice, "desk", 10)).toEqual([]); expect(sessions.use("desk", "ps-b")).toBeUndefined();
    // Large is not enough, and neither is cold: a session is spent when it is both.
    const day = SPENT_IDLE_MS, at = Date.parse("2026-11-01T00:00:00Z"), use = (tokens: number | undefined) => ({ owner: alice, agentId: "trip", sessionId: "ps-a", turns: 1,
      lastAt: new Date(at).toISOString(), ...(tokens === undefined ? {} : { tokens }) });
    expect(sessions.spent(use(SPENT_TOKENS + 1), at + day + 1)).toBe(true);
    expect(sessions.spent(use(SPENT_TOKENS + 1), at + day)).toBe(false);
    expect(sessions.spent(use(SPENT_TOKENS), at + 2 * day)).toBe(false);
    expect(sessions.spent(use(undefined), at + 2 * day)).toBe(false);
  } finally { store.close(); }
});

it("a message opens a session of its own at the partner, and one that names a session continues it", async () => {
  const f = await partnersFixture(cleanup), end = f.hold();
  const hub = await ownerTurn(f, f.agent.id);
  const first = await hub.call({ action: "recruit", name: "trip", duty, intent: "ask", title: "  Seoul hotels ", message: "Find three hotels in Seoul.\nFive nights in May." });
  const trip = f.partner("trip"), hotels = await f.turnOf(trip.id, 0);
  expect(first.message).toMatchObject({ status: "sent", session: expect.stringMatching(/^ps-[0-9a-f]{32}$/), title: "Seoul hotels" });
  // Another piece of work is another session. It runs while the first one still does, in a context of its own.
  const second = await hub.call({ action: "message", to: "trip", intent: "ask", text: "Find restaurants near Myeongdong." });
  const food = await f.turnOf(trip.id, 1);
  expect(second).toMatchObject({ status: "sent", title: "Find restaurants near Myeongdong." });
  expect(second.session).not.toBe(first.message.session);
  expect(food.body.sessionId).not.toBe(hotels.body.sessionId);
  expect(f.record(second.messageId).sessionId).toBe(second.session);
  // The sender sees the sessions it opened there; the partner sees its own work spread over them.
  const theirs = await hub.call({ action: "sessions", name: "trip" });
  expect(theirs).toEqual({ partner: "trip", note: SESSIONS_NOTE.theirs, sessions: [
    { id: second.session, title: "Find restaurants near Myeongdong.", turns: 0, lastAt: expect.any(String), state: "working" },
    { id: first.message.session, title: "Seoul hotels", turns: 0, lastAt: expect.any(String), state: "working" }] });
  // The one used last comes first; nothing has ended in either yet.
  const own = await food.call("partners", { action: "sessions" });
  expect(own.sessions).toMatchObject([{ id: second.session, state: "working" }, { id: first.message.session, title: "Seoul hotels", startedBy: "helper", turns: 0, state: "working" }]);
  // The first piece of work ends, and a message that names its session goes on there: the same context at the Host.
  reports(f, hotels, 21_000); end(hotels, "Lotte, Shilla, Four Seasons.");
  expect(await use(f, trip.id, first.message.session, 1)).toMatchObject({ turns: 1, tokens: 21_000 });
  const more = await hub.call({ action: "message", to: "trip", intent: "ask", session: first.message.session, text: "Which one is closest to the station?" });
  expect(more).toMatchObject({ status: "sent", session: first.message.session, title: "Seoul hotels" });
  const closest = await f.turnOf(trip.id, 2);
  expect(closest.body.sessionId).toBe(hotels.body.sessionId);
  expect((await hub.call({ action: "sessions", name: "trip" })).sessions[1]).toMatchObject({ id: first.message.session, turns: 1, tokens: 21_000, state: "working" });
  // What was said in a session stands there, in order, and nothing of it in the partner's conversation with the owner.
  end(closest, "The Lotte.");
  await f.until(() => f.record(more.messageId).status === "settled" || f.record(more.messageId).status === "returning", "second answer");
  expect((await f.thread(trip.id, first.message.session)).filter(event => event.kind === "message").map(event => [event.role, event.kind === "message" && event.text])).toEqual([
    ["user", expect.stringContaining("Find three hotels")], ["assistant", "Lotte, Shilla, Four Seasons."], ["user", expect.stringContaining("Which one is closest")], ["assistant", "The Lotte."]]);
  expect((await f.events(trip.id)).filter(event => event.kind === "message")).toEqual([]);
  // The owner's console lists the partner's sessions as threads of that partner.
  await use(f, trip.id, first.message.session, 2);
  const listed = (await f.api(`/agents/${trip.id}/sessions`)).data;
  expect(listed.earlier).toBeNull();
  // The one a turn runs in, then the one something happened in last.
  expect(listed.active.map((thread: { id: string }) => thread.id)).toEqual([second.session, first.message.session]);
  expect(listed.data).toMatchObject([
    { id: first.message.session, chatId: `obs:${trip.id}:${first.message.session}`, title: "Seoul hotels", startedBy: { id: f.agent.id, name: "helper" }, turns: 2, tokens: 21_000, working: false },
    { id: second.session, title: "Find restaurants near Myeongdong.", turns: 0, working: true }]);
  expect((await f.api(`/agents/${trip.id}/sessions`, undefined, "bob")).status).toBe(404);
  end(food, "Three places."); end(hub.turn);
}, 60_000);

it("continues only a session the sender opened, and keeps informs and agents on a computer out of sessions", async () => {
  const f = await partnersFixture(cleanup), end = f.hold();
  const hub = await ownerTurn(f, f.agent.id);
  const sent = await hub.call({ action: "recruit", name: "trip", duty, intent: "ask", message: "Find three hotels in Seoul." });
  await hub.call({ action: "recruit", name: "food", duty: "Finds restaurants" });
  const trip = f.partner("trip"), food = f.partner("food");
  expect(await hub.call({ action: "message", to: "trip", intent: "ask", session: "ps-unknown", text: "Go on." })).toMatchObject({ isError: true, error: "partner_session_not_found", instruction: SESSION_REFUSED.notFound });
  // A session of one partner is not a session of another.
  expect(await hub.call({ action: "message", to: "food", intent: "ask", session: sent.message.session, text: "Go on." })).toMatchObject({ isError: true, error: "partner_session_not_found" });
  expect(await hub.call({ action: "message", to: "trip", intent: "inform", session: sent.message.session, text: "The budget changed." })).toMatchObject({ isError: true, error: "partner_session_not_available", instruction: SESSION_REFUSED.inform });
  expect(await hub.call({ action: "message", to: "trip", intent: "inform", text: "The budget changed." })).toMatchObject({ status: "recorded" });
  // Another partner neither sees the session nor can write into it.
  const other = await ownerTurn(f, food.id);
  expect(await other.call({ action: "sessions", name: "trip" })).toMatchObject({ partner: "trip", sessions: [] });
  expect(await other.call({ action: "message", to: "trip", intent: "ask", session: sent.message.session, text: "Go on." })).toMatchObject({ isError: true, error: "partner_session_not_found" });
  expect(f.messages().filter(message => message.to.id === trip.id && message.intent !== "inform")).toHaveLength(1);
  for (const turn of f.turns) end(turn);
}, 60_000);

it("continues a session in a new context when it has grown large and cold, and leaves it alone while a turn runs in it, whoever wrote it", async () => {
  const f = await partnersFixture(cleanup), end = f.hold();
  const hub = await ownerTurn(f, f.agent.id);
  const first = await hub.call({ action: "recruit", name: "trip", duty, intent: "ask", message: "Find three hotels in Seoul." });
  const trip = f.partner("trip"), hotels = await f.turnOf(trip.id, 0), session = first.message.session as string;
  const second = await hub.call({ action: "message", to: "trip", intent: "ask", text: "Find restaurants near Myeongdong." });
  const food = await f.turnOf(trip.id, 1);
  reports(f, hotels, SPENT_TOKENS + 1); end(hotels, "Lotte, Shilla, Four Seasons.");
  await use(f, trip.id, session, 1);
  // Large, but used a moment ago: it costs little to go on in it.
  await f.mau.partners.retire();
  expect(await windows(f, trip.id, session)).toBe(0);
  await quiet(f); cold(f, trip.id, session);
  // The owner comes back to it after a day and writes there. The reply is still being written when the cold contexts
  // are looked for: the last turn that ended is a day old, and the session is in use all the same.
  const path = `/agents/${trip.id}/sessions/${session}/messages`;
  expect((await f.api(path, { text: "Only hotels with a pool.", key: "k1" })).status).toBe(202);
  const pool = await f.turnOf(trip.id, 2);
  await f.mau.partners.retire();
  expect(await windows(f, trip.id, session)).toBe(0);
  end(pool, "The Shilla has one.");
  await use(f, trip.id, session, 2); cold(f, trip.id, session);
  // The other session is as large and colder still, and a partner's turn still runs in it.
  f.store(store => store.set("partner_session_use", `${trip.id}:${second.session}`, { owner: alice, agentId: trip.id, sessionId: second.session, turns: 3,
    tokens: SPENT_TOKENS + 1, lastAt: new Date(Date.now() - 3 * SPENT_IDLE_MS).toISOString() } satisfies SessionUse));
  await f.mau.partners.retire();
  expect([await windows(f, trip.id, session), await windows(f, trip.id, second.session)]).toEqual([1, 0]);
  // Once is enough: the earlier context is behind the divider now.
  await f.mau.partners.retire();
  expect(await windows(f, trip.id, session)).toBe(1);
  // It is the same session to its sender and to the owner: still listed, with what was done in it, and both go on in it.
  expect((await hub.call({ action: "sessions", name: "trip" })).sessions).toMatchObject([{ id: second.session, state: "working" }, { id: session, turns: 2, state: "idle" }]);
  expect((await f.api(`/agents/${trip.id}/sessions`)).data.data).toMatchObject([{ id: session, turns: 2, working: false }, { id: second.session, working: true }]);
  const more = await hub.call({ action: "message", to: "trip", intent: "ask", session, text: "Which one is closest to the station?" });
  expect(more).toMatchObject({ status: "sent", session, title: "Find three hotels in Seoul." });
  // The turn runs in a new context at the Host, and is told where the earlier part is: one line, nothing of what was said.
  const closest = await f.turnOf(trip.id, 3);
  expect(closest.body.sessionId).not.toBe(hotels.body.sessionId);
  expect(closest.told).toEqual({ continues: continuedText(session, "Find three hotels in Seoul.") });
  expect(closest.told.continues).toBe(`This is a new context of the session "Find three hotels in Seoul.": what was said before is in session ${session}.`);
  // The partner sees both parts among its own sessions, the one used last first: the new one stands before the
  // earlier one, which it continues and which is closed.
  expect((await closest.call("partners", { action: "sessions" })).sessions).toMatchObject([
    { id: `${session}.w2`, title: "Find three hotels in Seoul.", turns: 0, state: "working", continues: session },
    { id: session, title: "Find three hotels in Seoul.", startedBy: "helper", first: "Find three hotels in Seoul.", turns: 2, tokens: SPENT_TOKENS + 1, state: "closed", continuedIn: `${session}.w2` },
    { id: second.session, state: "working" }]);
  // What was said stays one history, and the next turn of the new context is not told again.
  end(closest, "The Lotte.");
  await use(f, trip.id, `${session}.w2`, 1);
  expect((await f.thread(trip.id, session)).filter(event => event.kind === "message")).toHaveLength(6);
  expect((await f.api(path, { text: "And the cheapest?", key: "k2" })).status).toBe(202);
  const cheapest = await f.turnOf(trip.id, 4);
  expect(cheapest.body.sessionId).toBe(closest.body.sessionId); expect(cheapest.told).toEqual({});
  // The sender may name either part: it is one session.
  expect(await hub.call({ action: "message", to: "trip", intent: "ask", session: `${session}.w2`, text: "Book it." })).toMatchObject({ status: "sent", session });
  for (const turn of f.turns) end(turn);
}, 60_000);

it("the owner writes in a session of a partner: a turn of that session, which the partner that opened it is not told", async () => {
  const f = await partnersFixture(cleanup);
  f.respond(async (turn: Turn) => {
    if (f.name(turn.agentId) !== "trip") {
      if (turn.delivered?.results) return "Reported.";
      await turn.call("partners", { action: "recruit", name: "trip", duty, intent: "ask", message: "Find three hotels in Seoul." });
      return "Asked.";
    }
    return turn.delivered ? "Lotte, Shilla, Four Seasons." : `As you say: ${turn.text}`;
  });
  await f.say(f.agent.id, "Ask trip for hotels");
  const record = await f.until(() => f.messages().find(message => message.status === "returned"), "returned");
  const trip = f.partner("trip"), sessionId = f.record(record.id).sessionId!, first = await f.turnOf(trip.id, 0);
  const path = `/agents/${trip.id}/sessions/${sessionId}/messages`;
  const sent = await f.api(path, { text: "Only hotels with a pool.", key: "k1" });
  expect(sent).toMatchObject({ status: 202, data: { eventId: expect.stringMatching(/^po-[0-9a-f]{32}$/), turnId: expect.any(String) } });
  const reply = await f.turnOf(trip.id, 1);
  // The owner's own words, in the session's context, with the owner's authority.
  expect(reply.text).toBe("Only hotels with a pool."); expect(reply.delivered).toBeUndefined();
  expect(reply.body.sessionId).toBe(first.body.sessionId);
  await f.until(async () => (await f.thread(trip.id, sessionId)).filter(event => event.kind === "message").length === 4 || undefined, "answer in the session");
  expect((await f.thread(trip.id, sessionId)).filter(event => event.kind === "message").map(event => [event.role, event.sender.type, event.kind === "message" && event.text])).toEqual([
    ["user", "agent", expect.stringContaining("Find three hotels in Seoul.")], ["assistant", "agent", "Lotte, Shilla, Four Seasons."],
    ["user", "person", "Only hotels with a pool."], ["assistant", "agent", "As you say: Only hotels with a pool."]]);
  // The same key is the same turn; the partner that opened the session gets no turn for it.
  expect((await f.api(path, { text: "Only hotels with a pool.", key: "k1" })).data).toEqual(sent.data);
  await f.settle(1000);
  expect(f.turns.filter(turn => turn.agentId === trip.id)).toHaveLength(2);
  expect(f.turns.filter(turn => turn.agentId === f.agent.id)).toHaveLength(2);
  expect(await use(f, trip.id, sessionId, 2)).toMatchObject({ turns: 2 });
  expect((await f.api(`/agents/${trip.id}/sessions/ps-unknown/messages`, { text: "Hello", key: "k2" }))).toMatchObject({ status: 404, data: { error: "partner_session_not_found" } });
  expect((await f.api(path, { text: "", key: "k3" })).status).toBe(400);
  expect((await f.api(path, { text: "Hello", key: "k4" }, "bob")).status).toBe(404);
}, 60_000);

it("continues a conversation with the owner in a new session when it is large and cold, but not while a reply is on its way to it", async () => {
  const f = await partnersFixture(cleanup);
  let release: (answer: string) => void = () => {};
  f.respond(async (turn: Turn) => {
    if (f.name(turn.agentId) === "trip") return new Promise<string>(resolve => { release = resolve; });
    if (turn.delivered?.results) return "The trip partner found three hotels.";
    if (turn.text.includes("hotels")) {
      await turn.call("partners", { action: "recruit", name: "trip", duty, intent: "ask", message: "Find three hotels in Seoul." });
      reports(f, turn, SPENT_TOKENS + 1);
      return "Asked trip.";
    }
    return "Here.";
  });
  await f.say(f.agent.id, "Ask trip for hotels in Seoul");
  const asked = await f.turnOf(f.agent.id, 0), conversation = (await f.until(async () => {
    await f.mau.completedTurns.tick();
    return f.store(store => store.entries<SessionUse>("partner_session_use").map(entry => entry.value).find(record => record.agentId === f.agent.id));
  }, "use of the conversation")).sessionId;
  expect(f.store(store => store.get<SessionUse>("partner_session_use", `${f.agent.id}:${conversation}`))).toMatchObject({ turns: 1, tokens: SPENT_TOKENS + 1 });
  // The partner's own list of its sessions begins with this conversation.
  expect(await f.mau.partners.execute(await f.admission(asked), { action: "sessions" }, "direct-1")).toMatchObject({ sessions: [{ id: conversation, title: SESSIONS_NOTE.conversation, turns: 1, tokens: SPENT_TOKENS + 1 }] });
  await quiet(f); cold(f, f.agent.id, conversation);
  // Large and cold, but the answer to its message has not come back: a result arriving in a new session would be read
  // by a model that never sent the message.
  await f.mau.partners.retire();
  expect(await window(f, f.agent.id)).toBe(0);
  release("Lotte, Shilla, Four Seasons.");
  await f.until(() => f.messages()[0]?.status === "returned", "returned");
  expect((await f.turnOf(f.agent.id, 1)).body.sessionId).toBe(asked.body.sessionId);
  await use(f, f.agent.id, conversation, 2); cold(f, f.agent.id, conversation);
  // Nothing is cancelled for it: it happens once the turn that reported to the owner has ended.
  await f.until(async () => { await f.mau.partners.retire(); return await window(f, f.agent.id) === 1; }, "continued in a new session");
  // Once is enough: the earlier session is behind the divider now.
  await f.mau.partners.retire();
  expect(await window(f, f.agent.id)).toBe(1);
  // The next turn runs in a new context and is told where the earlier part is, once: what it reads of it is its own choice.
  await f.say(f.agent.id, "Are you there?");
  const next = await f.turnOf(f.agent.id, 2);
  expect(next.body.sessionId).not.toBe(asked.body.sessionId);
  expect(next.told.continues).toBe(`This is a new context of your conversation with the owner: what was said before is in session ${conversation}.`);
  expect(next.told.continues).toBe(continuedText(conversation));
  expect(await f.mau.partners.execute(await f.admission(next), { action: "sessions" }, "direct-2")).toMatchObject({ sessions: [
    { id: `${conversation}.w2`, title: SESSIONS_NOTE.conversation, state: "idle", continues: conversation },
    { id: conversation, title: SESSIONS_NOTE.conversation, first: "Ask trip for hotels in Seoul", turns: 2, state: "closed", continuedIn: `${conversation}.w2` }] });
  await f.until(async () => (await f.answers(f.agent.id)).includes("Here."), "answer in the new session");
  await f.say(f.agent.id, "And now?");
  expect((await f.turnOf(f.agent.id, 3)).told.continues).toBeUndefined();
}, 60_000);

it("a partner finds and reads what was said in its own sessions: which sessions say a text, each place, and a session turn by turn", async () => {
  const f = await partnersFixture(cleanup), end = f.hold();
  const hub = await ownerTurn(f, f.agent.id);
  const first = await hub.call({ action: "recruit", name: "trip", duty, intent: "ask", title: "Seoul hotels", message: "Find three hotels in Seoul.\nFive nights in May." });
  const trip = f.partner("trip"), session = first.message.session as string, path = `/agents/${trip.id}/sessions/${session}/messages`;
  const long = `Lotte, Shilla, Four Seasons. ${"The Lotte is by the station. ".repeat(100)}The Shilla has a pool.`;
  end(await f.turnOf(trip.id, 0), long);
  await use(f, trip.id, session, 1);
  for (const [index, [text, answer]] of [["Only hotels with a pool.", "Then the Shilla."], ["What does it cost?", "About 400,000 won a night."], ["Book five nights.", "Booked."]].entries()) {
    expect((await f.api(path, { text, key: `k${index}` })).status).toBe(202);
    end(await f.turnOf(trip.id, index + 1), answer);
    await use(f, trip.id, session, index + 2);
  }
  await hub.call({ action: "message", to: "trip", intent: "ask", text: "Find restaurants near Myeongdong." });
  const food = await f.turnOf(trip.id, 4), search = (input: Record<string, unknown>) => food.call("session_search", input);
  const at = expect.any(String), named = { id: session, title: "Seoul hotels", startedBy: "helper" };
  // Which sessions say it, and how often: enough to pick one without reading any of it.
  expect(await search({ query: "pool" })).toEqual({ sessions: [{ ...named, places: 2, lastAt: at }] });
  expect(await search({ query: "no such thing" })).toEqual({ sessions: [] });
  // Each place: the turn, whose words they are, and what is said around it. The turn's number is what reading takes.
  expect(await search({ query: "pool", show: "text" })).toEqual({ places: [
    { session, title: "Seoul hotels", turn: 2, part: "asked", by: "owner", at, text: "Only hotels with a pool." },
    { session, title: "Seoul hotels", turn: 1, part: "answered", by: "you", at, text: expect.stringMatching(/^station\. The Lotte.*The Shilla has a pool\.$/), textOffset: long.length - 205, of: long.length }] });
  expect((await search({ query: "pool", sessionId: session, limit: 1 }))).toMatchObject({ places: [{ turn: 2 }], nextOffset: 1 });
  // Reading a session: the last three turns unless a range is named. A partner's message reads as that partner wrote it.
  expect(await search({ sessionId: session })).toEqual({ session: named, showing: { fromTurn: 2, toTurn: 4, of: 4 }, turns: [
    { turn: 2, at, by: "owner", asked: "Only hotels with a pool.", answered: "Then the Shilla." },
    { turn: 3, at, by: "owner", asked: "What does it cost?", answered: "About 400,000 won a night." },
    { turn: 4, at, by: "owner", asked: "Book five nights.", answered: "Booked." }] });
  // How each turn begins: where a long session went, without its text.
  expect(await search({ sessionId: session, view: "lines" })).toMatchObject({ showing: { fromTurn: 1, toTurn: 4, of: 4 }, turns: [
    { turn: 1, by: "helper", asked: "Find three hotels in Seoul. Five nights in May.", answered: long.slice(0, 100) }, { turn: 2 }, { turn: 3 }, { turn: 4, asked: "Book five nights.", answered: "Booked." }] });
  // A long text is cut, and says how to read on; reading on returns that text alone.
  const one = await search({ sessionId: session, fromTurn: 1, toTurn: 1 });
  expect(one.turns).toEqual([{ turn: 1, at, by: "helper", asked: "Find three hotels in Seoul.\nFive nights in May.",
    answered: `${long.slice(0, 2000)}\n[cut: ${long.length - 2000} more characters; fromTurn=1 toTurn=1 part=answered textOffset=2000 reads on]` }]);
  expect((await search({ sessionId: session, fromTurn: 1, toTurn: 1, part: "answered", textOffset: 2000 })).turns).toEqual([{ turn: 1, at, by: "helper", answered: long.slice(2000) }]);
  // A turn the session does not have is not answered with another one.
  expect(await search({ sessionId: session, fromTurn: 5, toTurn: 5 })).toEqual({ session: named, showing: { of: 4 }, turns: [] });
  expect(await search({ sessionId: session, fromTurn: 5 })).toEqual({ session: named, showing: { of: 4 }, turns: [] });
  expect(await search({ sessionId: session, fromTurn: 3, toTurn: 2, view: "lines" })).toEqual({ session: named, showing: { of: 4 }, turns: [] });
  expect((await search({ sessionId: session, fromTurn: 4, toTurn: 9 })).showing).toEqual({ fromTurn: 4, toTurn: 4, of: 4 });
  // A session that is not the partner's own reads as nothing, and a call needs a text or a session.
  expect(await search({ sessionId: "ps-unknown" })).toMatchObject({ isError: true, error: "session_not_found" });
  expect(await search({})).toMatchObject({ isError: true, error: "session_search_invalid_input" });
  // Another partner's sessions are not its own: the sender finds nothing of what was said there.
  expect(await hub.turn.call("session_search", { query: "pool" })).toEqual({ sessions: [] });
  expect(await hub.turn.call("session_search", { sessionId: session })).toMatchObject({ isError: true, error: "session_not_found" });
  for (const turn of f.turns) end(turn);
}, 60_000);

it("finds a session something just happened in among hundreds, and pages back to where the first one began", async () => {
  const f = await partnersFixture(cleanup), end = f.hold();
  const hub = await ownerTurn(f, f.agent.id);
  const first = await hub.call({ action: "recruit", name: "trip", duty, intent: "ask", title: "The first one", message: "Find three hotels in Seoul." });
  const trip = f.partner("trip"), oldest = first.message.session as string, hotels = await f.turnOf(trip.id, 0);
  // Six hundred more sessions began after it, each used once, the later ones later.
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(), ids = Array.from({ length: 600 }, (_, index) => `ps-${String(index + 1).padStart(32, "0")}`);
  f.store(store => store.transaction(() => { for (const [index, id] of ids.entries()) {
    store.set("partner_sessions", id, { id, owner: alice, agentId: trip.id, title: `Work ${index + 1}`, startedBy: { agentId: f.agent.id, name: "helper" }, createdAt: at(index) });
    store.set("partner_session_use", `${trip.id}:${id}`, { owner: alice, agentId: trip.id, sessionId: id, turns: 1, lastAt: at(index) } satisfies SessionUse);
  } }));
  // The first one gets an answer now.
  end(hotels, "Lotte, Shilla, Four Seasons.");
  await use(f, trip.id, oldest, 1);
  const page = async (query = "") => (await f.api(`/agents/${trip.id}/sessions${query}`)).data as { data: Array<{ id: string }>; earlier: string | null; active?: Array<{ id: string; turns: number }> };
  // The owner's page: the sixty that began last, and beside them the ones something happened in last, the first one among them.
  const head = await page();
  expect(head.data.map(thread => thread.id)).toEqual(ids.slice(-60)); expect(head.earlier).toBe(ids[540]);
  expect(head.active).toHaveLength(60);
  expect(head.active![0]).toMatchObject({ id: oldest, title: "The first one", turns: 1 }); expect(head.active![1]!.id).toBe(ids[599]);
  // Page after page reaches the first one, each session once.
  const seen = [...head.data.map(thread => thread.id)];
  for (let cursor = head.earlier, pages = 0; cursor; pages++) {
    expect(pages).toBeLessThan(20);
    const earlier = await page(`?before=${cursor}&limit=100`);
    expect(earlier.active).toBeUndefined();
    seen.unshift(...earlier.data.map(thread => thread.id)); cursor = earlier.earlier;
  }
  expect(seen).toEqual([oldest, ...ids]);
  expect((await f.api(`/agents/${trip.id}/sessions?limit=500`)).status).toBe(400);
  // The sender's list of the sessions it opened there: the ones that began last, twenty a call, as far back as it asks.
  const theirs = await hub.call({ action: "sessions", name: "trip" });
  expect(theirs.sessions.map((session: { id: string }) => session.id)).toEqual(ids.slice(-20).reverse()); expect(theirs.nextOffset).toBe(20);
  expect((await hub.call({ action: "sessions", name: "trip", offset: 600 })).sessions).toMatchObject([{ id: oldest, title: "The first one", turns: 1 }]);
  // The partner's own list begins with the one it used last, and goes on from there.
  const second = await hub.call({ action: "message", to: "trip", intent: "ask", session: oldest, text: "Which one is closest?" });
  const own = await (await f.turnOf(trip.id, 1)).call("partners", { action: "sessions" });
  expect(own.sessions).toHaveLength(20); expect(own.nextOffset).toBe(20);
  expect(own.sessions.slice(0, 2)).toMatchObject([{ id: oldest, title: "The first one", turns: 1, state: "working" }, { id: ids[599], title: "Work 600", state: "idle" }]);
  const last = await (await f.turnOf(trip.id, 1)).call("partners", { action: "sessions", offset: 600 });
  expect(last.sessions).toMatchObject([{ id: ids[0], title: "Work 1" }]); expect(last.nextOffset).toBeUndefined();
  expect(second.session).toBe(oldest);
  for (const turn of f.turns) end(turn);
}, 60_000);
