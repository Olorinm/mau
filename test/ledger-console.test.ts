import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { chromium, expect as see } from "@playwright/test";
import { edgeMauFixture } from "./fixtures/edge.js";
import { ManagedService } from "@agent-router/server";

// Browser acceptance of the ledger console's phase 4 features (agent-router ADR 0005 section 16) against the built
// console and the local Router build: controls (the "/new" and "/clear" commands, a Router card answered by its button,
// purge with a typed name) and attachments (16.5). Released Routers before phase 4 skip them.
const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));
const built = existsSync(webRoot + "index.html");
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it.skipIf(!built)("starts a new chat, answers a card and purges the history from the ledger console", async (context) => {
  const f = await edgeMauFixture(cleanup, { webRoot }, { ledgerRead: true, ledgerSend: true, ledgerCards: true, ledgerControl: true });
  if (typeof (f.mau.router as { upgrade?: unknown }).upgrade !== "function" || !(f.service as { web?: unknown }).web) return context.skip();
  const me = await (await fetch(f.base + "/_agent-router/v1/web/me", { headers: f.edgeHeaders() })).json() as { limits?: { features?: Record<string, boolean> } };
  if (!me.limits?.features?.reset || !me.limits.features.cards) return context.skip();
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");

  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const browser = await instance.newContext({ locale: "zh-CN", reducedMotion: "reduce", viewport: { width: 1200, height: 900 },
    extraHTTPHeaders: f.edgeHeaders() });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(f.base);
  await page.getByRole("button", { name: "对话", exact: true }).click();
  // The employee is in the header row before any chat exists; a click opens the DM.
  await page.locator(`.mau-chip[data-chat-key="agent:${f.agent.id}"]`).click();
  // No control buttons in the header: "/" lists the commands, Enter runs the highlighted one.
  await see(page.getByRole("button", { name: "新对话", exact: true })).toHaveCount(0);
  const composer = page.getByPlaceholder("发送消息…");
  await composer.fill("/");
  const commands = page.getByRole("listbox", { name: "斜杠命令" });
  await see(commands.getByRole("option")).toHaveText([/\/new/, /\/clear/]);
  await composer.fill("/ne");
  await see(commands.getByRole("option")).toHaveText([/\/new/]);
  await composer.press("Enter");
  await see(composer).toHaveValue("");
  await see(page.locator(".mau-chat-divider[data-kind='window']")).toHaveText("新对话");

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

  await composer.fill("/clear");
  await page.getByRole("option", { name: /\/clear/ }).click();
  const purge = page.getByRole("dialog", { name: "清空聊天记录？" });
  await see(purge).toContainText("员工已经写入的记忆不会被删除");
  await see(purge.getByRole("button", { name: "永久清空" })).toBeDisabled();
  await purge.getByRole("textbox").fill("helper");
  await purge.getByRole("button", { name: "永久清空" }).click();
  await see(purge).toBeHidden();
  await see(shown).toBeHidden();
  // The purged chat restarts with its new window only.
  await see.poll(async () => (await (await fetch(f.base + `/_agent-router/v1/web/chats/${encodeURIComponent("dm:" + f.agent.id)}/events`,
    { headers: f.edgeHeaders() })).json() as { events: Array<{ kind: string }> }).events.map((event) => event.kind)).toEqual(["window"]);
  await see(page.locator(".mau-chat-divider[data-kind='window']")).toHaveCount(1);
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

it.skipIf(!built)("attaches, uploads with progress, sends and renders images inline and files as download cards", async (context) => {
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
  const f = await edgeMauFixture(cleanup, { webRoot, host, hostCapabilities: { runIdempotency: true } },
    { ledgerRead: true, ledgerSend: true, ledgerAttachments: true });
  const me = await (await fetch(f.base + "/_agent-router/v1/web/me", { headers: f.edgeHeaders() })).json() as { limits?: { features?: Record<string, boolean> } };
  if (!me.limits?.features?.attachments) return context.skip();
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");

  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const page = await (await instance.newContext({ locale: "zh-CN", reducedMotion: "reduce", viewport: { width: 1200, height: 900 },
    extraHTTPHeaders: f.edgeHeaders() })).newPage();
  const errors: string[] = [], violations: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) violations.push(message.text()); });
  const uploads: Array<Record<string, string>> = [];
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/_agent-router/v1/web/attachments") uploads.push(request.headers()); });
  await page.goto(f.base);
  page.setDefaultTimeout(10_000);
  await page.getByRole("button", { name: "对话", exact: true }).click();
  // The employee is in the header row before any chat exists; a click opens the DM.
  await page.locator(`.mau-chip[data-chat-key="agent:${f.agent.id}"]`).click();
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
  // The stored message renders the image inline (from its same-origin URL; the browser sends the Access session) and
  // the file as a card with its kind, above the text.
  const image = page.locator(".mau-attachment-image img[alt='图.png']").first();
  await see(image).toBeVisible();
  await see.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2);
  expect(await image.getAttribute("src")).toMatch(/^\/_agent-router\/v1\/web\/attachments\/at_/);
  const chip = page.locator(".room-chat-stream .room-message-file", { hasText: "notes.txt" }).first();
  await see(chip).toHaveText(/notes\.txt\s*文本 · 6 B/);
  await see(chip).toHaveAttribute("title", "下载 notes.txt");
  const sent = page.locator(".room-chat-message.from-user", { has: page.locator(".room-message-file", { hasText: "notes.txt" }) }).first();
  expect(await sent.evaluate((element) => {
    const card = element.querySelector(".mau-attachments")!, bubble = element.querySelector(".room-chat-bubble")!;
    return card.getBoundingClientRect().bottom <= bubble.getBoundingClientRect().top;
  })).toBe(true);
  await see(page.locator(".room-chat-stream").getByText("收到-1").first()).toBeVisible();
  expect(media[0]).toMatchObject([{ name: "图.png", mediaType: "image/png" }, { name: "notes.txt", mediaType: "text/plain" }]);
  // The file card saves the bytes.
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

