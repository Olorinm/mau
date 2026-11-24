import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { ConnectorReadClient } from "@olorinm/agent-connectors/read-client";
import { generateSigningKey } from "@olorinm/agent-connectors/issuer";
import { privateFile } from "../src/files.js";
import { NEXT } from "../src/partner-text.js";
import { newIdempotencyKey } from "../web/src/api/ledger";
import { groupsApi } from "../web/src/api/ledger-groups";
import { alice } from "./fixtures/mau.js";
import { partnersFixture, type PartnersFixture, type Turn } from "./fixtures/partners.js";

// The rules of the partners tool, called as the turn Router admitted: a real owner turn is open at the Host while
// the tool runs, so every check reads Router's own records.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const duty = "Plans the Korea trip and tracks its bookings";
/** An owner turn of a partner that stays open, and the partners tool called as that turn. */
async function ownerTurn(f: PartnersFixture, agentId: string, index = 0, text = "Work with my partners") {
  await f.say(agentId, text);
  const turn = await f.turnOf(agentId, index), admission = await f.admission(turn);
  let calls = 0;
  return { turn, admission, call: (input: Record<string, unknown>) => f.mau.partners.execute(admission, input, `${turn.runId}-direct-${++calls}`) as Promise<any> };
}
const settings = async (f: PartnersFixture, agentId: string) => (await f.service.runtime(agentId)).extension!.sessions!.defaultSettings();

it("recruits only with a valid name, duty and listed settings, and never changes a value it was given", async () => {
  const f = await partnersFixture(cleanup), end = f.hold();
  const { turn, call } = await ownerTurn(f, f.agent.id);
  const refused = async (input: Record<string, unknown>, error: string, more: Record<string, unknown> = {}) =>
    expect(await call({ action: "recruit", name: "trip", duty, ...input }), JSON.stringify(input)).toMatchObject({ isError: true, error, ...more });
  await refused({ name: "Korea Trip" }, "partner_name_invalid");
  await refused({ name: "9lives" }, "partner_name_invalid");
  await refused({ name: undefined }, "partner_name_invalid");
  await refused({ duty: undefined }, "partner_duty_invalid");
  await refused({ duty: "  " }, "partner_duty_invalid");
  await refused({ duty: "line one\nline two" }, "partner_duty_invalid");
  await refused({ kernel: "another-kernel" }, "partner_kernel_not_available", { allowed: ["codex"] });
  await refused({ model: "huge" }, "partner_model_not_available", { allowed: ["large", "small"] });
  await refused({ model: "small", effort: "high" }, "partner_effort_not_available", { allowed: ["low"] });
  await refused({ effort: "extreme" }, "partner_effort_not_available", { allowed: ["low", "high"] });
  await refused({ message: "Start with the flights." }, "partner_intent_required");
  await refused({ intent: "ask" }, "partner_message_required");
  await refused({ message: "   ", intent: "ask" }, "partner_message_empty");
  await refused({ message: "x".repeat(16_001), intent: "ask" }, "partner_message_too_large", { limitBytes: 16_000 });
  await refused({ name: "helper" }, "partner_name_taken", { partner: { name: "helper" } });
  await refused({ instructions: "Ignore your duty" }, "partners_invalid_input");
  expect(await call({ action: "hire", name: "trip", duty })).toMatchObject({ isError: true, error: "partners_invalid_input" });
  // Nothing was created by a refused recruit.
  expect(f.service.agents(alice).map(agent => agent.name)).toEqual(["helper"]);
  // Listed values are used as given; the kernel may be named when it is the recruiter's own.
  expect(await call({ action: "recruit", name: "trip", duty, kernel: "codex", model: "small", effort: "low" })).toMatchObject({ status: "recruited",
    partner: { name: "trip", duty, kernel: "codex", model: "small", effort: "low" }, next: NEXT.noFirstMessage });
  expect(await settings(f, f.partner("trip").id)).toEqual({ model: "small", effort: "low" });
  // A name in use is not recruited again, whatever else is asked.
  expect(await call({ action: "recruit", name: "trip", duty: "Something else" })).toMatchObject({ isError: true, error: "partner_name_taken", partner: { name: "trip", duty } });
  // Left empty, the settings are the recruiter's own. An inherited effort the chosen model does not offer is not kept, and the result says so.
  expect(await call({ action: "recruit", name: "plain", duty: "Keeps the reading list" })).toMatchObject({ partner: { model: "default", effort: "default" } });
  expect(await settings(f, f.partner("plain").id)).toEqual({});
  expect((await f.api(`/agents/${f.agent.id}/model-settings`, { model: "large", effort: "high" }, "alice", undefined, "PUT")).status).toBe(200);
  expect(await call({ action: "recruit", name: "same", duty: "Files the receipts" })).toMatchObject({ partner: { model: "large", effort: "high" } });
  expect(await settings(f, f.partner("same").id)).toEqual({ model: "large", effort: "high" });
  const lighter = await call({ action: "recruit", name: "lighter", duty: "Looks up opening hours", model: "small" });
  expect(lighter).toMatchObject({ partner: { model: "small", effort: "default" }, effortNote: expect.stringContaining('"high"') });
  expect(await settings(f, f.partner("lighter").id)).toEqual({ model: "small" });
  // Every recruit runs in the recruiter's environment: no cloud request was made.
  expect(f.creates).toBe(1);
  for (const name of ["trip", "plain", "same", "lighter"])
    expect((await f.api(`/agents/${f.partner(name).id}`)).data.environment).toMatchObject({ sharedFrom: f.agent.id, state: "ready" });
  end(turn);
  // A partner that itself runs in a shared environment recruits into the environment it shares, not into a chain.
  const second = await ownerTurn(f, f.partner("trip").id);
  expect(await second.call({ action: "recruit", name: "hotels", duty: "Compares hotels" })).toMatchObject({ status: "recruited", partner: { name: "hotels", model: "small", effort: "low" } });
  expect((await f.api(`/agents/${f.partner("hotels").id}`)).data.environment).toMatchObject({ sharedFrom: f.agent.id });
  expect((await f.api("/partners")).data.data.find((partner: { name: string }) => partner.name === "hotels")).toMatchObject({ recruitedBy: { id: f.partner("trip").id, name: "trip" }, sharesEnvironmentOf: f.agent.id });
  end(second.turn);
}, 60_000);

