import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, expect as see, type Page } from "@playwright/test";
import { newIdempotencyKey } from "../web/src/api/ledger";
import { alice } from "./fixtures/mau.js";
import { partnersFixture, type PartnersFixture } from "./fixtures/partners.js";
import { openPartnerTurn, partnerConversations, tripAnswer, tripMessage, visaQuestion } from "./fixtures/partner-console.js";

// Browser acceptance of partners working together, in the built console: what they send each other in the
// conversations, the partners tool in a run's activity, a partner's request for approval, dismissing, and the kernel
// a partner runs on.
const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));
const built = existsSync(webRoot + "index.html");
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });

async function browser(f: PartnersFixture, locale = "zh-CN") {
  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const context = await instance.newContext({ locale, reducedMotion: "reduce", viewport: { width: 1200, height: 900 }, extraHTTPHeaders: f.edgeHeaders() });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { page, errors };
}
const chip = (page: Page, agentId: string) => page.locator(`.mau-chip[data-chat-key="agent:${agentId}"]`);
const openChat = async (page: Page, f: PartnersFixture, agentId: string) => {
  await page.goto(f.base + "?agent=" + encodeURIComponent(agentId));
  await see(chip(page, agentId)).toHaveAttribute("aria-selected", "true");
};
const profile = (page: Page) => page.getByRole("complementary", { name: "伙伴资料" });
const profileTab = (page: Page, name: string) => profile(page).getByRole("group", { name: "伙伴资料分类" }).getByRole("button", { name, exact: true }).click();
const roster = (page: Page) => page.getByRole("complementary", { name: "全部对话" });
const notices = (page: Page) => page.getByRole("region", { name: "通知" });
/** Router's work sessions of a partner, for recording an input or a request as an earlier release did: without `display`. */
const workSessions = async (f: PartnersFixture, agentId: string) => (await f.service.runtime(agentId)).extension!.sessions!;
const grants = { feishu: false, connectedApps: { connections: [] } };

