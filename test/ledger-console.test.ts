import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, expect as see } from "@playwright/test";
import { mauFixture } from "./fixtures/mau.js";

// Browser acceptance of the ledger console's phase 4 controls (agent-router ADR 0005 section 16) against the built
// console and the local Router build: "新对话", a Router card answered by its button, and purge with a typed name.
const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));
const built = existsSync(webRoot + "index.html");
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it.skipIf(!built)("starts a new chat, answers a card and purges the history from the ledger console", async (context) => {
  const f = await mauFixture(cleanup, { webRoot }, undefined, {}, { ledgerRead: true, ledgerSend: true, ledgerCards: true, ledgerControl: true });
  if (typeof (f.mau.router as { upgrade?: unknown }).upgrade !== "function" || !(f.service as { web?: unknown }).web) return context.skip();
  const me = await (await fetch(f.base + "/_agent-router/v1/web/me", { headers: { authorization: "Bearer alice" } })).json() as { limits?: { features?: Record<string, boolean> } };
  if (!me.limits?.features?.reset || !me.limits.features.cards) return context.skip();
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");

  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const browser = await instance.newContext({ locale: "zh-CN", reducedMotion: "reduce", viewport: { width: 1200, height: 900 } });
  await browser.addInitScript(() => localStorage.setItem("mau.chatSource", "ledger"));
  await browser.route("https://example.test/_matrix/client/v3/**", async (route) => {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (route.request().url().endsWith("/login")) return route.fulfill({ json: { access_token: "alice", user_id: "@alice:example.test" }, headers: cors });
    return route.fulfill({ json: {}, headers: cors });
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(f.base);
  await page.getByLabel("账号").fill("alice");
  await page.getByLabel("密码").fill("correct");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByRole("button", { name: "发起单聊", exact: true }).first().click();
  await page.getByLabel("选择员工").selectOption(f.agent.id);
  await page.getByRole("button", { name: "打开对话", exact: true }).click();
  await see(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await see(page.getByText("—— 新的会话窗口 ——")).toBeVisible();

  // An unknown turn's Router card (ADR 6.2.4), written into the agent ledger as the Host worker would.
  const runtime = await f.service.runtime(f.agent.id);
  const db = (runtime.connector.store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  const session = db.prepare("SELECT session_key, window, last_seq FROM ledger_sessions WHERE kind='owner_main'").get() as { session_key: string; window: number; last_seq: number };
  const now = Date.now(), seq = Number(session.last_seq) + 1, cardId = "cd_console_retry", turnId = "t-console";
  const card = { cardId, agentId: f.agent.id, turnId, claimId: "claim-console", callId: `router-retry:${turnId}`, kind: "question", source: "router",
    text: "这一轮执行中断，结果无法确认。要重新执行吗？", choices: [{ choiceId: "0", label: "重新执行" }, { choiceId: "1", label: "不用了" }], freeText: false, deadlineAt: null };
  db.prepare("INSERT INTO ledger_turns(turn_id,session_key,window,admission,state,created_at) VALUES(?,?,?,'owner','unknown',?)").run(turnId, session.session_key, session.window, now);
  db.prepare(`INSERT INTO ledger_events(session_key,seq,event_id,window,kind,role,sender_type,sender_id,turn_id,idempotency_key,created_at,body)
    VALUES(?,?,?,?,'card','assistant','system','router',?,?,?,?)`).run(session.session_key, seq, "ev_console_card", session.window, turnId, `card:${cardId}`, now, JSON.stringify({ card }));
  db.prepare(`INSERT INTO ledger_cards(card_id,call_id,run_id,claim_id,turn_id,session_key,event_id,kind,status,updated_at,source)
    VALUES(?,?,?,?,?,?,?,'question','pending',?,'router')`).run(cardId, card.callId, "router:claim-console", card.claimId, turnId, session.session_key, "ev_console_card", now);
  for (const [choice, action] of [["0", "retry"], ["1", "skip"]]) db.prepare("INSERT INTO ledger_card_tokens(token,card_id,choice_id,result) VALUES(?,?,?,?)")
    .run(`tok-${choice}`, cardId, choice, JSON.stringify({ action }));
  db.prepare("UPDATE ledger_sessions SET last_seq=? WHERE session_key=?").run(seq, session.session_key);
  await page.reload();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  const shown = page.locator(`[data-card-id="${cardId}"]`);
  await see(shown).toContainText("要重新执行吗");
  await shown.getByRole("button", { name: "不用了" }).click();
  await see(shown).toHaveAttribute("data-card-status", "answered");
  await see(shown).toContainText("已回答");
  expect(db.prepare("SELECT status, answer_surface FROM ledger_cards WHERE card_id=?").get(cardId)).toMatchObject({ status: "answered", answer_surface: "web" });

  await page.getByRole("button", { name: "清空聊天记录", exact: true }).click();
  const purge = page.getByRole("dialog", { name: "清空聊天记录？" });
  await see(purge).toContainText("Agent 已经写入的记忆不会被删除");
  await see(purge.getByRole("button", { name: "永久清空" })).toBeDisabled();
  await purge.getByRole("textbox").fill("helper");
  await purge.getByRole("button", { name: "永久清空" }).click();
  await see(purge).toBeHidden();
  await see(shown).toBeHidden();
  // The purged chat restarts with its new window only.
  await see.poll(async () => (await (await fetch(f.base + `/_agent-router/v1/web/chats/${encodeURIComponent("dm:" + f.agent.id)}/events`,
    { headers: { authorization: "Bearer alice" } })).json() as { events: Array<{ kind: string }> }).events.map((event) => event.kind)).toEqual(["window"]);
  await see(page.getByText("—— 新的会话窗口 ——")).toHaveCount(1);
  expect(Number((db.prepare("SELECT generation FROM ledger_sessions WHERE session_key=?").get(session.session_key) as { generation: number }).generation)).toBe(2);
  expect(errors).toEqual([]);
}, 60_000);
