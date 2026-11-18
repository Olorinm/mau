import { afterEach, expect, it, vi } from "vitest";
import { newIdempotencyKey, type ChatEvent } from "../web/src/api/ledger";
import { alice } from "./fixtures/mau.js";
import { partnersFixture } from "./fixtures/partners.js";

// Where the owner is asked for a partner's write: a card in the conversation the message was sent from. The card is
// Router's owner request; the connector side of the same approval is covered in connector-approvals.test.ts.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
type CardEvent = Extract<ChatEvent, { kind: "card" }>;

it("puts a partner's approval card in the conversation its message came from, where the owner answers it", async () => {
  const f = await partnersFixture(cleanup), end = f.hold();
  await f.say(f.agent.id, "Have trip send the booking form");
  const turn = await f.turnOf(f.agent.id), admission = await f.admission(turn);
  const sent = await f.mau.partners.execute(admission, { action: "recruit", name: "trip", duty: "Plans the trip", message: "Send the booking form.", intent: "relay" }, "call-1") as any;
  const trip = f.partner("trip"), id = sent.message.messageId as string;
  const work = await f.turnOf(trip.id);
  // The turn that handles the message may ask; other admissions get nothing.
  const partnerTurn = { kind: "delegation" as const, owner: alice, agentId: trip.id, reference: id, toolGrants: { connectedApps: { connections: [] } } };
  const authority = f.mau.partners.authority(partnerTurn)!;
  expect(authority).toMatchObject({ write: true, tool: "partners" }); expect(authority).not.toHaveProperty("ownerPrivate");
  expect(f.mau.partners.allows(partnerTurn)).toBe(true);
  // What the turn writes to its memory is recorded as coming from the sender's message.
  expect(f.mau.partners.memorySource(partnerTurn)).toEqual({ kind: "message", partners: [{ id: f.agent.id, name: "helper" }] });
  expect(f.mau.partners.memorySource(admission)).toBeUndefined();
  expect(f.mau.partners.authority({ ...partnerTurn, agentId: f.agent.id })).toBeUndefined();
  expect(f.mau.partners.authority({ ...partnerTurn, reference: "pm-unknown" })).toBeUndefined();
  expect(f.mau.partners.allows({ ...partnerTurn, reference: "pm-unknown" })).toBe(false);
  expect(f.mau.partners.allows({ ...partnerTurn, reference: "memory-review-1" })).toBeUndefined();
  expect(f.mau.partners.authority(admission)).toBeUndefined();
  const desk = authority.approvals!, soon = (ms = 120_000) => new Date(Date.now() + ms).toISOString();
  const cards = async (agentId: string) => (await f.events(agentId)).filter((event): event is CardEvent => event.kind === "card");
  const open = (suffix: string, deadlineAt = soon()) => desk.open({ id: `partner-approval-${suffix.repeat(40)}`, summary: "Submit the booking form on booking.example",
    connection: "trip-browser", arguments: { site: "https://booking.example", ref: "submit" }, deadlineAt });
  await open("a");
  // The card is in the sender's conversation with the owner, says which partner asks and for what, and is not a card of any run.
  const [card] = await cards(f.agent.id);
  expect(card!.card).toMatchObject({ source: "product", kind: "approval", turnId: "", freeText: false,
    choices: [{ choiceId: "0", label: "批准这次操作" }, { choiceId: "1", label: "拒绝这次操作" }] });
  // The title names the partner once; the text says what it is doing and for whom.
  expect(card!.card.text).toBe(["伙伴「trip」请求批准", "", "处理「helper」转来的消息时需要执行：Submit the booking form on booking.example",
    "连接：trip-browser", '参数：{"site":"https://booking.example","ref":"submit"}'].join("\n"));
  // The same as members, for a console to show in its own words: who asks, for whose message, and what.
  expect(card!.card.display).toEqual({ partnerApproval: { partner: { id: trip.id, name: "trip" }, from: { id: f.agent.id, name: "helper" }, messageId: expect.stringMatching(/^pm-[0-9a-f]{32}$/),
    summary: "Submit the booking form on booking.example", connection: "trip-browser", arguments: '{"site":"https://booking.example","ref":"submit"}' } });
  expect(await cards(trip.id)).toEqual([]);
  expect(await desk.status("partner-approval-" + "a".repeat(40))).toBe("pending");
  // Approved by the owner on the card.
  const answer = (cardId: string, choiceId: string) => f.web().answerCard(f.chat(f.agent.id), cardId, { idempotencyKey: newIdempotencyKey(), choiceId });
  expect(await answer(card!.card.cardId, "0")).toMatchObject({ status: "accepted" });
  expect(await desk.status("partner-approval-" + "a".repeat(40))).toBe("approved");
  // Refused.
  await open("b");
  await answer((await cards(f.agent.id))[1]!.card.cardId, "1");
  expect(await desk.status("partner-approval-" + "b".repeat(40))).toBe("denied");
  // Not answered in time: expired, which the connector approval treats as a refusal.
  await open("c", soon(300));
  await new Promise(r => setTimeout(r, 350));
  expect(await desk.status("partner-approval-" + "c".repeat(40))).toBe("expired");
  // Withdrawn because the partner's call or turn ended: the card closes and a late answer is refused.
  await open("d");
  await desk.withdraw("partner-approval-" + "d".repeat(40));
  expect(await desk.status("partner-approval-" + "d".repeat(40))).toBe("denied");
  const late = await answer((await cards(f.agent.id))[3]!.card.cardId, "0").then(result => result.status, (error: { code?: string }) => error.code);
  expect(["stale", "card_closed", "card_not_pending"]).toContain(late);
  expect(await desk.status("partner-approval-" + "d".repeat(40))).toBe("denied");
  // Long arguments are never cut off silently: every value is shown shortened and the card says so.
  const long = { to: "someone@mail.example", subject: "Booking", body: "x".repeat(6000), attachments: Array.from({ length: 9 }, (_, n) => `file-${n}.pdf`) };
  await desk.open({ id: "partner-approval-" + "9".repeat(40), summary: "Send the mail", connection: "trip-mail", arguments: long, deadlineAt: soon() });
  const shown = (await cards(f.agent.id))[4]!.card.text;
  expect(shown).toContain("参数（较长，以下每项只显示开头）：");
  expect(shown).toContain('"to":"someone@mail.example"'); expect(shown).toContain(`"body":"${"x".repeat(80)}…(共 6000 字符)"`);
  expect(shown).toContain('"file-4.pdf","…(共 9 项)"');
  // Arguments that cannot be shown even shortened: the card is not opened, so the operation is refused.
  await expect(desk.open({ id: "partner-approval-" + "8".repeat(40), summary: "Send the mail", connection: "trip-mail",
    arguments: Object.fromEntries(Array.from({ length: 400 }, (_, n) => [`field-${n}`, "value"])), deadlineAt: soon() })).rejects.toThrow("approval_arguments_too_long_to_show");
  // Nowhere to ask: a card that could not be shown is an error at once, never a pending card.
  await expect(open("e", new Date(Date.now() - 1000).toISOString())).rejects.toThrow("owner_request_expired");
  expect(await desk.status("partner-approval-" + "e".repeat(40))).toBe("expired");
  expect(await cards(f.agent.id)).toHaveLength(5);
  // When the partner's turn ends, its admission ends with it.
  end(work, "The form is sent."); end(turn);
  const back = await f.turnOf(f.agent.id, 1);
  expect(f.mau.partners.allows(partnerTurn)).toBe(false);
  // The turn that hands the result over answers the owner itself, so it asks with cards of its own and needs no desk.
  const batch = f.store(store => store.entries<{ id: string }>("partner_returns"))[0]!.value;
  const handing = { ...partnerTurn, agentId: f.agent.id, reference: batch.id };
  expect(f.mau.partners.authority(handing)).toEqual({ write: true, tool: "partners" });
  expect(f.mau.partners.allows(handing)).toBe(true);
  end(back, "The form is sent.");
  await f.until(() => f.record(id).status === "returned", "returned");
  expect(f.mau.partners.allows(handing)).toBe(false);
}, 60_000);
