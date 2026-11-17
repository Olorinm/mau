import { afterEach, expect, it, vi } from "vitest";
import { noticeText } from "../src/partner-text.js";
import type { PartnerMessage } from "../src/partners.js";
import { partnersFixture, type PartnersFixture, type Turn } from "./fixtures/partners.js";

// What happens to a result that cannot be handed to its sender at once, or that is a failure.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const duty = "Plans the Korea trip and tracks its bookings";
const results = (f: PartnersFixture) => f.turns.filter(turn => turn.text.includes("[Partner results"));
/** Rewrite a message's record as if time had passed. */
const rewrite = (f: PartnersFixture, id: string, change: (message: PartnerMessage) => PartnerMessage) =>
  f.store(store => store.set("partner_messages", id, change(store.get<PartnerMessage>("partner_messages", id)!)));
const due = (f: PartnersFixture, id: string) => rewrite(f, id, message => ({ ...message, delivery: { ...message.delivery!, nextAttemptAt: new Date(0).toISOString() } }));

it("tries eight times to hand a result over, waiting longer each time, then drops it and keeps it readable", async () => {
  const f = await partnersFixture(cleanup);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  f.respond(async (turn: Turn) => {
    if (f.name(turn.agentId) === "trip") return "The answer is 42.";
    if (turn.text.includes("[Partner results")) throw new Error("model_unavailable");
    await turn.call("partners", { action: "recruit", name: "trip", duty, message: "What is the answer?", intent: "ask" });
    return "Asked.";
  });
  await f.say(f.agent.id, "Ask trip");
  const id = (await f.until(() => f.messages()[0], "message")).id;
  const attempt = (n: number) => f.until(() => { const record = f.record(id); return record.delivery?.attempts === n && record.status !== "returning" ? record : undefined; }, `attempt ${n}`);
  /** Seconds from the start of hand-over `n` to the time the next one is due: the delay, plus how long that turn took to fail. */
  const delay = (n: number, record: PartnerMessage) => {
    const batch = f.store(store => store.entries<{ attempt: number; createdAt: string }>("partner_returns").map(entry => entry.value).find(value => value.attempt === n)!);
    return (Date.parse(record.delivery!.nextAttemptAt) - Date.parse(batch.createdAt)) / 1000;
  };
  const first = await attempt(1);
  expect(first).toMatchObject({ status: "settled", delivery: { attempts: 1, reason: "model_unavailable" } });
  const waits = [delay(1, first)];
  // Not before its time.
  await f.settle(1200);
  expect(results(f)).toHaveLength(1);
  for (let n = 2; n <= 7; n++) {
    due(f, id);
    const record = await attempt(n);
    expect(record.status).toBe("settled");
    waits.push(delay(n, record));
  }
  // 5 s, 15 s, 1 min, 5 min, 15 min, 1 h, 3 h after the attempts 1 to 7.
  expect(waits.map((seconds, index) => { const expected = [5, 15, 60, 300, 900, 3600, 10_800][index]!; return seconds >= expected && seconds < expected + 30; })).toEqual(Array(7).fill(true));
  due(f, id);
  expect(await attempt(8)).toMatchObject({ status: "dropped", delivery: { attempts: 8, reason: "delivery_attempts_exhausted" }, result: { status: "completed", answer: "The answer is 42." } });
  expect(results(f)).toHaveLength(8);
  await f.settle(1200);
  expect(results(f)).toHaveLength(8);
  // Dropped, not lost: the sender can still read it, and the owner sees what became of it.
  f.respond(async (turn: Turn) => JSON.stringify(await turn.call("partners", { action: "wait", messageIds: [id] })));
  await f.say(f.agent.id, "What did trip answer?");
  const read = JSON.parse(await f.until(async () => (await f.answers(f.agent.id)).find(answer => answer.includes("The answer is 42.")), "read"));
  expect(read.results).toMatchObject([{ messageId: id, status: "completed", answer: "The answer is 42." }]);
  expect((await f.api("/partners/messages")).data.data).toMatchObject([{ id, status: "dropped", reason: "delivery_attempts_exhausted", result: { answer: "The answer is 42." } }]);
}, 120_000);

