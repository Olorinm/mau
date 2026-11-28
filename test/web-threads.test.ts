import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, expect as see, type Page } from "@playwright/test";
import { SPENT_IDLE_MS, SPENT_TOKENS, type SessionUse } from "../src/partner-sessions.js";
import { continuedText } from "../src/partner-text.js";
import { partnersFixture, type PartnersFixture, type Turn } from "./fixtures/partners.js";
import { partnerConversations, tripAnswer, tripMessage } from "./fixtures/partner-console.js";

// Browser acceptance of a partner's sessions as threads of its page, in the built console: where a piece of work
// stands, what opens beside the conversation, and writing in it.
const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));
const built = existsSync(webRoot + "index.html");
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });

async function browser(f: PartnersFixture) {
  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const context = await instance.newContext({ locale: "zh-CN", reducedMotion: "reduce", viewport: { width: 1280, height: 900 }, extraHTTPHeaders: f.edgeHeaders() });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { page, errors };
}
const chip = (page: Page, agentId: string) => page.locator(`.mau-roster-row[data-chat-key="agent:${agentId}"]`);
const openChat = async (page: Page, f: PartnersFixture, agentId: string) => {
  await page.goto(f.base + "?agent=" + encodeURIComponent(agentId));
  await see(chip(page, agentId)).toHaveAttribute("aria-current", "true");
};