it("refuses at once a message to a partner that cannot be woken, and a note beyond twenty that wait to be read", async () => {
  const f = await partnersFixture(cleanup), end = f.hold();
  // A partner with an environment of its own, which the owner paused: a message does not wake it.
  const own = (await f.api("/agents", { name: "archive", profileId: "cloud", duty: "Keeps old documents" })).data.agent as { id: string };
  await f.until(async () => (await f.api(`/agents/${own.id}/environment`)).data.state === "ready", "second environment");
  expect((await f.api(`/agents/${own.id}/environment/pause`, {})).status).toBe(202);
  await f.until(async () => (await f.api(`/agents/${own.id}/environment`)).data.state === "paused", "paused");
  const { turn, call } = await ownerTurn(f, f.agent.id);
  expect((await call({ action: "roster" })).partners).toMatchObject([{ name: "archive", duty: "Keeps old documents", status: "paused" }]);
  for (const intent of ["ask", "relay", "inform"])
    expect(await call({ action: "message", to: "archive", text: "Find the contract.", intent })).toMatchObject({ isError: true, error: "partner_unavailable", environment: "paused",
      instruction: expect.stringContaining("Nothing was sent") });
  expect(f.messages()).toEqual([]);
  // Notes are not a queue without end.
  await call({ action: "recruit", name: "trip", duty });
  for (let n = 1; n <= 20; n++) expect((await call({ action: "message", to: "trip", text: `Note ${n}`, intent: "inform" })).status).toBe("recorded");
  expect(await call({ action: "message", to: "trip", text: "Note 21", intent: "inform" })).toMatchObject({ isError: true, error: "partner_note_limit_reached" });
  expect(f.messages()).toHaveLength(20);
  // A message that expects a reply is still taken.
  expect((await call({ action: "message", to: "trip", text: "Read your notes.", intent: "ask" })).status).toBe("sent");
  end(turn);
}, 60_000);