it("drops a result that could not be handed over for 48 hours and keeps it readable", async () => {
  const f = await partnersFixture(cleanup);
  let release = () => {}, read: any;
  f.respond(async (turn: Turn) => {
    if (f.name(turn.agentId) === "trip") return "The answer is 42.";
    await turn.call("partners", { action: "recruit", name: "trip", duty, message: "What is the answer?", intent: "ask" });
    await new Promise<void>(resolve => { release = resolve; });
    read = await turn.call("partners", { action: "wait" });
    return "Done.";
  });
  await f.say(f.agent.id, "Ask trip");
  const id = (await f.until(() => f.messages()[0], "message")).id;
  await f.until(() => f.record(id).status === "settled", "settled");
  const settledAt = new Date(Date.now() - 47 * 3_600_000).toISOString();
  rewrite(f, id, message => ({ ...message, result: { ...message.result!, settledAt } }));
  await f.settle(500);
  expect(f.record(id).status).toBe("settled");
  rewrite(f, id, message => ({ ...message, result: { ...message.result!, settledAt: new Date(Date.now() - 48 * 3_600_000 - 1000).toISOString() } }));
  await f.until(() => f.record(id).status === "dropped", "dropped");
  expect(f.record(id)).toMatchObject({ delivery: { attempts: 0, reason: "undelivered_after_48_hours" }, result: { answer: "The answer is 42." } });
  release();
  await f.until(() => read, "wait");
  // A wait without ids covers what still waits; the dropped result is read by its id.
  expect(read.results).toEqual([]);
  await f.settle(1200);
  expect(results(f)).toHaveLength(0);
}, 60_000);

it("wakes a sender three times in a row for failures, then leaves the owner a notice instead", async () => {
  const f = await partnersFixture(cleanup);
  f.respond(async (turn: Turn) => {
    if (f.name(turn.agentId) === "trip") throw new Error("tool_crashed");
    if (!turn.text.includes("[Partner results")) await turn.call("partners", { action: "recruit", name: "trip", duty });
    await turn.call("partners", { action: "message", to: "trip", text: "Try the booking", intent: "relay" });
    return "Trying.";
  });
  await f.say(f.agent.id, "Book it");
  await f.until(() => f.messages().length === 4 && f.messages().every(message => f.record(message.id).status === "returned"), "four failures", 3000);
  // One owner turn and three turns that handed a failure over. The fourth failure woke nobody.
  await f.settle(1500);
  expect(results(f)).toHaveLength(3); expect(f.turns.filter(turn => turn.agentId === f.agent.id)).toHaveLength(4);
  const records = f.messages().map(message => f.record(message.id)).sort((a, b) => a.origin.chain - b.origin.chain);
  expect(records.map(record => [record.result!.status, record.delivery!.via])).toEqual([["failed", "turn"], ["failed", "turn"], ["failed", "turn"], ["failed", "notice"]]);
  expect(results(f)[0]!.text).toContain("Status: failed (tool_crashed)"); expect(results(f)[0]!.text).toContain(f.answer(records[0]!.id, "(no answer)"));
  expect(records[3]!.delivery).toMatchObject({ reason: "failure_wake_limit" });
  const notices = (await f.events(f.agent.id)).filter(event => event.kind === "notice").map(event => event.text);
  expect(notices).toEqual([noticeText([records[3]!])]);
  expect(notices[0]).toContain("trip：failed (tool_crashed)");
  // The owner's next message starts over.
  await f.say(f.agent.id, "Try once more");
  await f.until(() => results(f).length === 4, "woken again", 2000);
}, 120_000);

it("tells the sender when the outcome of a partner's turn is unknown, and that a deleted partner did not answer", async () => {
  const f = await partnersFixture(cleanup);
  f.respond(async (turn: Turn) => {
    if (f.name(turn.agentId) === "trip") throw Object.assign(new Error("connection_lost"), { outcomeUnknown: true });
    if (turn.text.includes("[Partner results")) return "Reported.";
    await turn.call("partners", { action: "recruit", name: "trip", duty, message: "Pay the deposit.", intent: "relay" });
    return "Asked.";
  });
  await f.say(f.agent.id, "Pay the deposit");
  const id = (await f.until(() => f.messages()[0], "message")).id;
  // Router may find a run again after an interrupted submission, so an unknown outcome is not reported at once.
  await f.until(() => f.record(id).unknownSince, "seen as unknown", 3000);
  await f.settle(1000);
  expect(f.record(id).status).toBe("running"); expect(results(f)).toHaveLength(0);
  // It has lasted two minutes.
  rewrite(f, id, message => ({ ...message, unknownSince: new Date(Date.now() - 121_000).toISOString() }));
  const back = await f.until(() => results(f)[0], "unknown outcome", 3000);
  // Nothing is done again in the partner's place; the sender decides with the owner.
  expect(back.text).toContain("Status: unknown (host_outcome_unknown)");
  expect(f.record(id).result).toMatchObject({ status: "unknown", answer: "" });
  expect(f.turns.filter(turn => f.name(turn.agentId) === "trip")).toHaveLength(1);
  await f.until(() => f.record(id).status === "returned", "returned");
  // A partner that is deleted while a message waits for it: the sender gets a failure, not silence.
  let hold = () => {};
  f.respond(async (turn: Turn) => {
    if (turn.text.includes("[Partner results")) return "Reported.";
    const sent = await turn.call("partners", { action: "recruit", name: "second", duty: "Second partner", message: "Wait for me.", intent: "ask" });
    await new Promise<void>(resolve => { hold = resolve; });
    return sent.message.messageId;
  });
  await f.say(f.agent.id, "Ask a second partner");
  const second = await f.until(() => f.messages().find(message => message.to.name === "second"), "second message");
  f.mau.partners.forget("@alice:example.test", second.to.id);
  expect(f.record(second.id)).toMatchObject({ status: "settled", result: { status: "failed", error: "partner_deleted" } });
  hold();
  const failure = await f.until(() => results(f)[1], "failure handed over");
  expect(failure.text).toContain("Status: failed (partner_deleted)");
}, 90_000);