it.skipIf(!built)("shows what partners send each other as their own words, and the partners tool as readable activity", async () => {
  const f = await partnersFixture(cleanup, { webRoot });
  const scene = await partnerConversations(f);
  const { page, errors } = await browser(f);
  await openChat(page, f, f.agent.id);
  const stream = page.locator(".room-chat-stream");
  // In the sender's conversation each result is the partner's own block: its figure and name, and what it answered.
  const results = stream.locator(`article[data-room-message-id*=":"]`).filter({ has: page.locator(".room-chat-author-link") });
  await see(results).toHaveCount(2);
  const [booked, failed] = [results.nth(0), results.nth(1)];
  await see(booked.locator(".room-chat-author")).toContainText("korea-trip");
  await see(booked.locator(".room-chat-bubble strong")).toHaveText("明洞站前酒店");
  await see(booked.locator(".room-chat-bubble li")).toHaveCount(2);
  await see(booked.locator(".agent-pixel-avatar")).toBeVisible();
  await see(booked.locator(".room-chat-status")).toHaveCount(0);
  // A result that is not completed says so, in words.
  await see(failed.locator(".room-chat-author")).toContainText("visa");
  await see(failed.locator(".room-chat-status")).toHaveAttribute("data-status", "failed");
  // A reason the console has no sentence for stays behind the status, not in the conversation.
  await see(failed.locator(".room-chat-status")).toHaveText("没有完成");
  await see(failed.locator(".room-chat-status span")).toHaveAttribute("title", "kernel_stopped");
  await see(failed.locator(".room-chat-bubble")).toHaveCount(0);
  // They are not the owner's bubbles and not system lines, and the lines Mau writes for the model are not shown.
  await see(stream.locator(".room-chat-message.from-user")).toHaveCount(1);
  await see(stream.locator(".room-chat-message.from-user")).toContainText("帮我安排十月去首尔的行程");
  await see(stream.locator(".room-chat-system")).toHaveCount(0);
  for (const fixed of ["Partner results", "delivered by the system", "Sent to:", "----- answer", "Result 1 of 2", "Your message (", "Status:"])
    await see(stream).not.toContainText(fixed);
  // The reply helper gave the owner after the results follows them.
  await see(stream).toContainText("签证那边 visa 没有查成");

  // The partners tool in the run's process: one readable line per action, the partner's name leading to it.
  const run = page.locator(".mau-run").first();
  const summary = run.locator(".og-disclosure--room-run > .og-disclosure-row > .og-disclosure-toggle");
  await see(summary).toHaveText("招募了 korea-trip，招募了 visa，告知 korea-trip 1 个错误");
  await summary.click();
  await run.locator(".thread-activity-toggle").click();
  const rows = run.locator(".thread-activity-row");
  await see(rows.locator(".thread-activity-row-title")).toHaveText(["查看了伙伴名单", "招募了 korea-trip", "招募了 visa", "告知 korea-trip", "没能询问 flights"]);
  await see(rows.nth(1).locator(".thread-activity-row-detail").first()).toContainText("订 10 月 3 日到 6 日首尔的酒店");
  await see(rows.nth(4).getByRole("alert")).toHaveText("找不到这个伙伴。");
  await see(rows.nth(4)).not.toContainText("partner_not_found");
  // A name nobody has is text; a partner's name is a link.
  await see(rows.nth(4).locator("[data-partner]")).toHaveCount(0);
  // The call's arguments and the tool's answer open from the chevron beside the title.
  await rows.nth(1).getByRole("button", { name: "参数与结果" }).click();
  await see(rows.nth(1).locator(".thread-activity-row-full-detail")).toContainText('"action": "recruit"');
  await see(rows.nth(1).locator(".thread-activity-row-full-detail")).toContainText("recruited");
  await rows.nth(1).getByRole("button", { name: "参数与结果" }).click();
  await see(rows.nth(1).locator(".thread-activity-row-full-detail")).toHaveCount(0);
  await rows.nth(1).locator('[data-partner="korea-trip"]').click();

  // In the receiving partner's conversation the message stands under the sender's figure and name, with only what
  // the sender wrote.
  await see(chip(page, scene.trip.id)).toHaveAttribute("aria-selected", "true");
  const received = stream.locator("article.from-agent").first();
  await see(received.locator(".room-chat-author")).toContainText("helper");
  await see(received.locator(".room-chat-bubble")).toHaveText(tripMessage.replace("\n\n", "\n"), { useInnerText: true });
  await see(received.locator(".room-chat-bubble p")).toHaveCount(2);
  await see(stream.locator(".room-chat-message.from-user")).toHaveCount(0);
  await see(stream.locator(".room-chat-system")).toHaveCount(0);
  for (const fixed of ["Partner message", "How this turn works", "Everything below this line", "Intent:", "authorization"])
    await see(stream).not.toContainText(fixed);
  await see(stream).toContainText("明洞站前酒店");
  // The sender's name and figure lead back to the conversation with it.
  await received.getByRole("button", { name: "helper", exact: true }).click();
  await see(chip(page, f.agent.id)).toHaveAttribute("aria-selected", "true");
  await page.locator(`article[data-room-message-id$=":1"]`).getByRole("button", { name: "打开与 visa 的对话" }).click();
  await see(chip(page, scene.visa.id)).toHaveAttribute("aria-selected", "true");
  await see(stream.locator("article.from-agent").first().locator(".room-chat-bubble")).toHaveText(visaQuestion);

  // A second round: asking, waiting for the reply inside the turn, and dismissing.
  const before = f.turns.length;
  await f.say(f.agent.id, "再问一下 korea-trip 酒店能不能加床，visa 不用了");
  const turn = await f.until(() => f.turns.slice(before).find((item) => item.agentId === f.agent.id), "second owner turn");
  await turn.call("partners", { action: "message", to: "korea-trip", text: "酒店能加床吗？", intent: "ask" });
  expect((await turn.call("partners", { action: "wait", timeoutSeconds: 1 })).results).toEqual([]);
  scene.end(await f.until(() => f.turns.slice(before).find((item) => item.agentId === scene.trip.id), "asked turn"), "可以，加床每晚 150 元。");
  await f.until(async () => (await turn.call("partners", { action: "wait", timeoutSeconds: 5 })).results.length === 1, "reply read");
  await turn.call("partners", { action: "dismiss", name: "visa" });
  scene.end(turn, "korea-trip 说可以加床，每晚 150 元。visa 已经解散。");
  await chip(page, f.agent.id).click();
  await see(chip(page, f.agent.id)).toHaveAttribute("aria-selected", "true");
  const second = page.locator(".mau-run").last();
  await see(second).toContainText("visa 已经解散");
  await second.locator(".og-disclosure--room-run > .og-disclosure-row > .og-disclosure-toggle").click();
  await second.locator(".thread-activity-toggle").click();
  const titles = second.locator(".thread-activity-row-title");
  await see(titles.first()).toHaveText("询问 korea-trip");
  await see(titles.filter({ hasText: "还没有等到回复" }).first()).toBeVisible();
  await see(titles.filter({ hasText: "收到 korea-trip 的回复" })).toHaveCount(1);
  await see(titles.last()).toHaveText("解散了 visa");
  // The result was read inside the turn, so it is not handed over again: no further block of the partner.
  await f.settle(600);
  await see(stream.locator(`article[data-room-message-id*=":"]`).filter({ has: page.locator(".room-chat-author-link") })).toHaveCount(2);
  expect(tripAnswer).toContain("明洞站前酒店");
  expect(errors).toEqual([]);
}, 90_000);