it("finishes a recruit that stopped half way when it is repeated", async () => {
  const f = await partnersFixture(cleanup), end = f.hold();
  const { turn, call } = await ownerTurn(f, f.agent.id);
  const share = vi.spyOn(f.mau.environments, "beginShared").mockRejectedValueOnce(new Error("environment_coordinator_unavailable"));
  expect(await call({ action: "recruit", name: "trip", duty })).toMatchObject({ isError: true, error: "partner_recruit_failed", reason: "environment_coordinator_unavailable" });
  // The agent exists without an environment; it is not a partner that can be messaged yet.
  expect(await call({ action: "message", to: "trip", text: "Hello", intent: "ask" })).toMatchObject({ isError: true, error: "partner_unavailable" });
  expect(await call({ action: "recruit", name: "trip", duty })).toMatchObject({ status: "recruited", partner: { name: "trip", duty } });
  expect(share).toHaveBeenCalledTimes(2);
  expect(f.service.agents(alice).map(agent => agent.name)).toEqual(["helper", "trip"]);
  expect(await call({ action: "recruit", name: "trip", duty })).toMatchObject({ isError: true, error: "partner_name_taken" });
  end(turn);
}, 60_000);

it("dismisses a partner by archiving it and restores it when its name is recruited again", async () => {
  const f = await partnersFixture(cleanup), end = f.hold();
  const { turn, call } = await ownerTurn(f, f.agent.id);
  await call({ action: "recruit", name: "trip", duty });
  const trip = f.partner("trip");
  f.mau.facts.mutate(alice, trip.id, { action: "add", content: "Flights are booked for May" });
  expect(await call({ action: "dismiss", name: "nobody" })).toMatchObject({ isError: true, error: "partner_not_found", partners: ["trip"] });
  expect(await call({ action: "dismiss", name: "helper" })).toMatchObject({ isError: true, error: "partner_is_self" });
  expect(await call({ action: "dismiss", name: "trip" })).toEqual({ status: "dismissed", name: "trip" });
  expect(await call({ action: "dismiss", name: "trip" })).toMatchObject({ status: "dismissed" });
  // Hidden from the roster and from what a turn is shown, listed on request, and not messaged.
  expect((await call({ action: "roster" })).partners).toEqual([]);
  expect((await call({ action: "roster", includeDismissed: true })).partners).toMatchObject([{ name: "trip", status: "dismissed", dismissedAt: expect.any(String) }]);
  expect((await f.mau.partners.turnContext(await f.admission(turn), true)).partners).toBe('The owner has no other partners (you are "helper").');
  // A session reads who the partners are once and again when that changes; another session has not read it yet.
  const admitted = await f.admission(turn);
  expect((await f.mau.partners.turnContext(admitted, true, "session-a")).partners).toContain("The owner has no other partners");
  expect(await f.mau.partners.turnContext(admitted, true, "session-a")).toEqual({});
  expect((await f.mau.partners.turnContext(admitted, true, "session-b")).partners).toContain("The owner has no other partners");
  expect(await call({ action: "message", to: "trip", text: "Any news?", intent: "ask" })).toMatchObject({ isError: true, error: "partner_dismissed" });
  // Nothing was deleted: the agent, its memory and its conversation are as they were.
  expect((await f.api(`/agents/${trip.id}`)).data).toMatchObject({ agent: { id: trip.id, name: "trip" }, duty, dismissed: expect.any(String) });
  expect(f.mau.facts.read(alice, trip.id).entries).toEqual(["Flights are booked for May"]);
  // Recruiting the name brings the same partner back; its duty stays the one it has.
  expect(await call({ action: "recruit", name: "trip", duty: "Plans every trip" })).toMatchObject({ status: "restored", partner: { name: "trip", duty },
    dutyKept: expect.any(String), next: `${NEXT.restored("trip")} ${NEXT.noFirstMessage}` });
  expect(f.partner("trip").id).toBe(trip.id);
  expect((await call({ action: "roster" })).partners).toMatchObject([{ name: "trip", duty, status: "idle" }]);
  // A restored partner keeps its own model settings: the recruiter's are not written over them, a value that is given is.
  expect((await f.api(`/agents/${trip.id}/model-settings`, { model: "small", effort: "low" }, "alice", undefined, "PUT")).status).toBe(200);
  expect((await f.api(`/agents/${f.agent.id}/model-settings`, { model: "large", effort: "high" }, "alice", undefined, "PUT")).status).toBe(200);
  await call({ action: "dismiss", name: "trip" });
  expect(await call({ action: "recruit", name: "trip", duty })).toMatchObject({ status: "restored", partner: { model: "small", effort: "low" } });
  expect(await settings(f, trip.id)).toEqual({ model: "small", effort: "low" });
  await call({ action: "dismiss", name: "trip" });
  expect(await call({ action: "recruit", name: "trip", duty, model: "large" })).toMatchObject({ status: "restored", partner: { model: "large", effort: "low" } });
  expect(await settings(f, trip.id)).toEqual({ model: "large", effort: "low" });
  expect(f.mau.facts.read(alice, trip.id).entries).toEqual(["Flights are booked for May"]);
  // The owner dismisses and restores from the console with the same effect; another account cannot.
  expect((await f.api(`/agents/${trip.id}/dismiss`, {})).data).toMatchObject({ dismissed: expect.any(String) });
  expect((await f.api("/partners")).data.data.map((partner: { name: string; status: string }) => [partner.name, partner.status])).toEqual([["helper", "working"], ["trip", "dismissed"]]);
  expect((await f.api(`/agents/${trip.id}/restore`, {}, "bob")).status).toBe(404);
  expect((await f.api(`/agents/${trip.id}/restore`, {})).data).toMatchObject({ dismissed: null });
  expect((await call({ action: "roster" })).partners).toHaveLength(1);
  end(turn);
  // Dismissing takes the owner's own turn: a turn that hands results over cannot do it.
  f.respond(async (next: Turn) => {
    if (f.name(next.agentId) === "trip") return "Nothing new.";
    if (!next.delivered?.results) { await next.call("partners", { action: "message", to: "trip", text: "Any news?", intent: "ask" }); return "Asked."; }
    return JSON.stringify(await next.call("partners", { action: "dismiss", name: "trip" }));
  });
  await f.say(f.agent.id, "Ask trip for news");
  const back = await f.turnOf(f.agent.id, 2);
  await f.until(async () => (await f.answers(f.agent.id)).find(answer => answer.includes("partner_owner_turn_required")), "refusal");
  expect(back.text).toContain("Nothing new.");
  expect((await f.api(`/agents/${trip.id}`)).data.dismissed).toBeNull();
}, 60_000);

