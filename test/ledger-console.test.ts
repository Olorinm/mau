import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { chromium, expect as see } from "@playwright/test";
import { alice, mauFixture } from "./fixtures/mau.js";
import { accessIssuer } from "./fixtures/access.js";

// Browser acceptance of the ledger console's phase 4 features (agent-router ADR 0005 section 16) against the built
// console and the local Router build: controls ("新对话", a Router card answered by its button, purge with a typed
// name) and attachments (16.5). Released Routers before phase 4 skip them.
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

// A 2×2 RGB PNG, so the inline image has real dimensions.
const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]), out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length); return out;
};
const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
  chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]))), chunk("IEND", Buffer.alloc(0))]);

it.skipIf(!built)("attaches, uploads with progress, sends and renders images inline and files as download chips", async (context) => {
  const runs = new Map<string, Record<string, unknown>>(), media: unknown[][] = [];
  const host = (url: URL, init?: RequestInit) => {
    const method = init?.method ?? "GET", path = url.pathname;
    if (path.endsWith("/runs") && method === "POST") {
      const body = JSON.parse(String(init?.body)), id = `run-${runs.size + 1}`;
      media.push(Array.isArray(body.attachments) ? body.attachments : []);
      const run = { id, sessionId: body.sessionId, runtimeId: body.runtimeId, status: "completed", answer: `收到-${runs.size + 1}` };
      runs.set(id, run); return Response.json(run);
    }
    if (path.endsWith("/events")) return Response.json({ events: [], cursor: 0, hasMore: false, historyTruncated: false });
    if (path.endsWith("/calls")) return Response.json({ calls: [] });
    const run = /\/runs\/(run-\d+)$/.exec(path)?.[1];
    if (run && runs.has(run)) return Response.json(runs.get(run));
    return Response.json({ error: "fixture_unknown_path" }, { status: 404 });
  };
  const f = await mauFixture(cleanup, { webRoot, host, hostCapabilities: { runIdempotency: true } }, undefined, {},
    { ledgerRead: true, ledgerSend: true, ledgerAttachments: true });
  const me = await (await fetch(f.base + "/_agent-router/v1/web/me", { headers: { authorization: "Bearer alice" } })).json() as { limits?: { features?: Record<string, boolean> } };
  if (!me.limits?.features?.attachments) return context.skip();
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");

  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const page = await (await instance.newContext({ locale: "zh-CN", reducedMotion: "reduce", viewport: { width: 1200, height: 900 } })).newPage();
  const errors: string[] = [], violations: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) violations.push(message.text()); });
  const uploads: Array<Record<string, string>> = [];
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/_agent-router/v1/web/attachments") uploads.push(request.headers()); });
  await page.goto(f.base);
  await page.evaluate(() => {
    localStorage.setItem("mau.session", JSON.stringify({ token: "alice", owner: "@alice:example.test" }));
    localStorage.setItem("mau.chatSource", "ledger");
  });
  await page.reload();
  page.setDefaultTimeout(10_000);
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByRole("button", { name: "发起单聊", exact: true }).click();
  await page.getByLabel("选择员工").selectOption(f.agent.id);
  await page.getByRole("button", { name: "打开对话", exact: true }).click();
  const composer = page.getByPlaceholder("发送消息…");
  await see(composer).toBeEnabled();

  // The attach button's file input (shared composer), then a paste of a text file into the composer.
  await page.locator("input[type=file]").setInputFiles([{ name: "图.png", mimeType: "image/png", buffer: png }]);
  await composer.focus();
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["备忘"], "notes.txt", { type: "text/plain" }));
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  // Both uploaded: the composer chips show their size instead of the progress.
  const drafts = page.locator(".room-composer");
  await see(drafts.getByText(/notes\.txt\s*6 B/)).toBeVisible();
  await see(drafts.getByText(/上传中/)).toHaveCount(0);
  expect(uploads.map((headers) => [headers["content-type"], headers["x-file-name"]])).toEqual([
    ["image/png", "UTF-8''%E5%9B%BE.png"], ["text/plain", "UTF-8''notes.txt"]]);
  expect(uploads.every((headers) => /^[0-9a-f]{64}$/.test(headers["x-sha256"] ?? ""))).toBe(true);

  await composer.fill("看附件");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  // The stored message renders the image inline (fetched with the bearer, shown as a blob: URL) and the file as a chip.
  const image = page.locator(".mau-attachment-image img[alt='图.png']").first();
  await see(image).toBeVisible();
  await see.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2);
  expect(await image.getAttribute("src")).toMatch(/^blob:/);
  const chip = page.getByRole("button", { name: "下载 notes.txt，6 B", exact: true }).first();
  await see(chip).toBeVisible();
  await see(page.locator(".room-chat-stream").getByText("收到-1").first()).toBeVisible();
  expect(media[0]).toMatchObject([{ name: "图.png", mediaType: "image/png" }, { name: "notes.txt", mediaType: "text/plain" }]);
  // The download chip saves the bytes.
  const [download] = await Promise.all([page.waitForEvent("download"), chip.click()]);
  expect(download.suggestedFilename()).toBe("notes.txt");
  // Composer cleared after the send.
  await see(drafts.getByText(/notes\.txt\s*6 B/)).toHaveCount(0);

  // Drag and drop onto the conversation: a file over the advertised 25 MB limit fails without an upload request.
  const before = uploads.length;
  await page.evaluate(() => {
    const target = document.querySelector(".mau-dropzone .room-chat-stream") ?? document.querySelector(".mau-dropzone *")!, data = new DataTransfer();
    data.items.add(new File([new Uint8Array(25 * 1024 * 1024 + 1)], "huge.bin", { type: "application/octet-stream" }));
    target.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await see(page.getByRole("alert").getByText(/huge\.bin：文件超过 25 MB/)).toBeVisible();
  expect(uploads.length).toBe(before);
  await page.getByRole("alert").getByRole("button", { name: "移除", exact: true }).click();
  await see(page.getByText(/huge\.bin/)).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(violations).toEqual([]);
}, 60_000);

