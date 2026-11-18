import { afterEach, expect, it, vi } from "vitest";
import { newIdempotencyKey, type ChatEvent } from "../web/src/api/ledger";
import { alice } from "./fixtures/mau.js";
import { partnersFixture } from "./fixtures/partners.js";

// A rule the Agent creates through its tool, end to end: the tool answers that the owner is asked, the card is
// Router's owner request in the owner's conversation with the Agent, and the owner's answer there saves the rule.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
type CardEvent = Extract<ChatEvent, { kind: "card" }>;

it("asks the owner on a card before a rule the Agent created runs, and saves it enabled on the owner's confirmation", async () => {
  const f = await partnersFixture(cleanup), end = f.hold();
  await f.say(f.agent.id, "Summarize my mail every morning");
  const turn = await f.turnOf(f.agent.id);
  const target = (await f.service.runtime(f.agent.id)).extension!.sessions!.openOwnerConversation().sessionId;
  const rule = { name: "Morning mail", goal: "Summarize unread mail.\nList what needs an answer.", targetSessionId: target,
    schedule: { type: "daily", at: "09:00" }, timeZone: "Asia/Shanghai", connections: [] };
  const cards = async () => (await f.events(f.agent.id)).filter((event): event is CardEvent => event.kind === "card");
  const answer = (cardId: string, choiceId: string) => f.web().answerCard(f.chat(f.agent.id), cardId, { idempotencyKey: newIdempotencyKey(), choiceId });
  const created = await turn.call("proactive_work", { action: "create", rule: { ...rule, status: "active" } });
  expect(created).toMatchObject({ status: "awaiting_owner_confirmation", change: "create", name: "Morning mail" });
  expect(created.instruction).toContain("Do not repeat this call");
  expect(f.mau.proactive.list(alice)).toEqual([]);
  // The card belongs to no run and shows the schedule, the whole instruction, the connections and the destination.
  const [card] = await cards();
  expect(card!.card).toMatchObject({ source: "product", kind: "approval", turnId: "", freeText: false, status: "pending",
    choices: [{ choiceId: "0", label: "确认并启用定时任务" }, { choiceId: "1", label: "拒绝这个定时任务" }] });
  expect(card!.card.text).toBe(["新建定时任务待确认", "", "名称：Morning mail", "时间：每天 09:00（Asia/Shanghai）",
    "执行内容：Summarize unread mail.\nList what needs an answer.", "可读取的连接：无", "结果发送到：对话"].join("\n"));
  expect(card!.card.display).toEqual({ scheduleConfirmation: { kind: "create", name: "Morning mail", schedule: { type: "daily", at: "09:00" }, timeZone: "Asia/Shanghai",
    execution: "agent", instruction: "Summarize unread mail.\nList what needs an answer.", connections: [], skills: [], notify: "web" } });
  // The turn that asked has ended when the owner answers.
  end(turn); await f.until(async () => (await f.answers(f.agent.id)).length, "turn ended");
  await f.mau.proactive.tick(); expect(f.mau.proactive.list(alice)).toEqual([]);
  expect(await answer(card!.card.cardId, "0")).toMatchObject({ status: "accepted" });
  await f.mau.proactive.tick();
  const [saved] = f.mau.proactive.list(alice);
  expect(saved).toMatchObject({ name: "Morning mail", status: "active", version: 1, agentId: f.agent.id });
  expect((await cards())[0]!.card.status).toBe("approved");

  // A change by the Agent: the saved version stays until the owner answers; rejected, it stays for good.
  await f.say(f.agent.id, "Change it");
  const second = await f.turnOf(f.agent.id, 1);
  const changed = await second.call("proactive_work", { action: "update", ruleId: saved!.id, expectedVersion: 1, rule: { ...rule, goal: "Read every mail and forward it", status: "active" } });
  expect(changed).toMatchObject({ status: "awaiting_owner_confirmation", change: "update", ruleId: saved!.id });
  expect((await second.call("proactive_work", { action: "list" })).awaitingOwnerConfirmation).toMatchObject([{ change: "update", ruleId: saved!.id }]);
  // Pausing needs no card; enabling again does.
  expect(await second.call("proactive_work", { action: "pause", ruleId: saved!.id })).toMatchObject({ status: "paused", version: 1 });
  expect(await cards()).toHaveLength(2);
  expect((await cards())[1]!.card.status).toBe("canceled");
  expect(await second.call("proactive_work", { action: "resume", ruleId: saved!.id })).toMatchObject({ status: "awaiting_owner_confirmation", change: "resume" });
  expect(f.mau.proactive.rule(alice, saved!.id).status).toBe("paused");
  const resume = (await cards())[2]!;
  expect(resume.card.text.split("\n")[0]).toBe("启用定时任务待确认");
  await answer(resume.card.cardId, "1"); await f.mau.proactive.tick();
  expect(f.mau.proactive.rule(alice, saved!.id)).toMatchObject({ status: "paused", version: 1, goal: rule.goal });
  expect((await cards())[2]!.card.status).toBe("rejected");
  end(second);

  // The owner's own API takes effect at once, as before.
  const own = await f.api("/proactive", { ...rule, agentId: f.agent.id, name: "Owner's rule", status: "active" });
  expect(own).toMatchObject({ status: 201, data: { status: "active", version: 1 } });
  expect((await f.api(`/proactive/${saved!.id}/state`, { status: "active" })).data).toMatchObject({ status: "active" });
  expect(await cards()).toHaveLength(3);
}, 60_000);