it.skipIf(!built)("an input recorded without what to show is its whole text; a long answer says where the rest is, and the list previews only what somebody in the conversation wrote", async () => {
  const f = await partnersFixture(cleanup, { webRoot });
  const end = f.hold();
  await f.say(f.agent.id, "让 notes 把读书笔记抄一遍");
  const turn = await f.turnOf(f.agent.id);
  const recruited = await turn.call("partners", { action: "recruit", name: "notes", duty: "整理读书笔记", message: "把读书笔记全部抄一遍。", intent: "relay" });
  const notes = f.partner("notes");
  // An answer longer than a hand-over shows.
  end(await f.turnOf(notes.id), "字".repeat(20_000));
  await f.until(() => f.record(recruited.message.messageId as string).status === "settled", "settled");
  end(turn, "已经交给 notes。");
  const back = await f.turnOf(f.agent.id, 1);
  const { page, errors } = await browser(f);
  await openChat(page, f, f.agent.id);
  const stream = page.locator(".room-chat-stream");
  const result = stream.locator(`article[data-room-message-id$=":0"]`);
  await see(result.locator(".room-chat-author")).toContainText("notes");
  await see(result.locator(".room-chat-bubble")).toHaveText(/^字{1000,19999}$/);
  await see(result.locator(".room-chat-status")).toHaveAttribute("data-status", "note");
  await see(result.locator(".room-chat-status")).toHaveText("回答较长，完整内容在 notes 的对话里。");

  // The results are the newest event of the conversation with helper, and another partner sent them: they are not
  // its preview. The conversation with notes ends with what notes itself answered.
  await page.getByRole("button", { name: "全部对话", exact: true }).click();
  const row = (agentId: string) => roster(page).locator(`.mau-roster-row[data-chat-key="agent:${agentId}"]`);
  await see(row(notes.id)).toHaveAttribute("title", /^字+$/);
  await see(row(f.agent.id)).not.toHaveAttribute("title", /./);
  end(back, "笔记抄好了。");
  await see(row(f.agent.id)).toHaveAttribute("title", "笔记抄好了。");
  await page.keyboard.press("Escape");

  // Inputs as an earlier release recorded them: only the text written for the model. All of it is shown, as it is,
  // under the partner that sent it; one that several partners' results came in has no partner to stand under.
  const sessions = await workSessions(f, f.agent.id), { sessionId } = sessions.openOwnerConversation();
  const earlier = (id: string, text: string, sender?: { kind: "agent"; id: string; name: string }) => sessions.submit({ eventId: id, sessionId, input: text, ...(sender ? { sender } : {}),
    admission: { kind: "delegation", owner: "@alice:example.test", agentId: f.agent.id, reference: id, toolGrants: grants } });
  const one = ["[Partner results: 1 result, delivered by the system]", 'From: partner "notes"', "Status: completed", "----- answer 9f8e7d -----", "**抄好了**，共 3 本。", "----- end of answer 9f8e7d -----"].join("\n");
  await earlier("earlier-results-1", one, { kind: "agent", id: notes.id, name: "notes" });
  end(await f.turnOf(f.agent.id, 2), "三本都抄好了。");
  const whole = stream.locator("article").filter({ hasText: "delivered by the system" });
  await see(whole).toHaveCount(1);
  await see(whole.locator(".room-chat-author")).toContainText("notes");
  await see(whole.locator(".room-chat-bubble")).toHaveText(one, { useInnerText: true });
  await see(whole.locator(".room-chat-bubble strong")).toHaveCount(0);
  await see(whole.locator(".room-chat-status")).toHaveCount(0);
  const several = "[Partner results: 2 results]\nResult 1 of 2\nResult 2 of 2";
  await earlier("earlier-results-2", several);
  end(await f.turnOf(f.agent.id, 3), "都收到了。");
  const unnamed = stream.locator("article").filter({ hasText: "Result 1 of 2" });
  await see(unnamed.locator(".room-chat-author")).toContainText("伙伴的回复");
  await see(unnamed.locator(".room-chat-bubble")).toHaveText(several, { useInnerText: true });
  await see(stream).toContainText("都收到了。");
  expect(errors).toEqual([]);
}, 90_000);

it.skipIf(!built)("a rule the Agent created waits as a card in its conversation, showing what will run, until the owner confirms it", async () => {
  const f = await partnersFixture(cleanup, { webRoot }), end = f.hold();
  await f.say(f.agent.id, "每天早上汇总邮件");
  const turn = await f.turnOf(f.agent.id);
  const target = (await f.service.runtime(f.agent.id)).extension!.sessions!.openOwnerConversation().sessionId;
  await turn.call("proactive_work", { action: "create", rule: { name: "晨间邮件", goal: "汇总未读邮件。\n列出需要回复的。", targetSessionId: target,
    schedule: { type: "daily", at: "09:00" }, timeZone: "Asia/Shanghai", connections: [] } });
  end(turn, "已提交，等你确认。");
  const { page, errors } = await browser(f);
  await openChat(page, f, f.agent.id);
  const card = page.locator(".mau-ledger-card[data-card-source='product']");
  await see(card).toHaveAttribute("data-card-status", "pending");
  await see(card.locator("strong")).toHaveText("新建定时任务待确认");
  await see(card.locator("p").first()).toHaveText(["名称：晨间邮件", "时间：每天 09:00（Asia/Shanghai）", "执行内容：汇总未读邮件。\n列出需要回复的。", "可读取的连接：无", "结果发送到：对话"].join("\n"));
  await see(card.getByRole("button")).toHaveText(["确认并启用定时任务", "拒绝这个定时任务"]);
  await page.screenshot({ path: "/tmp/sec2-card.png" });
  expect(f.mau.proactive.list(alice)).toEqual([]);
  await card.getByRole("button", { name: "确认并启用定时任务" }).click();
  await see(card).toHaveAttribute("data-card-status", "approved");
  await see(card.getByRole("button")).toHaveCount(0);
  await f.mau.proactive.tick();
  expect(f.mau.proactive.list(alice)).toMatchObject([{ name: "晨间邮件", status: "active" }]);
  expect(errors).toEqual([]);
}, 60_000);