it.skipIf(!built)("a piece of work a partner was sent is a thread of its page: its first round where it began, the rest beside the conversation, and a box to write in it", async () => {
  const f = await partnersFixture(cleanup, { webRoot });
  const scene = await partnerConversations(f), title = tripMessage.split("\n")[0]!;
  const sessionId = f.record(scene.messageIds[0]!).sessionId!;
  const { page, errors } = await browser(f);
  await openChat(page, f, scene.trip.id);
  const main = page.locator(".mau-dropzone .room-chat-stream"), panel = page.locator(".mau-thread-view"), entry = main.locator(".mau-thread-entry");
  const hint = main.locator(".mau-thread-hint button");

  // One round: it stands on the page as a reply to what the other partner sent, which the collapsed line names with
  // the title of the work. Nothing marks it as a thread, and nothing is listed apart from the partner.
  await see(main.locator(".og-disclosure--room-run > .og-disclosure-row > .og-disclosure-toggle").first()).toContainText(`收到 helper 转达的消息「${title}」`);
  await see(main).toContainText("明洞站前酒店");
  await see(entry).toHaveCount(0); await see(hint).toHaveCount(0);
  await see(page.locator(".mau-roster-row")).toHaveCount(3);
  await see(page.locator(".mau-roster").getByText("其他渠道")).toHaveCount(0);
  // Reading the page read it.
  await see(chip(page, scene.trip.id).locator(".mau-roster-unread, [data-unread]")).toHaveCount(0);

  // The sender goes on in the same session: the work is a thread now. Its second round is not laid out on the page.
  let before = f.turns.length;
  await f.say(scene.hub, "问问加床的价格");
  const asking = await f.until(() => f.turns.slice(before).find((item) => item.agentId === scene.hub), "owner turn");
  expect(await asking.call("partners", { action: "message", to: "korea-trip", intent: "ask", session: sessionId, text: "加一张床每晚多少钱？" })).toMatchObject({ status: "sent", session: sessionId });
  const extra = await f.until(() => f.turns.slice(before).find((item) => item.agentId === scene.trip.id), "second round");
  await see(entry).toHaveCount(1);
  await see(entry.locator(".mau-thread-entry-title strong")).toHaveText(title);
  await see(entry.locator(".mau-thread-entry-last")).toContainText("正在做第 2 轮");
  scene.end(extra, "加床每晚 150 元，需要提前一天说。"); scene.end(asking, "已经问了 korea-trip。");
  scene.end(await f.turnOf(scene.hub, 3), "加床每晚 150 元。");
  await see(entry.locator(".mau-thread-entry-title")).toContainText("2 轮");
  await see(entry.locator(".mau-thread-entry-last")).toContainText("加床每晚 150 元，需要提前一天说。");
  await see(main.locator(".room-chat-bubble", { hasText: "加床每晚 150 元" })).toHaveCount(0);
  // With more than one round the title is the thread's, and the collapsed line says only who wrote in.
  await see(main.locator(".og-disclosure--room-run > .og-disclosure-row > .og-disclosure-toggle").first()).not.toContainText(title);
  // Something new in it: a dot on its line, and above the box which thread it is.
  await see(entry.locator(".mau-thread-dot")).toHaveCount(1);
  await see(hint).toHaveText(`「${title}」有新回复`);
  await see(panel).toHaveCount(0);

  // The line opens the thread beside the conversation: the round it began with, a rule that counts the replies, and
  // each later round as what the other partner asked and what this one answered.
  await hint.click();
  await see(panel).toBeVisible();
  await see(panel.locator(".mau-side-head strong")).toHaveText(title);
  await see(panel.locator(".mau-side-head small")).toHaveText("korea-trip · helper 发起 · 共 2 轮");
  await see(panel.locator(".mau-thread-rule")).toHaveText("1 轮回复");
  const said = panel.locator("article.from-agent").filter({ has: page.locator(".room-chat-author", { hasText: "helper" }) });
  await see(said).toHaveCount(2);
  await see(said.nth(0)).toContainText("订 10 月 3 日到 6 日首尔的酒店"); await see(said.nth(1)).toContainText("加一张床每晚多少钱？");
  await see(panel).toContainText("明洞站前酒店"); await see(panel).toContainText("加床每晚 150 元，需要提前一天说。");
  await see(entry).toHaveAttribute("aria-expanded", "true");
  await see(entry.locator(".mau-thread-dot")).toHaveCount(0); await see(hint).toHaveCount(0);

  // The owner writes in the thread: a turn of that session, with the owner's own words. The partner that opened the
  // thread gets no turn, and the conversation with this partner gets no message.
  before = f.turns.length;
  const box = panel.locator("textarea");
  await see(box).toHaveAttribute("placeholder", "在这个话题里回复…");
  await box.fill("要靠窗的房间。"); await box.press("Enter");
  const window = await f.until(() => f.turns.slice(before).find((item) => item.agentId === scene.trip.id), "the owner's round");
  expect(window.text).toBe("要靠窗的房间。");
  expect(window.body.sessionId).toBe(extra.body.sessionId);
  await see(panel.locator("article.from-user")).toHaveText("要靠窗的房间。");
  scene.end(window, "好，已经备注靠窗。");
  await see(panel).toContainText("好，已经备注靠窗。");
  await see(panel.locator(".mau-side-head small")).toHaveText("korea-trip · helper 发起 · 共 3 轮");
  await see(panel.locator(".mau-thread-rule")).toHaveText("2 轮回复");
  await see(entry.locator(".mau-thread-entry-title")).toContainText("3 轮");
  await see(main.locator("article.from-user")).toHaveCount(0);
  await f.settle(600);
  expect(f.turns.slice(before).filter((item) => item.agentId === scene.hub)).toHaveLength(0);
  // It is open, so what arrives in it is read.
  await see(entry.locator(".mau-thread-dot")).toHaveCount(0);

  // The answer to a reply is lost on its way back: the server took the reply, and the browser never hears. The words
  // return to the box, and sending them again is the same message: the partner does one turn, not two.
  before = f.turns.length;
  const ofTrip = (item: Turn) => item.agentId === scene.trip.id, replies = `**/agents/${scene.trip.id}/sessions/${sessionId}/messages`;
  let lost = 0;
  await page.route(replies, async (route) => { if (lost++) return route.continue(); await route.fetch(); await route.abort(); });
  await box.fill("再加一份早餐。"); await box.press("Enter");
  const breakfast = await f.until(() => f.turns.slice(before).find(ofTrip), "the turn of the reply whose answer was lost");
  await see(box).toHaveValue("再加一份早餐。");
  await box.press("Enter");
  await see(box).toHaveValue("");
  await page.unroute(replies);
  scene.end(breakfast, "已加早餐。");
  await see(panel).toContainText("已加早餐。");
  await see(panel.locator(".mau-side-head small")).toHaveText("korea-trip · helper 发起 · 共 4 轮");
  await f.settle(600);
  expect(lost).toBe(2); expect(f.turns.slice(before).filter(ofTrip)).toHaveLength(1);

  // The session has grown large and nobody used it for a day: it goes on in a new context. On the page it is the same
  // thread, with a divider where the context changed, and the box writes in it as before.
  const useKey = `${scene.trip.id}:${sessionId}`;
  await f.until(async () => { await f.mau.completedTurns.tick(); return f.store((store) => store.get<SessionUse>("partner_session_use", useKey)?.turns === 4) || undefined; }, "four turns counted");
  f.store((store) => store.set("partner_session_use", useKey, { ...store.get<SessionUse>("partner_session_use", useKey)!, tokens: SPENT_TOKENS + 1, lastAt: new Date(Date.now() - 2 * SPENT_IDLE_MS).toISOString() }));
  await f.mau.partners.retire();
  await see(panel.locator('.mau-chat-divider[data-kind="window"]')).toHaveText("新对话");
  before = f.turns.length;
  await box.fill("退房能晚一点吗？"); await box.press("Enter");
  const late = await f.until(() => f.turns.slice(before).find(ofTrip), "the first turn of the new context");
  expect(late.text).toBe("退房能晚一点吗？");
  // A new context at the Host, told in one line where the earlier part is.
  expect(late.body.sessionId).not.toBe(extra.body.sessionId);
  expect(late.told).toEqual({ continues: continuedText(sessionId, title) });
  scene.end(late, "可以延到下午两点。");
  await see(panel).toContainText("可以延到下午两点。");
  await see(panel.locator(".mau-side-head small")).toHaveText("korea-trip · helper 发起 · 共 5 轮");
  await see(entry.locator(".mau-thread-entry-title")).toContainText("5 轮");
  await see(panel).toContainText("明洞站前酒店");

  // Escape puts the thread away.
  await page.keyboard.press("Escape");
  await see(panel).toHaveCount(0);
  expect(tripAnswer).toContain("明洞站前酒店");
  expect(errors).toEqual([]);
}, 60_000);