it("lets a turn that handles a partner's message read the roster but not recruit, message or dismiss", async () => {
  const f = await partnersFixture(cleanup);
  let inner: any[] = [];
  f.respond(async (turn: Turn) => {
    if (f.name(turn.agentId) !== "trip") {
      if (turn.delivered?.results) return "Relayed.";
      await turn.call("partners", { action: "recruit", name: "trip", duty, intent: "ask", message: "Who else works with us?" });
      return "Asked.";
    }
    inner = await Promise.all([turn.call("partners", { action: "roster" }),
      turn.call("partners", { action: "recruit", name: "more", duty: "Helps the trip partner" }),
      turn.call("partners", { action: "message", to: "helper", text: "Do it for me", intent: "ask" }),
      turn.call("partners", { action: "message", to: "helper", text: "FYI", intent: "inform" }),
      turn.call("partners", { action: "dismiss", name: "helper" }),
      turn.call("partners", { action: "wait" })]);
    return "Only helper.";
  });
  await f.say(f.agent.id, "Ask the trip partner who else works with us");
  await f.until(() => inner.length, "partner turn");
  expect(inner[0]).toMatchObject({ you: { name: "trip", duty }, partners: [{ name: "helper", status: "working" }] });
  for (const result of inner.slice(1, 5)) expect(result).toMatchObject({ isError: true, error: "partner_layer_limit" });
  expect(inner[5]).toEqual({ results: [], pending: [], next: NEXT.nothingWaiting });
  expect(f.service.agents(alice).map(agent => agent.name)).toEqual(["helper", "trip"]);
  expect(f.messages()).toHaveLength(1);
  await f.turnOf(f.agent.id, 1);
}, 60_000);