it.skipIf(!built)("a partner's request for approval is a card in the sender's conversation that the owner answers once", async () => {
  const f = await partnersFixture(cleanup, { webRoot });
  const scene = await partnerConversations(f);
  const open = await openPartnerTurn(f, scene);
  const { page, errors } = await browser(f);
  // The page can be kept from hearing that a card closed, as a tab that is behind would be.
  let behind = false;
  await page.routeWebSocket(/\/_agent-router\/v1\/web\/socket/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => { if (!(behind && typeof message === "string" && message.includes('"card.update"'))) socket.send(message); });
  });
  await openChat(page, f, f.agent.id);
  const request = (id: string, summary: string, deadlineAt?: string, input: unknown = { site: "https://booking.example", guests: 2 }) =>
    f.approval(open.message, { id: id.repeat(40), summary, connection: "trip-browser", arguments: input, ...(deadlineAt ? { deadlineAt } : {}) });
  const cards = page.locator(".mau-ledger-card[data-card-source='product']");
  const status = (index: number) => cards.nth(index).locator(".mau-card-status .agent-status-line");

  // Waiting: the card names the partner and the operation, under that partner's figure, in the conversation the
  // message was sent from; the partner's own conversation has none.
  const first = await request("a", "在 booking.example 提交改期表单");
  await see(cards).toHaveCount(1);
  await see(cards.first()).toHaveAttribute("data-card-status", "pending");
  await see(cards.first().locator("strong")).toHaveText("伙伴「korea-trip」请求批准");
  // The partner is named once, in the title; the rest says whose message it handles, the operation and its arguments.
  await see(cards.first().locator("p").first()).toHaveText(["处理「helper」转来的消息时需要执行：在 booking.example 提交改期表单", "连接：trip-browser",
    '参数：{"site":"https://booking.example","guests":2}'].join("\n"), { useInnerText: true });
  const asking = page.locator("article").filter({ has: cards.first() });
  await see(asking.locator(".room-chat-author")).toContainText("korea-trip");
  await see(asking.getByRole("button", { name: "打开与 korea-trip 的对话" })).toBeVisible();
  await see(cards.first().getByRole("button")).toHaveText(["批准这次操作", "拒绝这次操作"]);
  // The partner that waits says so in the list, where the time of its last message would be.
  await page.getByRole("button", { name: "全部对话", exact: true }).click();
  await see(roster(page).locator(`[data-chat-key="agent:${scene.trip.id}"] .mau-roster-note`)).toHaveText("等待批准");
  await see(roster(page).locator(".mau-roster-note")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await see(roster(page)).toHaveCount(0);
  // Approved on the card.
  await cards.first().getByRole("button", { name: "批准这次操作" }).click();
  await see(cards.first()).toHaveAttribute("data-card-status", "approved");
  await see(status(0)).toHaveText("已批准");
  await see(status(0)).toHaveAttribute("data-tone", "success");
  await see(cards.first().getByRole("button")).toHaveCount(0);
  expect(await first.status()).toBe("approved");
  first.settle();

  // Refused. Arguments too long to show whole say that only the start of each is shown.
  const second = await request("b", "给酒店发送确认邮件", undefined, { body: "x".repeat(5000) });
  await see(cards).toHaveCount(2);
  await see(cards.nth(1).locator("p").first()).toContainText('参数（较长，以下每项只显示开头）：{"body":"xxx');
  await cards.nth(1).getByRole("button", { name: "拒绝这次操作" }).click();
  await see(status(1)).toHaveText("已拒绝");
  expect(await second.status()).toBe("denied");
  second.settle();

  // Answered somewhere else first: the answer given here does not count, and the card says so in words.
  const third = await request("c", "取消原来的预订");
  await see(cards).toHaveCount(3);
  behind = true;
  const elsewhere = (await f.events(f.agent.id)).flatMap((event) => event.kind === "card" ? [event.card.cardId] : []).at(-1)!;
  expect(await f.web().answerCard(f.chat(f.agent.id), elsewhere, { idempotencyKey: newIdempotencyKey(), choiceId: "0" })).toMatchObject({ status: "accepted" });
  await cards.nth(2).getByRole("button", { name: "拒绝这次操作" }).click();
  await see(cards.nth(2)).toContainText("已在其他地方回答。");
  await see(cards.nth(2).getByRole("button")).toHaveCount(0);
  expect(await third.status()).toBe("approved");
  third.settle();
  behind = false;

  // Not answered in time, and withdrawn because the partner's call ended: both close without an answer.
  const fourth = await request("d", "预订接机服务", new Date(Date.now() + 1500).toISOString());
  await f.until(async () => await fourth.status() === "expired", "expired");
  fourth.settle();
  const fifth = await request("e", "购买旅行保险");
  await fifth.withdraw();
  fifth.settle();
  await page.reload();
  await see(cards).toHaveCount(5);
  await see(cards.locator(".mau-card-status .agent-status-line")).toHaveText(["已批准", "已拒绝", "已批准", "已过期", "已撤回"]);
  await see(cards.getByRole("button")).toHaveCount(0);
  await see(status(3)).toHaveAttribute("data-tone", "neutral");
  // A card that closes while it is on screen changes in place.
  const sixth = await request("f", "预订机场大巴", new Date(Date.now() + 1500).toISOString());
  await see(cards).toHaveCount(6);
  await see(cards.nth(5).getByRole("button")).toHaveCount(2);
  await f.until(async () => await sixth.status() === "expired", "expired on screen");
  await see(status(5)).toHaveText("已过期");
  await see(cards.nth(5).getByRole("button")).toHaveCount(0);
  sixth.settle();
  // Nothing waits any more.
  await page.getByRole("button", { name: "全部对话", exact: true }).click();
  await see(roster(page).locator(`[data-chat-key="agent:${scene.trip.id}"]`)).toBeVisible();
  await see(roster(page).locator(".mau-roster-note")).toHaveCount(0);
  // The partner's turn ends; its result comes back alone, as that partner's block.
  scene.end(open.work, "改好了，确认邮件没有发。"); scene.end(open.turn, "已经交给 korea-trip。");
  scene.end(await f.until(() => f.turns.find((item) => item.agentId === f.agent.id && item.text.includes("改好了，确认邮件没有发。")), "result turn"), "入住人改好了。");
  await page.keyboard.press("Escape");
  // It follows that partner's cards, so it continues under the same figure and name.
  const returned = page.locator(`article[data-room-message-id$=":0"]`).last();
  await see(returned.locator(".room-chat-bubble")).toHaveText("改好了，确认邮件没有发。");
  await see(returned).toHaveAttribute("data-continued", "true");
  await see(page.locator("article").filter({ has: cards.first() }).locator(".room-chat-author")).toContainText("korea-trip");
  await see(page.locator(".room-chat-stream")).not.toContainText("Partner results");
  expect(errors).toEqual([]);
}, 90_000);

