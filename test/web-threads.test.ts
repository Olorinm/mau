import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, expect as see, type Page } from "@playwright/test";
import type { PartnerSession } from "../src/partner-sessions.js";
import { partnersFixture, type PartnersFixture } from "./fixtures/partners.js";
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

  // Escape puts the thread away. A thread that was closed can still be read, and not written in.
  await page.keyboard.press("Escape");
  await see(panel).toHaveCount(0);
  f.store((store) => store.set("partner_sessions", sessionId, { ...store.get<PartnerSession>("partner_sessions", sessionId)!, status: "ended", endedAt: new Date().toISOString() }));
  await page.reload();
  await see(entry.locator(".mau-thread-entry-state")).toHaveText("已结束");
  await entry.click();
  await see(panel.locator(".mau-side-head small")).toHaveText("korea-trip · helper 发起 · 共 3 轮 · 已结束");
  await see(panel.locator("textarea")).toBeDisabled();
  await see(panel).toContainText("好，已经备注靠窗。");
  expect(tripAnswer).toContain("明洞站前酒店");
  expect(errors).toEqual([]);
}, 60_000);