it("works only from the owner's private conversation: other owner turns read the roster and nothing more", async () => {
  const f = await partnersFixture(cleanup);
  let results: any[] = [];
  f.respond(async (turn: Turn) => {
    results = await Promise.all([turn.call("partners", { action: "roster" }),
      turn.call("partners", { action: "recruit", name: "trip", duty }),
      turn.call("partners", { action: "message", to: "trip", text: "Hello", intent: "inform" }),
      turn.call("partners", { action: "dismiss", name: "trip" })]);
    return "done";
  });
  // Work the owner submits through Router's API is the owner's, but it is not a message in the owner's conversation:
  // a reply would have no conversation to return to. A turn in a group is refused the same way.
  expect((await f.api(`/agents/${f.agent.id}/communication/work-events`, { eventId: "owner-work-1", input: "Recruit a partner" }, "alice", "/_agent-router/v1")).status).toBe(202);
  const turn = await f.turnOf(f.agent.id);
  await f.until(() => results.length, "tool results");
  expect(turn.told.partners).toBeUndefined();
  expect(results[0]).toMatchObject({ you: { name: "helper" }, partners: [] });
  for (const result of results.slice(1)) expect(result).toMatchObject({ isError: true, error: "partner_owner_conversation_required", instruction: expect.stringContaining("private conversation") });
  expect(f.service.agents(alice)).toHaveLength(1);
  // The owner's turn in a group of the owner and the owner's partners is the owner's too, and still not a private
  // conversation: Router has no way back into a group, so nothing that expects a reply starts there.
  const group = await groupsApi("alice", f.base + "/_agent-router/v1/web").create({ title: "Trip planning", agentIds: [f.agent.id] });
  results = [];
  await f.web().send(group.chatId, { idempotencyKey: newIdempotencyKey(), text: "Recruit a partner for the trip", mentions: { agentIds: [f.agent.id] } });
  const inGroup = await f.turnOf(f.agent.id, 1);
  await f.until(() => results.length, "tool results in the group");
  expect(inGroup.body.sessionId).not.toBe(turn.body.sessionId);
  expect(inGroup.told.partners).toBeUndefined();
  expect(results[0]).toMatchObject({ you: { name: "helper" }, partners: [] });
  for (const result of results.slice(1)) expect(result).toMatchObject({ isError: true, error: "partner_owner_conversation_required" });
  expect(f.service.agents(alice)).toHaveLength(1); expect(f.messages()).toEqual([]);
}, 60_000);

it("refuses a further message when four of a sender's messages wait for replies, and does not queue it", async () => {
  const f = await partnersFixture(cleanup), end = f.hold();
  const { turn, call } = await ownerTurn(f, f.agent.id);
  await call({ action: "recruit", name: "trip", duty });
  const send = (text: string, intent = "ask") => call({ action: "message", to: "trip", text, intent });
  const sent = [];
  // What a session was shown names the partner and its duty. A partner that starts working and messages that wait
  // change neither, so the session is not shown it again: the roster action answers how a partner is doing.
  const admitted = await f.admission(turn);
  expect((await f.mau.partners.turnContext(admitted, true, "session")).partners).toBe(`The owner's other partners (you are "helper"):\n- trip: ${JSON.stringify(duty)}`);
  for (const n of [1, 2, 3, 4]) sent.push(await send(`Question ${n}`));
  expect(sent.map(result => result.status)).toEqual(["sent", "sent", "sent", "sent"]);
  expect((await call({ action: "roster" })).partners).toMatchObject([{ name: "trip", status: "working", waiting: { messages: 4 } }]);
  expect(await f.mau.partners.turnContext(admitted, true, "session")).toEqual({});
  expect(await send("Question 5")).toMatchObject({ isError: true, error: "partner_message_limit_reached",
    waiting: sent.map(result => ({ messageId: result.messageId, to: "trip" })), instruction: expect.stringContaining("Nothing was queued") });
  expect(await call({ action: "recruit", name: "more", duty: "Helps", message: "Question 6", intent: "relay" })).toMatchObject({ status: "recruited",
    message: { isError: true, error: "partner_message_limit_reached" }, next: NEXT.firstMessageFailed });
  expect(f.messages()).toHaveLength(4);
  // An inform waits for no reply and is not counted.
  expect(await send("By the way", "inform")).toMatchObject({ status: "recorded", expectsReply: false });
  expect((await call({ action: "roster" })).waitingForReplies).toHaveLength(4);
  expect((await f.api("/partners")).data.data.find((partner: { name: string }) => partner.name === "trip")).toMatchObject({ status: "working", waiting: { messages: 4, approvals: 0 } });
  // The partner handles them one after another in its conversation. When one has ended, there is room again.
  const first = await f.turnOf(f.partner("trip").id);
  end(first, "Answer 1");
  await f.until(() => f.record(sent[0].messageId).status === "settled", "first settled");
  expect(await send("Question 5")).toMatchObject({ status: "sent" });
  end(turn);
}, 60_000);