it.skipIf(!built)("a partner's request is worded in the interface's language from its members; one recorded without them is the server's text", async () => {
  const f = await partnersFixture(cleanup, { webRoot });
  const trip = (await f.api("/agents", { name: "korea-trip", shareWith: f.agent.id })).data.agent as { id: string };
  f.hold();
  await f.say(f.agent.id, "Change the booking to two guests");
  const turn = await f.turnOf(f.agent.id);
  const sent = await turn.call("partners", { action: "message", to: "korea-trip", text: "Change the booking to two guests.", intent: "relay" });
  await f.turnOf(trip.id);
  const asked = await f.approval(f.record(sent.messageId as string), { id: "a".repeat(40), summary: "Submit the change form on booking.example", connection: "trip-browser",
    arguments: { site: "https://booking.example", guests: 2 } });
  // A request as an earlier release recorded it: a title and a text, no members.
  (await workSessions(f, f.agent.id)).request({ eventId: "earlier-approval-1", kind: "approval", title: "伙伴「korea-trip」请求批准",
    text: "「korea-trip」在处理「helper」转来的消息时，需要你批准这个操作：\n发送确认邮件\n连接：trip-mail\n参数：{}",
    choices: [{ id: "allow", label: "批准这次操作" }, { id: "deny", label: "拒绝这次操作", style: "danger" }], expiresAt: new Date(Date.now() + 120_000).toISOString() });
  const { page, errors } = await browser(f, "en-US");
  await openChat(page, f, f.agent.id);
  const cards = page.locator(".mau-ledger-card[data-card-source='product']");
  await see(cards).toHaveCount(2);
  await see(cards.first().locator("strong")).toHaveText("Partner korea-trip asks for approval");
  await see(cards.first().locator("p").first()).toHaveText(["To handle a message from helper, it needs to run: Submit the change form on booking.example", "Connection: trip-browser",
    'Arguments: {"site":"https://booking.example","guests":2}'].join("\n"), { useInnerText: true });
  await see(cards.first().getByRole("button")).toHaveText(["Approve this operation", "Decline this operation"]);
  // The partner that asks is taken from the request, and leads to the conversation with it.
  const asking = page.locator("article").filter({ hasText: "Partner korea-trip asks for approval" });
  await see(asking.locator(".room-chat-author")).toContainText("korea-trip");
  await see(asking.getByRole("button", { name: "Open the conversation with korea-trip" })).toBeVisible();
  // Without members the card is the text and the choices the server wrote, under the partner of the conversation.
  await see(cards.nth(1).locator("strong")).toHaveText("伙伴「korea-trip」请求批准");
  await see(cards.nth(1).locator("p").first()).toContainText("需要你批准这个操作：\n发送确认邮件", { useInnerText: true });
  await see(cards.nth(1).getByRole("button")).toHaveText(["批准这次操作", "拒绝这次操作"]);
  await see(page.locator("article").filter({ hasText: "伙伴「korea-trip」请求批准" }).locator(".room-chat-author")).toContainText("helper");
  await cards.first().getByRole("button", { name: "Approve this operation" }).click();
  await see(cards.first().locator(".mau-card-status .agent-status-line")).toHaveText("Approved");
  expect(await asked.status()).toBe("approved");
  await cards.nth(1).getByRole("button", { name: "拒绝这次操作" }).click();
  await see(cards.nth(1).locator(".mau-card-status .agent-status-line")).toHaveText("Declined");
  expect(errors).toEqual([]);
}, 90_000);

