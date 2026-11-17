// What the console's partner views are tested against: conversations made by the real partners tool, with the
// fixture's Host playing the model. One partner (the fixture's "helper", unless another is given) recruits two
// partners and gives each a message; one answers, the other fails, and both results come back to it in one turn.
import { expect } from "vitest";
import type { PartnersFixture, Turn } from "./partners.js";

export const tripDuty = "负责韩国游的行程、预订和出发前的提醒";
export const tripMessage = "订 10 月 3 日到 6 日首尔的酒店，两个人，靠近地铁站。\n\n订好后告诉我酒店名和每晚的价格。";
export const tripAnswer = "订好了：**明洞站前酒店**，3 晚，每晚 780 元，含早餐。\n\n- 入住 10 月 3 日，退房 10 月 6 日\n- 到店付款，可免费取消到 10 月 1 日";
export const visaQuestion = "韩国旅游签证现在要多久能办下来？";

/** The owner asks `hub`; it looks at the roster, recruits "korea-trip" and "visa" with a first message each, and both results return. */
export async function partnerConversations(f: PartnersFixture, hub: string = f.agent.id) {
  const end = f.hold();
  await f.say(hub, "帮我安排十月去首尔的行程，签证也确认一下");
  const turn = await f.turnOf(hub);
  await turn.call("partners", { action: "roster" });
  const recruited = await turn.call("partners", { action: "recruit", name: "korea-trip", duty: tripDuty, message: tripMessage, intent: "relay" });
  const asked = await turn.call("partners", { action: "recruit", name: "visa", duty: "负责签证材料和办理进度", message: visaQuestion, intent: "ask" });
  await turn.call("partners", { action: "message", to: "korea-trip", text: "预算是每晚不超过 800 元。", intent: "inform" });
  // A refusal, as the model gets it: nobody has this name.
  expect(await turn.call("partners", { action: "message", to: "flights", text: "查一下直飞的航班", intent: "ask" })).toMatchObject({ isError: true, error: "partner_not_found" });
  const trip = f.partner("korea-trip"), visa = f.partner("visa");
  const booking = await f.turnOf(trip.id), checking = await f.turnOf(visa.id);
  end(booking, tripAnswer);
  // The partner's run fails; nothing is run again in its place.
  end(checking, Promise.reject(new Error("kernel_stopped")) as unknown as string);
  const ids = [recruited.message.messageId, asked.message.messageId] as string[];
  await f.until(() => ids.every(id => f.record(id).status === "settled"), "both settled");
  end(turn, "已经交给 korea-trip 订酒店，签证的事问了 visa，等它们回复。");
  const back = await f.turnOf(hub, 1);
  end(back, "酒店订好了：明洞站前酒店，3 晚，每晚 780 元。签证那边 visa 没有查成，要不要我再问一次？");
  await f.until(() => ids.every(id => f.record(id).status === "returned"), "both returned");
  return { end, hub, trip, visa, turns: { first: turn, back, booking, checking }, messageIds: ids };
}

/** The owner asks again; helper relays to "korea-trip", whose turn stays open so that its writes can wait for the owner. */
export async function openPartnerTurn(f: PartnersFixture, scene: Awaited<ReturnType<typeof partnerConversations>>, text = "把入住人改成两位，再发确认邮件") {
  const before = f.turns.length;
  await f.say(scene.hub, text);
  const turn = await f.until(() => f.turns.slice(before).find(item => item.agentId === scene.hub), "owner turn");
  const sent = await turn.call("partners", { action: "message", to: "korea-trip", text: "入住人改成两位，改好后给酒店发确认邮件。", intent: "relay" });
  const work: Turn = await f.until(() => f.turns.slice(before).find(item => item.agentId === scene.trip.id), "partner turn");
  return { turn, work, message: f.record(sent.messageId as string) };
}