it.skipIf(!built)("with an edge login uploads without a bearer and shows inline images from their same-origin URL", async (context) => {
  const runs = new Map<string, Record<string, unknown>>();
  const host = (url: URL, init?: RequestInit) => {
    const method = init?.method ?? "GET", path = url.pathname;
    if (path.endsWith("/runs") && method === "POST") {
      const body = JSON.parse(String(init?.body)), id = `run-${runs.size + 1}`;
      const run = { id, sessionId: body.sessionId, runtimeId: body.runtimeId, status: "completed", answer: `收到-${runs.size + 1}` };
      runs.set(id, run); return Response.json(run);
    }
    if (path.endsWith("/events")) return Response.json({ events: [], cursor: 0, hasMore: false, historyTruncated: false });
    if (path.endsWith("/calls")) return Response.json({ calls: [] });
    const run = /\/runs\/(run-\d+)$/.exec(path)?.[1];
    if (run && runs.has(run)) return Response.json(runs.get(run));
    return Response.json({ error: "fixture_unknown_path" }, { status: 404 });
  };
  const access = await accessIssuer(cleanup);
  const f = await mauFixture(cleanup, { webRoot, host, hostCapabilities: { runIdempotency: true } }, undefined,
    { edgeIdentity: access.config({ "alice@example.test": alice }) }, { ledgerRead: true, ledgerSend: true, ledgerAttachments: true },
    { edgeIdentityCerts: access.certsUrl });
  const jwt = access.jwt();
  const me = await (await fetch(f.base + "/_agent-router/v1/web/me", { headers: { "cf-access-jwt-assertion": jwt } })).json() as { limits?: { features?: Record<string, boolean> }; auth?: { via?: string } };
  // Released Routers before edge login and attachments skip.
  if (!me.limits?.features?.attachments || me.auth?.via !== "edge") return context.skip();
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");

  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  // Cloudflare adds the JWT to every request behind Access; the console itself sends no token.
  const browser = await instance.newContext({ locale: "zh-CN", reducedMotion: "reduce", viewport: { width: 1200, height: 900 },
    extraHTTPHeaders: { "cf-access-jwt-assertion": jwt } });
  await browser.addInitScript(() => localStorage.setItem("mau.chatSource", "ledger"));
  const page = await browser.newPage();
  const errors: string[] = [], authorization: string[] = [], uploads: number[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { const value = request.headers()["authorization"]; if (value) authorization.push(value); });
  page.on("response", (response) => { if (response.request().method() === "POST" && new URL(response.url()).pathname === "/_agent-router/v1/web/attachments") uploads.push(response.status()); });
  await page.goto(f.base);
  page.setDefaultTimeout(10_000);
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByRole("button", { name: "发起单聊", exact: true }).click();
  await page.getByLabel("选择员工").selectOption(f.agent.id);
  await page.getByRole("button", { name: "打开对话", exact: true }).click();
  const composer = page.getByPlaceholder("发送消息…");
  await see(composer).toBeEnabled();
  // A text/plain upload passes Router's edge CSRF guard because it carries X-File-Name (ADR 0005 attachments note 13).
  await page.locator("input[type=file]").setInputFiles([{ name: "图.png", mimeType: "image/png", buffer: png },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("备忘") }]);
  await see(page.locator(".room-composer").getByText(/notes\.txt\s*6 B/)).toBeVisible();
  expect(uploads).toEqual([201, 201]);
  await composer.fill("边缘登录的附件");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const image = page.locator(".mau-attachment-image img[alt='图.png']").first();
  await see(image).toBeVisible();
  await see.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2);
  expect(await image.getAttribute("src")).toMatch(/^\/_agent-router\/v1\/web\/attachments\/at_/);
  expect(authorization).toEqual([]);
  expect(errors).toEqual([]);
}, 60_000);