it.skipIf(!built)("a partner is dismissed and restored from its profile and the list, which keeps dismissed partners out of sight", async () => {
  const f = await partnersFixture(cleanup, { webRoot });
  const scene = await partnerConversations(f);
  const long = "负责整理每周的读书笔记和待读清单，" + "把读过的书按主题归档并写一句话摘要，".repeat(9) + "月底汇总。";
  const notes = (await f.api("/agents", { name: "notes", shareWith: f.agent.id, duty: long.slice(0, 200) })).data.agent as { id: string };
  const { page, errors } = await browser(f);
  await openChat(page, f, scene.trip.id);
  await chip(page, scene.trip.id).click();
  const card = profile(page);
  await see(card.getByRole("heading", { name: "korea-trip" })).toBeVisible();
  // The environment it runs in and who recruited it are information, each naming a partner that can be opened.
  const row = (title: string) => card.locator(".agent-list-row").filter({ has: page.locator(".agent-list-row-title", { hasText: new RegExp(`^${title}$`) }) });
  await see(row("共用环境")).toHaveCount(1);
  await see(row("共用环境")).not.toHaveAttribute("data-tone", "action");
  await see(row("共用环境").locator("button.agent-list-row-main")).toHaveCount(0);
  await see(row("共用环境").getByRole("button", { name: "helper", exact: true })).toBeVisible();
  await see(row("招募者").getByRole("button", { name: "helper", exact: true })).toBeVisible();
  // A short duty is shown whole.
  await see(card.locator(".agent-detail-hero").getByRole("button")).toHaveCount(0);
  await profileTab(page, "配置");
  await see(row("共用环境").getByRole("button", { name: "helper", exact: true })).toBeVisible();
  await see(row("招募者")).toHaveCount(0);

  // Dismissing says in one sentence what it keeps, and is not the red, permanent deletion below it.
  await see(card.locator(".agent-list-row", { hasText: "解散伙伴" })).toHaveAttribute("data-tone", "action");
  await see(card.locator(".agent-list-row", { hasText: "删除伙伴" })).toHaveAttribute("data-tone", "danger");
  await card.getByRole("button", { name: "解散伙伴", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "解散 korea-trip？" });
  await see(dialog).toContainText("对话和记忆会保留，它不再出现在名单里，之后可以恢复。");
  await dialog.getByRole("button", { name: "解散", exact: true }).click();
  await see(notices(page)).toContainText("已解散 korea-trip");
  await see(card.locator(".mau-profile-state")).toHaveText("已解散");
  await see(card.getByRole("button", { name: "恢复伙伴", exact: true })).toBeVisible();
  await see(card.getByRole("button", { name: "解散伙伴", exact: true })).toHaveCount(0);
  expect((await f.api(`/agents/${scene.trip.id}`)).data.dismissed).toEqual(expect.any(String));

  // The list: dismissed partners are behind one row at the end of the partners, and each can be restored there.
  await card.getByRole("button", { name: "全部对话" }).click();
  const list = roster(page), partners = list.getByRole("region", { name: "伙伴" });
  await see(partners.locator("h3")).toContainText("伙伴 · 3");
  await see(partners.locator(`[data-chat-key="agent:${scene.trip.id}"]`)).toHaveCount(0);
  const archive = partners.getByRole("button", { name: "已解散 · 1", exact: true });
  await see(archive).toHaveAttribute("aria-expanded", "false");
  await archive.click();
  await see(partners.locator(`[data-chat-key="agent:${scene.trip.id}"]`)).toBeVisible();
  await see(partners.locator(".mau-roster-row").last()).toHaveAttribute("data-chat-key", `agent:${scene.trip.id}`);
  // A search finds a dismissed partner by its name.
  await page.reload();
  await page.getByRole("button", { name: "全部对话", exact: true }).click();
  await list.getByPlaceholder("搜索").fill("korea");
  await see(partners.locator(`[data-chat-key="agent:${scene.trip.id}"]`)).toBeVisible();
  await partners.getByRole("button", { name: "恢复 · korea-trip", exact: true }).click();
  await see(notices(page)).toContainText("已恢复 korea-trip");
  await list.getByPlaceholder("搜索").fill("");
  await see(partners.locator("h3")).toContainText("伙伴 · 4");
  await see(partners.getByRole("button", { name: /已解散/ })).toHaveCount(0);
  expect((await f.api(`/agents/${scene.trip.id}`)).data.dismissed).toBeNull();

  // The header row leaves a dismissed partner out; its conversation is still there when it is opened from the list.
  expect((await f.api(`/agents/${scene.visa.id}/dismiss`, {})).status).toBe(200);
  // Settings leave it out too: the channels of each partner, and the partners that use a connection.
  await page.route("**/_mau/v1/connector-accounts**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/connector-accounts")) return route.fulfill({ json: { configured: true, data: [{ id: "work-gmail", kind: "google", label: "Gmail", state: "connected",
      verification: "oauth", scopes: [], assignedAgents: [f.agent.id, scene.trip.id, scene.visa.id], permission: "read-only" }] } });
    if (path.endsWith("/policy")) return route.fulfill({ status: 404, json: { error: "not_found" } });
    return route.fulfill({ json: { state: "connected", verification: "oauth", scopes: [] } });
  });
  await page.goto(f.base + "/#/settings/channels");
  const settings = page.getByRole("dialog", { name: "设置" });
  await see(settings.locator(".agent-settings-section h3")).toHaveText(["helper", "korea-trip", "notes"]);
  await settings.getByRole("button", { name: "连接器", exact: true }).click();
  await settings.getByRole("button", { name: "Gmail", exact: true }).click();
  await see(settings.locator(".agent-settings-section", { hasText: "使用此连接的伙伴" }).locator(".agent-list-row-title")).toHaveText(["helper", "korea-trip"]);
  await openChat(page, f, f.agent.id);
  await see(chip(page, scene.trip.id)).toBeVisible();
  await see(chip(page, scene.visa.id)).toHaveCount(0);
  await page.getByRole("button", { name: "全部对话", exact: true }).click();
  await partners.getByRole("button", { name: "已解散 · 1", exact: true }).click();
  await partners.locator(`[data-chat-key="agent:${scene.visa.id}"]`).click();
  await see(chip(page, scene.visa.id)).toHaveAttribute("aria-selected", "true");
  await see(page.locator(".room-chat-stream")).toContainText("韩国旅游签证现在要多久能办下来？");
  // Restoring from the profile; a refusal of the server is said in words.
  await chip(page, scene.visa.id).click();
  await see(card.locator(".mau-profile-state")).toHaveText("已解散");
  await profileTab(page, "配置");
  const gone = await fetch(`${f.base}/_mau/v1/agents/${scene.visa.id}`, { method: "DELETE", headers: { authorization: "Bearer alice" } });
  expect(gone.status).toBe(204);
  await card.getByRole("button", { name: "恢复伙伴", exact: true }).click();
  await see(notices(page)).toContainText("找不到这个伙伴。");
  await see(notices(page)).not.toContainText("agent_not_found");

  // A duty longer than three lines is folded until it is opened.
  await openChat(page, f, notes.id);
  await chip(page, notes.id).click();
  const hero = card.locator(".agent-detail-hero"), duty = hero.locator("p");
  await see(duty).toHaveAttribute("data-clamped", "");
  const lines = () => duty.evaluate((element) => Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)));
  expect(await lines()).toBe(3);
  await hero.getByRole("button", { name: "展开", exact: true }).click();
  expect(await lines()).toBeGreaterThan(3);
  await see(duty).toHaveText(long.slice(0, 200));
  await hero.getByRole("button", { name: "收起", exact: true }).click();
  expect(await lines()).toBe(3);
  // A partner the owner made has no recruiter to name.
  await see(row("招募者")).toHaveCount(0);
  expect(errors).toEqual([]);
}, 90_000);