it("stops a line of messages that results keep extending without the owner", async () => {
  const f = await partnersFixture(cleanup);
  const asked: any[] = [];
  f.respond(async (turn: Turn) => {
    if (f.name(turn.agentId) === "trip") return "Ask me again.";
    if (!turn.delivered?.results) await turn.call("partners", { action: "recruit", name: "trip", duty });
    asked.push(await turn.call("partners", { action: "message", to: "trip", text: `Round ${asked.length + 1}`, intent: "ask" }));
    return `Round ${asked.length} sent.`;
  });
  await f.say(f.agent.id, "Keep asking trip");
  await f.until(() => asked.length === 5, "five rounds", 3000);
  expect(asked.slice(0, 4).map(result => result.status)).toEqual(["sent", "sent", "sent", "sent"]);
  expect(asked[4]).toMatchObject({ isError: true, error: "partner_chain_limit", instruction: expect.stringContaining("wait for the owner's next message") });
  expect(f.messages().map(message => f.record(message.id).origin.chain).sort()).toEqual([0, 1, 2, 3]);
  // The owner's next message starts a new line.
  f.respond(async (turn: Turn) => f.name(turn.agentId) === "trip" ? "Fine." : turn.delivered?.results ? "Done."
    : JSON.stringify(await turn.call("partners", { action: "message", to: "trip", text: "A new request", intent: "relay" })));
  await f.say(f.agent.id, "Ask once more");
  await f.until(async () => (await f.answers(f.agent.id)).some(answer => answer.includes('"status":"sent"')), "new line");
}, 90_000);