// Edge login needs a Router with `authenticateRequest` (agent-router ADR 0005 18.2); the pinned release skips.
const edgeRouter = typeof (ManagedService.prototype as { authenticateRequest?: unknown }).authenticateRequest === "function";
it.skipIf(!built || !edgeRouter)("with an edge login uploads without a bearer and shows inline images from their same-origin URL", async (context) => {
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
  const f = await edgeMauFixture(cleanup, { webRoot, host, hostCapabilities: { runIdempotency: true } },
    { ledgerRead: true, ledgerSend: true, ledgerAttachments: true });
  const jwt = f.access.jwt();
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
  const page = await browser.newPage();
  const errors: string[] = [], authorization: string[] = [], uploads: number[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { const value = request.headers()["authorization"]; if (value) authorization.push(value); });
  page.on("response", (response) => { if (response.request().method() === "POST" && new URL(response.url()).pathname === "/_agent-router/v1/web/attachments") uploads.push(response.status()); });
  await page.goto(f.base);
  page.setDefaultTimeout(10_000);
  await page.getByRole("button", { name: "对话", exact: true }).click();
  // The employee is in the header row before any chat exists; a click opens the DM.
  await page.locator(`.mau-chip[data-chat-key="agent:${f.agent.id}"]`).click();
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

it.skipIf(!built)("while a reply runs, the send button stops it and text sent goes into the running turn", async (context) => {
  const runs = new Map<string, Record<string, unknown>>(), steered: string[] = [], started: string[] = [];
  const host = (url: URL, init?: RequestInit) => {
    const method = init?.method ?? "GET", path = url.pathname;
    if (path.endsWith("/runs") && method === "POST") {
      const body = JSON.parse(String(init?.body)), id = `run-${runs.size + 1}`;
      started.push(String(body.input));
      const run = { id, sessionId: body.sessionId, runtimeId: body.runtimeId, status: "running", answer: "" };
      runs.set(id, run); return Response.json(run);
    }
    if (path.endsWith("/runs/by-request")) return Response.json({ run: null });
    if (path.endsWith("/events")) return Response.json({ events: [], cursor: 0, hasMore: false, historyTruncated: false });
    if (path.endsWith("/calls")) return Response.json({ calls: [] });
    if (path.endsWith("/steer")) { steered.push(String(JSON.parse(String(init?.body)).input)); return Response.json({}); }
    const cancel = /\/runs\/(run-\d+)\/cancel$/.exec(path)?.[1];
    if (cancel && runs.has(cancel)) { runs.get(cancel)!.status = "cancelled"; return Response.json({ cancellationRequested: true }); }
    const run = /\/runs\/(run-\d+)$/.exec(path)?.[1];
    if (run && runs.has(run)) return Response.json(runs.get(run));
    return Response.json({ error: "fixture_unknown_path" }, { status: 404 });
  };
  const f = await edgeMauFixture(cleanup, { webRoot, host, hostCapabilities: { runIdempotency: true } },
    { ledgerRead: true, ledgerSend: true, ledgerCards: true, ledgerControl: true });
  const me = await (await fetch(f.base + "/_agent-router/v1/web/me", { headers: f.edgeHeaders() })).json() as { limits?: { features?: Record<string, boolean> } };
  if (!me.limits?.features?.reset) return context.skip();
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");

  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const page = await (await instance.newContext({ locale: "zh-CN", reducedMotion: "reduce", viewport: { width: 1200, height: 900 },
    extraHTTPHeaders: f.edgeHeaders() })).newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(f.base);
  page.setDefaultTimeout(10_000);
  await page.getByRole("button", { name: "对话", exact: true }).click();
  // The employee is in the header row before any chat exists; a click opens the DM.
  await page.locator(`.mau-chip[data-chat-key="agent:${f.agent.id}"]`).click();
  const composer = page.getByPlaceholder("发送消息…");
  await composer.fill("查一下天气");
  await composer.press("Enter");
  await see.poll(() => started.length).toBe(1);

  // Running: an empty draft shows stop; there is no separate "补充" control.
  const stop = page.getByRole("button", { name: "停止运行", exact: true });
  await see(stop).toBeVisible();
  await see(page.getByRole("button", { name: "补充", exact: true })).toHaveCount(0);
  await composer.fill("顺便看看明天");
  await see(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  await composer.press("Enter");
  // The text joined the running turn (no second run) and shows as the owner's own message.
  await see.poll(() => steered).toEqual(["顺便看看明天"]);
  expect(started).toHaveLength(1);
  await see(page.locator(".room-chat-message.from-user", { hasText: "顺便看看明天" })).toBeVisible();
  await see(page.getByText("补充：")).toHaveCount(0);

  await stop.click();
  await see.poll(() => runs.get("run-1")?.status).toBe("cancelled");
  await see(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
}, 60_000);

it.skipIf(!built)("a running reply keeps one working line below its content and never blanks when it finishes", async (context) => {
  let run: Record<string, unknown> | undefined;
  const events: Array<{ sequence: number; event: Record<string, unknown> }> = [];
  const emit = (event: Record<string, unknown>) => events.push({ sequence: events.length + 1, event: { runId: "run-1", ...event } });
  const note = (method: string, params: Record<string, unknown>) =>
    emit({ type: "native.notification", threadId: "th", notification: { method, params: { threadId: "th", ...params } } });
  const host = (url: URL, init?: RequestInit) => {
    const method = init?.method ?? "GET", path = url.pathname;
    if (path.endsWith("/runs") && method === "POST") {
      const body = JSON.parse(String(init?.body));
      run = { id: "run-1", sessionId: body.sessionId, runtimeId: body.runtimeId, status: "running", answer: "" };
      return Response.json(run);
    }
    if (path.endsWith("/runs/by-request")) return Response.json({ run: null });
    if (path.endsWith("/events")) {
      const after = Number(url.searchParams.get("after") ?? 0);
      return Response.json({ events: events.filter((item) => item.sequence > after), cursor: events.length, hasMore: false, historyTruncated: false });
    }
    if (path.endsWith("/calls")) return Response.json({ calls: [] });
    if (/\/runs\/run-1$/.test(path)) return Response.json(run);
    return Response.json({ error: "fixture_unknown_path" }, { status: 404 });
  };
  const f = await edgeMauFixture(cleanup, { webRoot, host, hostCapabilities: { runIdempotency: true } },
    { ledgerRead: true, ledgerSend: true, ledgerCards: true, ledgerControl: true });
  const me = await (await fetch(f.base + "/_agent-router/v1/web/me", { headers: f.edgeHeaders() })).json() as { limits?: { features?: Record<string, boolean> } };
  if (!me.limits?.features?.send) return context.skip();
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");

  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const page = await (await instance.newContext({ locale: "zh-CN", reducedMotion: "reduce", viewport: { width: 1200, height: 900 },
    extraHTTPHeaders: f.edgeHeaders() })).newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(f.base);
  page.setDefaultTimeout(10_000);
  await page.getByRole("button", { name: "对话", exact: true }).click();
  // The employee is in the header row before any chat exists; a click opens the DM.
  await page.locator(`.mau-chip[data-chat-key="agent:${f.agent.id}"]`).click();
  // Every change to the reply, as (working line position, text) states.
  await page.evaluate(() => {
    const w = window as unknown as { states: string[] }; w.states = [];
    new MutationObserver(() => {
      const reply = [...document.querySelectorAll(".room-chat-message.from-agent")].at(-1);
      if (!reply) return;
      const stack = reply.querySelector(".room-chat-agent-stack"), last = stack?.lastElementChild;
      const state = `${reply.textContent?.includes("正在执行") ? last?.classList.contains("room-chat-thinking-row") ? "working-last" : "working-elsewhere" : "idle"}|${reply.querySelector(".room-chat-bubble")?.textContent ?? ""}|${reply.textContent}`;
      if (w.states.at(-1) !== state) w.states.push(state);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.getByPlaceholder("发送消息…").fill("看看我连了哪些应用");
  await page.getByPlaceholder("发送消息…").press("Enter");
  await see.poll(() => !!run).toBe(true);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1300));
  note("item/started", { item: { type: "agentMessage", id: "m1", phase: "commentary", text: "" } });
  note("item/completed", { item: { type: "agentMessage", id: "m1", phase: "commentary", text: "我先查一下。" } });
  const tool = { type: "dynamicToolCall", id: "exec-1", namespace: null, tool: "connected_apps", arguments: { action: "tools" } };
  emit({ type: "native.tool", callId: "exec-1", tool: "connected_apps", phase: "started", native: { ...tool, status: "inProgress" } });
  await settle();
  // Mid-run with a process row: the working line is still the last thing in the reply, not the process summary.
  const working = page.locator(".room-chat-message.from-agent").last().locator(".room-chat-agent-stack > :last-child");
  await see(working).toHaveClass(/room-chat-thinking-row/);
  await see(working).toHaveText("正在执行");
  emit({ type: "native.tool", callId: "exec-1", tool: "connected_apps", phase: "finished",
    native: { ...tool, status: "completed", contentItems: [{ type: "inputText", text: JSON.stringify({ status: "completed", tools: [{ name: "gmail" }] }) }] } });
  note("item/started", { item: { type: "agentMessage", id: "m2", phase: "final_answer", text: "" } });
  note("item/agentMessage/delta", { itemId: "m2", delta: "你连了 Gmail。" });
  emit({ type: "assistant.delta", text: "你连了 Gmail。", transient: true });
  await settle();
  run!.status = "completed"; run!.answer = "你连了 Gmail。";
  note("item/completed", { item: { type: "agentMessage", id: "m2", phase: "final_answer", text: "你连了 Gmail。" } });
  note("turn/completed", { turn: { id: "t", status: "completed" } });
  const reply = page.locator(".room-chat-message.from-agent").last();
  await see(reply.locator(".room-chat-bubble")).toHaveText("你连了 Gmail。");
  await see(reply.getByText("正在执行")).toHaveCount(0);
  await settle();

  const states = await page.evaluate(() => (window as unknown as { states: string[] }).states);
  // The working line was always the last thing in the reply, with or without process and text.
  expect(states.filter((state) => state.startsWith("working-elsewhere"))).toEqual([]);
  // No separate loading texts, and once the answer showed it never went away.
  expect(states.filter((state) => /等待执行|正在读取执行过程|正在启动/.test(state))).toEqual([]);
  const first = states.findIndex((state) => state.split("|")[1] === "你连了 Gmail。");
  expect(first).toBeGreaterThanOrEqual(0);
  expect(states.slice(first).filter((state) => state.split("|")[1] !== "你连了 Gmail。")).toEqual([]);

  // The tool row: a one-line summary, full input and output in the code block.
  await reply.locator(".og-disclosure-toggle").click();
  const row = reply.locator(".thread-activity-row-toggle", { hasText: "已调用 connected_apps" });
  await see(row.locator(".thread-activity-row-detail")).toHaveText("action: tools");
  await row.click();
  const code = JSON.parse(await reply.locator("pre.thread-activity-row-full-detail").textContent() ?? "{}");
  expect(code).toEqual({ input: { action: "tools" }, output: { status: "completed", tools: [{ name: "gmail" }] } });
  expect(errors).toEqual([]);
}, 60_000);