it.skipIf(!built)("a partner sharing an environment that offers several kernels is put on the one the owner chooses, and its profile shows its own", async () => {
  // The fixture's environment (helper, on codex) also offers claude; the Host does not have that runtime available at first.
  const claude: Record<string, unknown> = { kernel: "claude", model: "claude-main", capabilities: { features: { "input.nativeItems": { status: "unsupported" } } }, available: false };
  const f = await partnersFixture(cleanup, { webRoot, runtimes: { claude }, profile: { otherKernels: [{ kernel: "claude", runtimeId: "claude" }] } });
  f.discovery("claude", { id: "claude", kernel: "claude", model: "claude-main", allowedSettings: { model: { values: ["claude-main", "claude-small"] }, effort: { values: ["low", "high"] } },
    native: { models: [{ value: "claude-main", displayName: "Main", supportedEffortLevels: ["low", "high"] }, { value: "claude-small", displayName: "Small", supportedEffortLevels: ["low"] }] } });
  const { page, errors } = await browser(f);
  const posted: unknown[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/_mau/v1/agents")) posted.push(request.postDataJSON()); });
  await openChat(page, f, f.agent.id);
  const dialog = page.getByRole("dialog", { name: "新建伙伴" });
  const sharing = async (name: string) => {
    await page.getByRole("button", { name: "全部对话", exact: true }).click();
    await roster(page).getByRole("button", { name: "新建伙伴", exact: true }).click();
    await dialog.getByLabel("名称").fill(name);
    await dialog.getByRole("group", { name: "环境类型" }).getByRole("button", { name: "与伙伴共用", exact: true }).click();
    await see(dialog.getByRole("combobox", { name: "伙伴", exact: true })).toContainText("helper");
  };
  const kernel = dialog.getByRole("combobox", { name: "内核", exact: true });
  // The environment's main kernel is the choice until another is made.
  await sharing("writer");
  await see(kernel).toContainText("codex");
  await kernel.click();
  await see(page.getByRole("option")).toHaveText(["codex", "claude"]);
  await page.getByRole("option", { name: "claude", exact: true }).click();
  await see(kernel).toContainText("claude");
  // The kernel is offered, but its runtime is not available in the environment now: said in words, nothing created.
  await dialog.getByRole("button", { name: "创建" }).click();
  await see(dialog.getByRole("alert")).toHaveText("所选内核的运行时现在在这个环境里不可用，请换一个内核或稍后再试。");
  delete claude.available;
  await dialog.getByRole("button", { name: "创建" }).click();
  await see(dialog).toHaveCount(0);
  const writer = await f.until(() => f.partner("writer"), "writer created");
  await see(chip(page, writer.id)).toHaveAttribute("aria-selected", "true");
  // Its profile shows the kernel it runs on, and the models of that kernel; the partner that has the environment keeps its own.
  const card = profile(page), row = (title: string) => card.locator(".agent-list-row").filter({ has: page.locator(".agent-list-row-title", { hasText: new RegExp(`^${title}$`) }) });
  await chip(page, writer.id).click();
  await profileTab(page, "配置");
  await see(row("内核").locator(".mau-profile-value")).toHaveText("claude");
  await see(card.getByRole("combobox", { name: "模型", exact: true })).toContainText("默认 · Main");
  await card.getByRole("combobox", { name: "模型", exact: true }).click();
  await see(page.getByRole("option")).toHaveText(["默认 · Main", "Main", "Small"]);
  await page.keyboard.press("Escape");
  await row("共用环境").getByRole("button", { name: "helper", exact: true }).click();
  await see(card.getByRole("heading", { name: "helper" })).toBeVisible();
  await profileTab(page, "配置");
  await see(row("内核").locator(".mau-profile-value")).toHaveText("codex");
  await see(card.getByRole("combobox", { name: "模型", exact: true })).toContainText("默认 · Large");
  await page.keyboard.press("Escape");
  // The main kernel is not named in the request.
  await sharing("clerk");
  await see(kernel).toContainText("codex");
  await dialog.getByRole("button", { name: "创建" }).click();
  await see(dialog).toHaveCount(0);
  expect(posted).toEqual([{ name: "writer", shareWith: f.agent.id, kernel: "claude" }, { name: "writer", shareWith: f.agent.id, kernel: "claude" }, { name: "clerk", shareWith: f.agent.id }]);
  const kernelOf = async (name: string) => (await f.api(`/agents/${f.partner(name).id}`)).data.kernel;
  expect([await kernelOf("helper"), await kernelOf("writer"), await kernelOf("clerk")]).toEqual(["codex", "claude", "codex"]);
  expect(errors).toEqual([]);
}, 90_000);

it.skipIf(!built)("the English console calls them partners, in conversations, activity and the profile", async () => {
  const f = await partnersFixture(cleanup, { webRoot });
  const scene = await partnerConversations(f);
  const { page, errors } = await browser(f, "en-US");
  await openChat(page, f, f.agent.id);
  const run = page.locator(".mau-run").first();
  await see(run.locator(".og-disclosure--room-run > .og-disclosure-row > .og-disclosure-toggle")).toHaveText("Recruited korea-trip, Recruited visa, Informed korea-trip 1 error");
  await run.locator(".og-disclosure--room-run > .og-disclosure-row > .og-disclosure-toggle").click();
  await run.locator(".thread-activity-toggle").click();
  await see(run.locator(".thread-activity-row-title")).toHaveText(["Looked at the partners", "Recruited korea-trip", "Recruited visa", "Informed korea-trip", "Could not ask flights"]);
  await see(run.getByRole("alert")).toHaveText("Partner not found.");
  await see(page.locator(`article[data-room-message-id$=":1"] .room-chat-status`)).toContainText("Not completed");
  await page.locator(`article[data-room-message-id$=":0"]`).getByRole("button", { name: "Open the conversation with korea-trip" }).click();
  await see(chip(page, scene.trip.id)).toHaveAttribute("aria-selected", "true");
  await chip(page, scene.trip.id).click();
  const card = page.getByRole("complementary", { name: "Partner profile" });
  await see(card.locator(".agent-list-row-title")).toContainText(["Shared environment", "Recruited by"]);
  await card.getByRole("group", { name: "Profile sections" }).getByRole("button", { name: "Configuration", exact: true }).click();
  await see(card.getByRole("button", { name: "Dismiss partner", exact: true })).toBeVisible();
  await see(card.getByRole("button", { name: "Delete partner", exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Dismiss partner", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dismiss korea-trip?" });
  await see(dialog).toContainText("Its conversation and memory are kept. It leaves the list and can be restored later.");
  await dialog.getByRole("button", { name: "Dismiss", exact: true }).click();
  await see(card.getByRole("button", { name: "Restore partner", exact: true })).toBeVisible();
  await card.getByRole("button", { name: "All conversations" }).click();
  const partners = page.getByRole("complementary", { name: "All conversations" }).getByRole("region", { name: "Partners" });
  await see(partners.locator("h3")).toContainText("Partners · 2");
  await see(partners.getByRole("button", { name: "New partner", exact: true })).toBeVisible();
  await see(partners.getByRole("button", { name: "Dismissed · 1", exact: true })).toBeVisible();
  await see(page.locator("body")).not.toContainText(/\bagents?\b/i);
  expect(errors).toEqual([]);
}, 90_000);