it.skipIf(!built)("a long thread is read from its first round, and the page loads what is earlier when the reader comes to its top", async () => {
  const f = await partnersFixture(cleanup, { webRoot });
  f.respond(async (turn: Turn) => {
    if (f.name(turn.agentId) === "trip") return turn.delivered ? "乐天、新罗、四季。" : `回复：${turn.text}`;
    if (turn.delivered?.results) return "已转达。";
    await turn.call("partners", { action: "recruit", name: "trip", duty: "负责首尔的行程", intent: "ask", title: "首尔酒店", message: "找三家首尔的酒店。" });
    return "已问 trip。";
  });
  await f.say(f.agent.id, "找酒店");
  const record = await f.until(() => f.messages().find((message) => message.status === "returned"), "returned");
  const trip = f.partner("trip"), sessionId = f.record(record.id).sessionId!;
  // The owner writes fifteen more rounds in the thread: sixteen in all, more events than one page of a chat holds.
  for (let round = 2; round <= 16; round++)
    expect((await f.api(`/agents/${trip.id}/sessions/${sessionId}/messages`, { text: `第 ${round} 轮的问题`, key: `round-${round}` })).status).toBe(202);
  // And then talks to the partner itself for a while: the thread began before the part of the conversation a page opens with.
  for (let message = 1; message <= 30; message++) await f.say(trip.id, `消息 ${message}`);
  await f.until(() => f.turns.filter((turn) => turn.agentId === trip.id).length === 46 || undefined, "every turn of trip", 40_000);
  await f.until(async () => (await f.answers(trip.id)).includes("回复：消息 30") || undefined, "the last answer");

  const { page, errors } = await browser(f);
  await openChat(page, f, trip.id);
  const stream = page.locator(".mau-dropzone .room-message-stream"), entry = stream.locator(".mau-thread-entry"), panel = page.locator(".mau-thread-view");
  await see(stream).toContainText("回复：消息 30");
  // The page opens at its end, with the last part of the conversation. Nothing asks to be pressed for more.
  const bubbles = stream.locator("article.from-agent .room-chat-bubble");
  await see(stream.getByText("回复：消息 1", { exact: true })).toHaveCount(0);
  await see(bubbles.last()).toBeInViewport();
  await see(entry).toHaveCount(0);
  await see(page.getByRole("button", { name: "加载更早的消息" })).toHaveCount(0);
  // Coming to the top loads what is earlier, page after page, and leaves the reader where they were reading.
  const firstRead = (await bubbles.first().innerText()).trim();
  await stream.evaluate((element) => { element.scrollTop = 0; });
  await see(bubbles.first()).not.toHaveText(firstRead);
  await see(stream.getByText(firstRead, { exact: true })).toBeInViewport();
  for (let pass = 0; pass < 12 && await entry.count() === 0; pass++) { await stream.evaluate((element) => { element.scrollTop = 0; }); await page.waitForTimeout(300); }
  // The thread stands where it began, before the conversation that followed, with all of its rounds counted.
  await see(entry).toHaveCount(1);
  await see(entry.locator(".mau-thread-entry-title strong")).toHaveText("首尔酒店");
  await see(entry.locator(".mau-thread-entry-title")).toContainText("16 轮");
  await see(stream.getByText("回复：消息 1", { exact: true })).toHaveCount(1);
  await see(stream).toContainText("乐天、新罗、四季。");
  // Opened, it reads from its first round to its last.
  await entry.click();
  await see(panel.locator(".mau-side-head small")).toHaveText("trip · helper 发起 · 共 16 轮");
  await see(panel.locator(".mau-thread-rule")).toHaveText("15 轮回复");
  await see(panel).toContainText("找三家首尔的酒店。"); await see(panel).toContainText("回复：第 2 轮的问题"); await see(panel).toContainText("回复：第 16 轮的问题");
  expect(errors).toEqual([]);
}, 120_000);
