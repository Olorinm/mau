import { afterEach, expect, it, vi } from "vitest";
import { contextTokens, runContextTokens } from "../src/context-size.js";
import { PartnerSessions, SPENT_IDLE_MS, SPENT_TOKENS, titleOf, type SessionUse } from "../src/partner-sessions.js";
import { DurableStore } from "../src/store.js";
import { SESSION_REFUSED, SESSIONS_NOTE } from "../src/partner-text.js";
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
/** The kernel of a run reports how full its session's context is, as Codex does. */
const reports = (f: PartnersFixture, turn: Turn, tokens: number) => f.runs.get(turn.runId)!.events.push({ type: "native.notification", runId: turn.runId,
  notification: { method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { inputTokens: tokens * 3 }, last: { inputTokens: tokens } } } } });
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

it("reads the size of a session's context from what each kernel reports", async () => {
  const event = (method: string, params: unknown) => ({ type: "native.notification", runId: "run", notification: { method, params } });
  // The last request of a Codex thread, not the thread's running total.
  expect(contextTokens(event("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 900_000 }, last: { inputTokens: 120_000, cachedInputTokens: 100_000, outputTokens: 800 } } }))).toBe(120_000);
  // A Claude request counts what it read from and wrote to the cache apart from its input.
  expect(contextTokens(event("claude.message", { type: "assistant", message: { usage: { input_tokens: 12, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 4_000, output_tokens: 900 } } }))).toBe(84_012);
  expect(contextTokens(event("claude.message", { type: "result", usage: { input_tokens: 500_000 } }))).toBeUndefined();
  expect(contextTokens(event("session/update", { update: { sessionUpdate: "usage_update", used: 53_000, size: 200_000 } }))).toBe(53_000);
  expect(contextTokens(event("item/completed", { item: { type: "commandExecution" } }))).toBeUndefined();
  expect(contextTokens({ type: "usage", runId: "run", scope: "session", inputTokens: 900_000 })).toBeUndefined();
  // The size after a run is what its last event that states one says, however many pages the events take.
  const pages = [[event("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 10_000 } } }), event("item/completed", {})],
    [event("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 30_000 } } }), event("turn/completed", {})]];
  const host = { events: async (_runId: string, after: number) => ({ events: (pages[after] ?? []).map(item => ({ event: item })), cursor: after + 1, hasMore: after + 1 < pages.length }) };
  expect(await runContextTokens(host, "run")).toBe(30_000);
  expect(await runContextTokens({ events: async () => ({ events: [], cursor: 0, hasMore: false }) }, "run")).toBeUndefined();
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
    expect(sessions.of(alice, "trip")).toMatchObject([{ id: "ps-a", startedBy: { name: "desk" }, status: "open" }]);
    expect(sessions.of(alice, "desk")).toEqual([]); expect(sessions.use("desk", "ps-b")).toBeUndefined();
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
    { id: first.message.session, title: "Seoul hotels", startedBy: "helper", turns: 0, lastAt: expect.any(String), state: "working" },
    { id: second.session, title: "Find restaurants near Myeongdong.", startedBy: "helper", turns: 0, lastAt: expect.any(String), state: "working" }] });
  const own = await food.call("partners", { action: "sessions" });
  expect(own).toMatchObject({ note: SESSIONS_NOTE.own, sessions: [{ id: first.message.session, title: "Seoul hotels", startedBy: "helper" }, { id: second.session }] });
  // The first piece of work ends, and a message that names its session goes on there: the same context at the Host.
  reports(f, hotels, 21_000); end(hotels, "Lotte, Shilla, Four Seasons.");
  expect(await use(f, trip.id, first.message.session, 1)).toMatchObject({ turns: 1, tokens: 21_000 });
  const more = await hub.call({ action: "message", to: "trip", intent: "ask", session: first.message.session, text: "Which one is closest to the station?" });
  expect(more).toMatchObject({ status: "sent", session: first.message.session, title: "Seoul hotels" });
  const closest = await f.turnOf(trip.id, 2);
  expect(closest.body.sessionId).toBe(hotels.body.sessionId);
  expect((await hub.call({ action: "sessions", name: "trip" })).sessions[0]).toMatchObject({ turns: 1, tokens: 21_000, state: "working" });
  // What was said in a session stands there, in order, and nothing of it in the partner's conversation with the owner.
  end(closest, "The Lotte.");
  await f.until(() => f.record(more.messageId).status === "settled" || f.record(more.messageId).status === "returning", "second answer");
  expect((await f.thread(trip.id, first.message.session)).filter(event => event.kind === "message").map(event => [event.role, event.kind === "message" && event.text])).toEqual([
    ["user", expect.stringContaining("Find three hotels")], ["assistant", "Lotte, Shilla, Four Seasons."], ["user", expect.stringContaining("Which one is closest")], ["assistant", "The Lotte."]]);
  expect((await f.events(trip.id)).filter(event => event.kind === "message")).toEqual([]);
  // The owner's console lists the partner's sessions as threads of that partner.
  await use(f, trip.id, first.message.session, 2);
  expect((await f.api(`/agents/${trip.id}/sessions`)).data.data).toMatchObject([
    { id: first.message.session, chatId: `obs:${trip.id}:${first.message.session}`, title: "Seoul hotels", startedBy: { id: f.agent.id, name: "helper" }, turns: 2, tokens: 21_000, status: "open", working: false },
    { id: second.session, title: "Find restaurants near Myeongdong.", turns: 0, status: "open", working: true }]);
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

it("closes a task session that has grown large and cold, and leaves one alone while a turn runs in it", async () => {
  const f = await partnersFixture(cleanup), end = f.hold();
  const hub = await ownerTurn(f, f.agent.id);
  const first = await hub.call({ action: "recruit", name: "trip", duty, intent: "ask", message: "Find three hotels in Seoul." });
  const trip = f.partner("trip"), hotels = await f.turnOf(trip.id, 0);
  const second = await hub.call({ action: "message", to: "trip", intent: "ask", text: "Find restaurants near Myeongdong." });
  const food = await f.turnOf(trip.id, 1);
  reports(f, hotels, SPENT_TOKENS + 1); end(hotels, "Lotte, Shilla, Four Seasons.");
  await use(f, trip.id, first.message.session, 1);
  // Large, but used a moment ago: it costs little to go on in it.
  await f.mau.partners.retire();
  expect((await hub.call({ action: "sessions", name: "trip" })).sessions).toHaveLength(2);
  await quiet(f); cold(f, trip.id, first.message.session);
  // The other session is as large and as cold, and a turn still runs in it.
  f.store(store => store.set("partner_session_use", `${trip.id}:${second.session}`, { owner: alice, agentId: trip.id, sessionId: second.session, turns: 3,
    tokens: SPENT_TOKENS + 1, lastAt: new Date(Date.now() - 2 * SPENT_IDLE_MS).toISOString() } satisfies SessionUse));
  await f.mau.partners.retire();
  expect((await hub.call({ action: "sessions", name: "trip" })).sessions).toMatchObject([{ id: second.session, state: "working" }]);
  expect((await f.api(`/agents/${trip.id}/sessions`)).data.data).toMatchObject([{ id: first.message.session, status: "ended" }, { id: second.session, status: "open" }]);
  // The sender is told why, and opens a new one; the owner cannot write into it any more either. What was said stays readable.
  expect(await hub.call({ action: "message", to: "trip", intent: "ask", session: first.message.session, text: "Which one is closest?" }))
    .toMatchObject({ isError: true, error: "partner_session_ended", instruction: SESSION_REFUSED.ended });
  expect((await f.api(`/agents/${trip.id}/sessions/${first.message.session}/messages`, { text: "Which one is closest?", key: "k1" })))
    .toMatchObject({ status: 409, data: { error: "partner_session_ended" } });
  expect((await f.thread(trip.id, first.message.session)).filter(event => event.kind === "message")).toHaveLength(2);
  end(food, "Three places."); end(hub.turn);
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
  // The next turn runs in a new session and reads how the earlier one ended, once.
  await f.say(f.agent.id, "Are you there?");
  const next = await f.turnOf(f.agent.id, 2);
  expect(next.body.sessionId).not.toBe(asked.body.sessionId);
  expect(next.told.earlier).toContain("This conversation continues in a new session");
  expect(next.told.earlier).toContain('- The owner: "Ask trip for hotels in Seoul"');
  expect(next.told.earlier).toContain('- You: "The trip partner found three hotels."');
  await f.until(async () => (await f.answers(f.agent.id)).includes("Here."), "answer in the new session");
  await f.say(f.agent.id, "And now?");
  expect((await f.turnOf(f.agent.id, 3)).told.earlier).toBeUndefined();
}, 60_000);