it("settles a message whose turn ended without an entry in the settlement feed", async () => {
  // The feed is the usual way an ending is learned. A release without the feed that ran in between (a rollback and a
  // roll forward) ends turns without recording them there; the message is then settled from its work event.
  const f = await partnersFixture(cleanup);
  let release = () => {};
  f.respond(async (turn: Turn) => {
    if (f.name(turn.agentId) === "trip") { await new Promise<void>(resolve => { release = resolve; }); return "Done meanwhile."; }
    if (turn.text.includes("[Partner results")) return "Reported.";
    await turn.call("partners", { action: "recruit", name: "trip", duty, message: "Do it.", intent: "relay" });
    return "Asked.";
  });
  await f.say(f.agent.id, "Ask trip");
  const id = (await f.until(() => f.messages()[0], "message")).id, trip = f.partner("trip");
  await f.until(() => f.turns.some(turn => turn.agentId === trip.id), "partner turn");
  // The reader's cursor is already past everything this agent's feed will hold.
  f.store(store => store.set("partner_cursors", trip.id, 1_000_000));
  release();
  const back = await f.until(() => results(f)[0], "handed over", 3000);
  expect(back.text).toContain(f.answer(id, "Done meanwhile."));
  expect(f.record(id).result).toMatchObject({ status: "completed", answer: "Done meanwhile." });
}, 60_000);

it("gives up after 48 hours on a message nobody answered and on a hand-over that never ended", async () => {
  const f = await partnersFixture(cleanup);
  let holdReturn = false;
  f.respond(async (turn: Turn) => {
    if (f.name(turn.agentId) === "trip") { if (turn.text.includes("never")) await new Promise(() => {}); return "Answered."; }
    if (turn.text.includes("[Partner results")) { if (holdReturn) await new Promise(() => {}); return "Reported."; }
    if (!f.partner("trip")) await turn.call("partners", { action: "recruit", name: "trip", duty });
    await turn.call("partners", { action: "message", to: "trip", text: turn.text.includes("never") ? "This is never answered." : "Answer this.", intent: "ask" });
    return "Asked.";
  });
  await f.say(f.agent.id, "Ask what is never answered");
  const stuck = (await f.until(() => f.messages()[0], "message")).id, trip = f.partner("trip");
  const work = await f.turnOf(trip.id);
  await f.settle(500);
  expect(f.record(stuck).status).toBe("running");
  // 47 hours is not yet too long; 48 hours and a second is.
  rewrite(f, stuck, message => ({ ...message, createdAt: new Date(Date.now() - 47 * 3_600_000).toISOString() }));
  await f.settle(500);
  expect(f.record(stuck).status).toBe("running");
  rewrite(f, stuck, message => ({ ...message, createdAt: new Date(Date.now() - 48 * 3_600_000 - 1000).toISOString() }));
  const failure = await f.until(() => results(f)[0], "failure handed over");
  expect(failure.text).toContain("Status: failed (no_answer_after_48_hours)");
  // The partner's turn was cancelled, and its admission ended with the message.
  await f.until(() => f.runs.get(work.runId)!.record.status === "cancelled", "partner turn cancelled");
  expect(f.mau.partners.allows({ kind: "delegation", owner: "@alice:example.test", agentId: trip.id, reference: stuck, toolGrants: {} })).toBe(false);
  await f.until(() => f.record(stuck).status === "returned", "returned");
  // A hand-over whose turn does not end: after 48 hours it is cancelled and its result is dropped, still readable.
  holdReturn = true;
  await f.say(f.agent.id, "Ask again");
  const second = await f.until(() => f.messages().find(message => message.text === "Answer this."), "second message");
  const handing = await f.until(() => results(f)[1], "second hand-over");
  expect(f.record(second.id).status).toBe("returning");
  const batch = f.store(store => store.entries<{ id: string; createdAt: string; messageIds: string[] }>("partner_returns").find(entry => entry.value.messageIds.includes(second.id))!.value);
  f.store(store => store.set("partner_returns", batch.id, { ...batch, createdAt: new Date(Date.now() - 48 * 3_600_000 - 1000).toISOString() }));
  await f.until(() => f.record(second.id).status === "dropped", "dropped");
  expect(f.record(second.id)).toMatchObject({ delivery: { reason: "undelivered_after_48_hours" }, result: { status: "completed", answer: "Answered." } });
  await f.until(() => f.runs.get(handing.runId)!.record.status === "cancelled", "hand-over cancelled");
}, 90_000);