it("gives a partner's turn what the sending turn could use within the partner's own connections, never the owner's personal identity", async () => {
  const f = await partnersFixture(cleanup), key = await generateSigningKey("caller");
  privateFile(join(f.directory, "caller.json"), key.privateJwk);
  const end = f.hold();
  const first = await ownerTurn(f, f.agent.id);
  await first.call({ action: "recruit", name: "trip", duty });
  await first.call({ action: "recruit", name: "plain", duty: "Keeps the reading list" });
  end(first.turn);
  const trip = f.partner("trip"), plain = f.partner("plain");
  await f.until(async () => (await f.answers(f.agent.id)).length === 1, "first turn ended");
  // The sender has mail, calendar and the owner's personal Feishu; "trip" has calendar, Feishu and a browser of its own;
  // "plain" has no assignment and so uses those of the partner whose environment it runs in.
  await f.restart({ nativeWork: { partnerTools: true }, connectedApps: { url: "http://127.0.0.1:18100", issuer: "mau", audience: "connectors", callerKeyFile: "caller.json",
    ownerPrivateConnections: ["alice-feishu"] } });
  f.store(store => {
    store.set("connector_assignments", f.agent.id, { owner: alice, connections: ["alice-mail", "alice-calendar", "alice-feishu"] });
    store.set("connector_assignments", trip.id, { owner: alice, connections: ["alice-calendar", "alice-feishu", "trip-browser"] });
  });
  const tools = vi.spyOn(ConnectorReadClient.prototype, "tools").mockResolvedValue([]);
  const call = vi.spyOn(ConnectorReadClient.prototype, "call").mockResolvedValue({ status: "completed", result: {} });
  const personal = { action: "call", name: "alice_feishu__docs_read", arguments: {} };
  const seen = new Map<string, any[]>(), keep = (key: string, value: any[]) => { seen.set(key, value); };
  f.respond(async (turn: Turn) => {
    const name = f.name(turn.agentId);
    if (name === "helper") {
      // The turn that brings the results back is not the owner's own turn either.
      if (turn.delivered?.results) { keep("helper results", [await turn.call("connected_apps", { action: "tools" }), await turn.call("connected_apps", personal)]); return "Reported."; }
      keep("helper owner", [await turn.call("connected_apps", personal)]);
      await Promise.all([turn.call("partners", { action: "message", to: "trip", text: "Check the calendar", intent: "relay" }),
        turn.call("partners", { action: "message", to: "plain", text: "Check the mail", intent: "relay" })]);
      return "Asked both.";
    }
    const owners = !turn.delivered?.message;
    keep(`${name} ${owners ? "owner" : "message"}`, [await turn.call("connected_apps", { action: "tools" }), await turn.call("connected_apps", personal),
      await turn.call("connected_apps", { action: "call", name: "trip_browser__open", arguments: {} })]);
    return "Checked.";
  });
  await f.say(f.agent.id, "Ask trip and plain");
  await f.until(() => f.messages().length === 2 && f.messages().every(message => f.record(message.id).status === "returned"), "both returned", 2000);
  const records = Object.fromEntries(f.messages().map(message => [message.to.name, f.record(message.id)]));
  expect(records.trip).toMatchObject({ sender: { feishu: true, connections: ["alice-mail", "alice-calendar", "alice-feishu"], write: true },
    grants: { feishu: true, connections: ["alice-calendar", "alice-feishu"], write: true } });
  expect(records.plain!.grants.connections).toEqual(["alice-mail", "alice-calendar", "alice-feishu"]);
  for (const record of Object.values(records)) { expect(record!.sender).not.toHaveProperty("ownerPrivate"); expect(record!.grants).not.toHaveProperty("ownerPrivate"); }
  // The connection that acts as the owner's personal identity works in the turn the owner started and nowhere else:
  // not in a turn that handles a partner's message, and not in the turn that brings the results back.
  const refusal = { status: "failed", error: "connected_app_owner_private_only", connection: "alice-feishu",
    message: "这个连接使用你的个人身份（例如飞书个人权限），只能在你与 Agent 的私聊中、由你发起的那一轮里使用，群聊、其他人的对话和伙伴之间的消息中不可用。",
    instruction: expect.stringContaining("the owner has to ask in that private conversation") };
  expect(seen.get("helper owner")![0]).toMatchObject({ status: "completed" });
  for (const turn of ["trip message", "plain message", "helper results"]) {
    expect(seen.get(turn)![0], turn).toMatchObject({ status: "completed", unavailableHere: [{ connection: "alice-feishu", reason: "connected_app_owner_private_only" }] });
    expect(seen.get(turn)![1], turn).toEqual(refusal);
  }
  expect(call.mock.calls.filter(([, name]) => name === "alice_feishu__docs_read").map(([principal]) => principal.agentId)).toEqual([f.agent.id]);
  // The connector service is asked as the partner itself, for the granted connections without the personal one.
  expect(tools).toHaveBeenCalledWith({ agentId: trip.id, owner: alice, connections: ["alice-calendar"] });
  expect(tools).toHaveBeenCalledWith({ agentId: plain.id, owner: alice, connections: ["alice-mail", "alice-calendar"] });
  expect(tools).toHaveBeenCalledWith({ agentId: f.agent.id, owner: alice, connections: ["alice-mail", "alice-calendar"] });
  // A connection of its own that the sending turn did not have is not in the partner's token for this turn, so the
  // connector service refuses its tools.
  expect(call).toHaveBeenCalledWith({ agentId: trip.id, owner: alice, connections: ["alice-calendar"] }, "trip_browser__open", {});
  // The turn that hands the results over acts within what both sending turns could use.
  const batch = f.store(store => store.entries<{ authorization: unknown; origin: unknown }>("partner_returns"))[0]!.value;
  expect(batch.authorization).toEqual({ feishu: true, connections: ["alice-mail", "alice-calendar", "alice-feishu"], write: true });
  // The partner's own conversation with the owner is as before: a turn the owner starts there uses the personal connection.
  await f.say(trip.id, "Read my document");
  await f.until(() => seen.get("trip owner"), "trip's own owner turn");
  expect(seen.get("trip owner")![0]).not.toHaveProperty("unavailableHere");
  expect(seen.get("trip owner")![1]).toMatchObject({ status: "completed" });
  expect(call).toHaveBeenCalledWith({ agentId: trip.id, owner: alice, connections: ["alice-calendar", "alice-feishu", "trip-browser"] }, "alice_feishu__docs_read", {});
}, 90_000);
