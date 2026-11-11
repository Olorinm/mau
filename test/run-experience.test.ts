import { afterEach, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { chromium, expect as see, type Page, type WebSocketRoute } from "@playwright/test";
import { edgeMauFixture } from "./fixtures/edge.js";
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });
const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));

const web = "/_agent-router/v1/web";
type FakeTurn = { state: string; runs: Array<{ claimId: string; runId: string | null; phase: string }> };
/**
 * Router's owner ledger (agent-router ADR 0005 section 8) for one DM, answered by Playwright: the chat's history and
 * its turns are scripted by the test, while the runs behind them are read through Router's run routes as usual.
 * The employee list still comes from the real Mau fixture.
 */
async function fakeLedger(page: Page, agentId: string, turnOf: (turnId: string) => FakeTurn | Promise<FakeTurn>) {
  const chatId = "dm:" + agentId, events: any[] = [];
  const owner = { type: "person", id: "prs_owner", name: "Alice" }, agent = { type: "agent", id: agentId, name: "helper" };
  let socket: WebSocketRoute | undefined;
  const append = (body: Record<string, unknown>, sender: unknown) => {
    const event = { chatId, seq: events.length + 1, generation: 1, eventId: "ev_" + (events.length + 1), at: new Date().toISOString(), sender, ...body };
    events.push(event);
    socket?.send(JSON.stringify({ type: "event", event: "chat.event", data: event }));
    return event;
  };
  const summary = () => ({ chatId, kind: "dm", title: "helper", agentIds: [agentId], readOnly: false, lastSeq: events.length, generation: 1,
    readSeq: events.length, unread: 0, lastEvent: null, activeTurns: 0, pendingCards: 0, updatedAt: new Date().toISOString() });
  await page.route(`**${web}/**`, async (route) => {
    const request = route.request(), path = decodeURIComponent(new URL(request.url()).pathname.slice(web.length));
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/me") return json({ person: owner, ownerId: "owner", identities: [], limits: { features: { history: true, send: true } } });
    if (path === "/socket-tickets") return json({ ticket: "t1", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    if (path === "/chats") return json({ data: [summary()], next: null });
    if (path === "/chats/dm" || path === "/chats/" + chatId) return json(summary());
    if (path === "/chats/" + chatId + "/events")
      return json({ chatId, generation: 1, lastSeq: events.length, mode: "page", events, olderCursor: null, newerCursor: null, inflight: [] });
    if (path.startsWith("/chats/" + chatId + "/turns/")) {
      const turnId = path.split("/").at(-1)!;
      const input = events.find((event) => event.kind === "turn" && event.turnId === turnId);
      return json({ turnId, chatId, agentId, admission: "owner", inputEventIds: input?.inputEventIds ?? [], finalEventId: null, cardIds: [], ...await turnOf(turnId) });
    }
    if (path.endsWith("/read")) return json({ readSeq: request.postDataJSON().seq, unread: 0 });
    return json({ error: "unexpected_fixture_request" }, 501);
  });
  await page.routeWebSocket(/\/_agent-router\/v1\/web\/socket/, (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      if (raw === "ping") return ws.send("pong");
      const request = JSON.parse(String(raw));
      ws.send(JSON.stringify({ type: "res", id: request.id, ok: true, result: { chats: (request.params.chats ?? []).map((chat: any) => ({ ...chat, mode: "live", lastSeq: events.length, generation: 1 })), errors: [] } }));
    });
    ws.send(JSON.stringify({ type: "event", event: "hello", data: { socketId: "so_1", epoch: "ep_1", heartbeatMs: 30_000, limits: {} } }));
  });
  return {
    chatId,
    /** The owner's message and the turn it started. */
    ask(turnId: string, text: string, state: string) {
      const question = append({ kind: "message", role: "user", text, channel: { kind: "web" } }, owner);
      append({ kind: "turn", turnId, agentId, state, inputEventIds: [question.eventId] }, { type: "system", id: "router", name: "Router" });
    },
    /** A reply of the employee: inside a turn, or on its own (`turnId` undefined). */
    reply(turnId: string | undefined, text: string, final = true) {
      append({ kind: "message", role: "assistant", text, ...(turnId ? { turnId, ...(final ? { final: true } : {}) } : {}) }, agent);
    },
    /** A turn's state change. */
    turn(turnId: string, state: string) {
      append({ kind: "turn", turnId, agentId, state, inputEventIds: [] }, { type: "system", id: "router", name: "Router" });
    },
  };
}
/** The console opens from the Access session (the page's context carries the edge header); there is no sign-in step. */
const signIn = async (page: Page, base: string) => { await page.goto(base); };

it.skipIf(!existsSync(webRoot + "index.html"))("shows tool events and streamed text, restores approvals on refresh, submits native decisions once, answers questions, stops and retains expanded detail through final reply delivery", async () => {
  type Event = { sequence: number; event: Record<string, unknown> };
  type Call = { id: string; runId: string; kind: string; name: string; input: unknown; status: string; deadlineAt: string; result?: unknown };
  let run: { id: string; sessionId: string; runtimeId: string; status: string; answer: string } | undefined;
  const byRequest = new Map<string, { body: string; run: NonNullable<typeof run> }>();
  const events: Event[] = [], calls: Call[] = [], decisions: unknown[] = [];
  let starts = 0;
  const emit = (event: Record<string, unknown>) => events.push({ sequence: events.length + 1, event: { runId: run!.id, ...event } });
  const f = await edgeMauFixture(cleanup, { webRoot, hostCapabilities: { runIdempotency: true }, host: (url, init) => {
    const method = init?.method ?? "GET", path = url.pathname;
    if (path.endsWith("/runs") && method === "POST") {
      const input = JSON.parse(String(init?.body)); expect(input.requestKey).toEqual(expect.any(String));
      const key = JSON.stringify([input.runtimeId, input.requestKey]), body = JSON.stringify(input), prior = byRequest.get(key);
      if (prior) return prior.body === body ? Response.json(prior.run) : Response.json({ error: "run_request_conflict" }, { status: 409 });
      starts++; events.length = 0; calls.length = 0;
      run = { id: "run-" + starts, sessionId: input.sessionId, runtimeId: input.runtimeId, status: "running", answer: "" };
      byRequest.set(key, { body, run });
      emit({ type: "native.tool", callId: "cmd-1", phase: "started", native: { type: "commandExecution", command: "pwd" } });
      if (starts === 1) emit({ type: "assistant.delta", text: "第一段" });
      return Response.json(run);
    }
    if (path.endsWith("/runs/by-request") && method === "GET") return Response.json({
      run: byRequest.get(JSON.stringify([url.searchParams.get("runtimeId"), url.searchParams.get("requestKey")]))?.run ?? null,
    });
    if (path.endsWith("/events")) {
      const after = Number(url.searchParams.get("after") ?? 0);
      return Response.json({ events: events.filter((item) => item.sequence > after), cursor: events.length, hasMore: false, historyTruncated: false });
    }
    if (path.endsWith("/calls")) return Response.json({ calls });
    if (path.endsWith("/result")) {
      const call = calls.find((call) => path.includes("/" + call.id + "/"));
      if (!call || call.status !== "pending") return Response.json({ error: "call_not_pending" }, { status: 409 });
      const body = JSON.parse(String(init?.body)); call.status = "completed"; call.result = body.result; decisions.push(body.result);
      return Response.json({ status: "accepted" });
    }
    if (path.endsWith("/cancel")) { run!.status = "cancelled"; return Response.json({ cancellationRequested: true }); }
    if (/\/runs\/run-\d+$/.test(path)) return Response.json(run);
    return Response.json({ error: "fixture_unknown_path" }, { status: 404 });
  } }, { ledgerRead: true, ledgerSend: true, ledgerCards: true, ledgerControl: true });
  await f.api(f.path, { profileId: "cloud" }); expect((await f.settled()).state).toBe("ready");
  const instance = await chromium.launch({ headless: true }); cleanup.push(() => instance.close());
  const page = await instance.newPage({ viewport: { width: 1200, height: 900 }, locale: "zh-CN", reducedMotion: "reduce", extraHTTPHeaders: f.edgeHeaders() });
  page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, f.base);
  // The employee is in the header row before any chat exists; a click opens the DM.
  await page.locator(`.mau-chip[data-chat-key="agent:${f.agent.id}"]`).click();
  const composer = page.getByPlaceholder("发送消息…"); await see(composer).toBeVisible();
  await composer.fill("测试执行过程"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await see(page.locator(".mau-run")).toContainText("第一段", { timeout: 12000 });
  const processToggle = page.locator(".og-disclosure--room-run > .og-disclosure-row > .og-disclosure-toggle");
  await page.screenshot({path:"/tmp/mau-candidate-live.png",fullPage:true});
  await see(processToggle).toBeVisible();
  await processToggle.click();
  await see(page.locator(".mau-run")).toContainText("pwd");
  emit({ type: "assistant.delta", text: "，第二段" });
  await see(page.locator(".mau-run")).toContainText("第一段，第二段");
  await see(processToggle).toHaveAttribute("aria-expanded", "true");
  emit({ type: "native.tool", callId: "cmd-1", phase: "finished", native: { type: "commandExecution", command: "pwd", aggregatedOutput: "/workspace", exitCode: 0 } });
  calls.push({ id: "approval", runId: run!.id, kind: "interaction", name: "item/commandExecution/requestApproval", input: { command: "pwd", reason: "Approve fixture command" }, status: "pending", deadlineAt: new Date(Date.now() + 60000).toISOString() });
  await see(page.locator(".mau-run")).toHaveAttribute("aria-label", "等待你的回应");
  await page.reload();
  await see(page.locator(".mau-run")).toContainText("第一段，第二段");
  await page.screenshot({path: "/tmp/mau-run-experience.png", fullPage: true});
  const approve = page.locator(".thread-approval-interaction").getByRole("button", { name: "Allow once", exact: true });
  await see(approve).toBeEnabled(); await approve.click();
  await see(approve).toHaveCount(0); expect(decisions).toEqual([{ decision: "accept" }]); expect(starts).toBe(1);
  calls.push({ id: "deny", runId: run!.id, kind: "interaction", name: "item/commandExecution/requestApproval", input: { command: "denied-command" }, status: "pending", deadlineAt: new Date(Date.now() + 60000).toISOString() });
  const deny = page.locator(".thread-approval-interaction").filter({hasText: "denied-command"}).getByRole("button", { name: "Deny", exact: true }); await see(deny).toBeEnabled(); await deny.click();
  await see(deny).toHaveCount(0); expect(decisions[1]).toEqual({ decision: "decline" });
  calls.push({ id: "question", runId: run!.id, kind: "interaction", name: "item/tool/requestUserInput", input: { questions: [{ id: "destination", question: "选择目录", options: [{ label: "workspace", description: "工作目录" }] }] }, status: "pending", deadlineAt: new Date(Date.now() + 60000).toISOString() });
  const question = page.locator(".thread-question-card"); await see(question).toContainText("选择目录");
  await question.getByText("workspace", { exact: true }).click();
  await see(page.locator(".thread-question-summary")).toBeVisible(); expect(decisions[2]).toEqual({ answers: { destination: { answers: ["workspace"] } } });
  if (await processToggle.getAttribute("aria-expanded") === "false") await processToggle.click();
  const clusterToggle = page.locator(".og-disclosure--exploration > .og-disclosure-row > .og-disclosure-toggle");
  await see(clusterToggle).toBeVisible();
  if (await clusterToggle.getAttribute("aria-expanded") === "false") await clusterToggle.click();
  const detailToggle = page.locator(".thread-activity-row-toggle");
  await see(detailToggle).toBeVisible();
  await detailToggle.click();
  await see(page.locator(".mau-run")).toContainText("/workspace");
  // In a DM the conversation's send button stops the running reply; the run surface has no stop of its own.
  await see(page.locator(".mau-run").getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "停止运行", exact: true }).click();
  await see(page.locator(".mau-run")).toHaveAttribute("aria-label", "已取消", { timeout: 8000 });
  await see(detailToggle).toHaveAttribute("aria-expanded", "true");
  await see(page.locator(".mau-run")).toContainText("/workspace");
  await page.reload();
  await see(page.locator(".mau-run")).toHaveAttribute("aria-label", "已取消");
  // Router's "Cancellation requested…" line is a durable notice of the ledger and stays in the history as a system
  // line (the Matrix console hid that interim message), so its absence is not asserted here.
  expect(starts).toBe(1);
  await composer.fill("自然完成验收"); await page.getByRole("button", {name:"发送消息",exact:true}).click();
  await see(page.locator(".mau-run")).toHaveCount(2);
  const second = page.locator(".mau-run").last();
  await see(second).toHaveAttribute("aria-label","正在执行");
  const expanded = second.locator(".og-disclosure--room-run > .og-disclosure-row > .og-disclosure-toggle");
  await expanded.click(); await see(expanded).toHaveAttribute("aria-expanded","true");
  await second.evaluate(element => { (window as unknown as {auditRun:Element}).auditRun = element; });
  emit({type:"native.tool",callId:"cmd-1",phase:"finished",native:{type:"commandExecution",command:"pwd",aggregatedOutput:"/workspace/completed",exitCode:0}});
  run!.status = "completed"; run!.answer = "自然完成回复";
  await see(second).toHaveAttribute("aria-label","已完成");
  await see(second.locator("xpath=ancestor::article")).toHaveAttribute("tabindex","0",{timeout:12000});
  await see(expanded).toHaveAttribute("aria-expanded","true");
  expect(await second.evaluate(element => element === (window as unknown as {auditRun:Element}).auditRun)).toBe(true);
  expect(starts).toBe(2); expect(errors).toEqual([]);
}, 60000);

it.skipIf(!existsSync(webRoot + "index.html"))("retains delivered history while a sleeping Host is unavailable, without polling or flashing loading states", async () => {
  const f = await edgeMauFixture(cleanup, { webRoot });
  await f.api(f.path, { profileId: "cloud" });
  await f.settled();
  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const page = await instance.newPage({ viewport: { width: 1200, height: 900 }, locale: "zh-CN", extraHTTPHeaders: f.edgeHeaders() });
  let reads = 0;
  const ledger = await fakeLedger(page, f.agent.id, () => ({ state: "completed", runs: [{claimId: "old-claim", runId: "old-run", phase: "finished"}] }));
  ledger.ask("old-turn", "历史问题", "running");
  ledger.reply("old-turn", "已经交付的历史回复");
  ledger.turn("old-turn", "completed");
  await page.route("**/communication/runs/**", route => { reads++; return route.fulfill({status: 409, json: {error: "environment_not_ready"}}); });
  await signIn(page, f.base);
  const surface = page.locator(".mau-run");
  await see(surface).toContainText("已经交付的历史回复");
  await see(surface).toHaveAttribute("aria-label", "已完成");
  // History is read once (Router serves finished runs from its copy); a sleeping Host shows the
  // same collapsed process row as any run, with no error and no polling.
  const toggle = surface.getByRole("button", {name: "执行过程"});
  await see(toggle).toBeVisible();
  await see(surface.getByRole("alert")).toHaveCount(0);
  const initial = reads;
  expect(initial).toBeGreaterThan(0);
  await page.waitForTimeout(3500);
  expect(reads).toBe(initial);
  await toggle.click();
  await see.poll(() => reads).toBeGreaterThan(initial);
  await see(surface).toContainText("已经交付的历史回复");
  const afterWake = reads;
  await page.waitForTimeout(3500);
  expect(reads).toBe(afterWake);
  await see(surface).not.toContainText("正在读取执行过程");
  await page.screenshot({path: "/tmp/mau-sleeping-history.png", fullPage: true});
}, 20000);

it.skipIf(!existsSync(webRoot + "index.html"))("shows a reply streamed during a running task once, and keeps later unrelated replies", async () => {
  const f = await edgeMauFixture(cleanup, { webRoot });
  await f.api(f.path, { profileId: "cloud" });
  await f.settled();
  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const page = await instance.newPage({ viewport: { width: 1200, height: 900 }, locale: "zh-CN", extraHTTPHeaders: f.edgeHeaders() });
  let status = "running";
  const ledger = await fakeLedger(page, f.agent.id, () => ({ state: status, runs: [{claimId: "live-claim", runId: "live-run", phase: status === "running" ? "running" : "finished"}] }));
  ledger.ask("live-turn", "流式问题", "running");
  // The reply is stored while its turn still runs.
  ledger.reply("live-turn", "流式回复的第一段", false);
  await page.route("**/communication/runs/**", route => route.fulfill({status: 409, json: {error: "environment_not_ready"}}));
  await signIn(page, f.base);
  const stream = page.locator(".room-chat-stream");
  await see(page.locator(".mau-run")).toContainText("流式回复的第一段");
  await page.waitForTimeout(3500);
  await see(stream.getByText("流式回复的第一段", {exact: true})).toHaveCount(1);
  // Once finished, the streamed reply belongs to the turn; a later reply outside the turn stays visible.
  status = "completed";
  ledger.turn("live-turn", "completed");
  ledger.reply(undefined, "子 Agent 稍后的汇报");
  await page.reload();
  await see(stream.getByText("子 Agent 稍后的汇报", {exact: true})).toHaveCount(1);
  await see(stream.getByText("流式回复的第一段", {exact: true})).toHaveCount(1);
  await see(page.locator(".mau-run")).toContainText("流式回复的第一段");
  await see(page.locator(".mau-run")).not.toContainText("子 Agent 稍后的汇报");
}, 30000);

it.skipIf(!existsSync(webRoot + "index.html"))("paints finished history once: no plain-message flash, no loading state, all pages before display, no re-read on return", async () => {
  const f = await edgeMauFixture(cleanup, { webRoot });
  await f.api(f.path, { profileId: "cloud" });
  await f.settled();
  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const page = await instance.newPage({ viewport: { width: 1200, height: 900 }, locale: "zh-CN", extraHTTPHeaders: f.edgeHeaders() });
  const runId = "paged-run";
  let reads = 0;
  // Record anything a user would see flash by while the conversation assembles.
  await page.addInitScript(() => {
    // The ledger console shows the delivered reply as text until its turn is read and then inside the run surface
    // (the Matrix console withheld it until then), so "never outside a run surface" is not asserted; the reply must
    // never be on screen twice.
    const seen = { doubled: false, loading: false, summaries: [] as string[] };
    (window as unknown as { seen: typeof seen }).seen = seen;
    new MutationObserver(() => {
      let shown = 0;
      for (const element of document.querySelectorAll(".room-chat-stream *")) {
        if (element.children.length || !element.textContent?.includes("分页的历史回复")) continue;
        shown++;
      }
      if (shown > 1) seen.doubled = true;
      for (const run of document.querySelectorAll(".mau-run")) {
        if (run.textContent?.includes("正在读取执行过程")) seen.loading = true;
        const summary = run.querySelector(".og-disclosure--room-run > .og-disclosure-row")?.textContent ?? "";
        if (summary && !seen.summaries.includes(summary)) seen.summaries.push(summary);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const ledger = await fakeLedger(page, f.agent.id, async () => { await new Promise(r => setTimeout(r, 800));
    return { state: "completed", runs: [{claimId: "paged-claim", runId, phase: "finished"}] }; });
  ledger.ask("paged-turn", "分页问题", "running");
  ledger.reply("paged-turn", "分页的历史回复");
  ledger.turn("paged-turn", "completed");
  const tool = (callId: string, command: string, output: string) => ({ runId, type: "native.tool", callId, phase: "finished",
    native: { type: "commandExecution", command, aggregatedOutput: output, exitCode: 0 } });
  await page.route("**/communication/runs/**", async route => {
    reads++;
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith("/events")) return route.fulfill({ json: { claimId: "paged-claim", runId,
      run: { id: runId, sessionId: "s", runtimeId: "r", status: "completed", answer: "分页的历史回复" }, calls: [] } });
    if (url.searchParams.get("after") === "0")
      return route.fulfill({ json: { events: [{ sequence: 1, event: tool("one", "echo 第一页", "第一页") }], cursor: 1, hasMore: true, historyTruncated: false } });
    await new Promise(r => setTimeout(r, 600));
    return route.fulfill({ json: { events: [{ sequence: 2, event: tool("two", "echo 第二页", "第二页") }], cursor: 2, hasMore: false, historyTruncated: false } });
  });
  await signIn(page, f.base);
  const surface = page.locator(".mau-run");
  await see(surface).toContainText("分页的历史回复");
  await see(surface).toHaveAttribute("aria-label", "已完成");
  await see.poll(() => reads).toBe(3);
  await see(surface).toContainText("已运行 2 条命令");
  // The collapsed process row only ever reads as a placeholder or the complete summary.
  expect(await page.evaluate(() => (window as unknown as { seen: unknown }).seen)).toEqual({ doubled: false, loading: false, summaries: ["执行过程", "已运行 2 条命令"] });
  // Leaving and returning reuses the finished run instead of reading it again.
  await page.getByRole("button", { name: "App 商店", exact: true }).click();
  await see(surface).toHaveCount(0);
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await see(surface).toContainText("分页的历史回复");
  await page.waitForTimeout(1500);
  expect(reads).toBe(3);
}, 30000);

it.skipIf(!existsSync(webRoot + "index.html"))("notices only lost steps, not shortened values, and shows reasoning from completed items", async () => {
  const f = await edgeMauFixture(cleanup, { webRoot });
  await f.api(f.path, { profileId: "cloud" });
  await f.settled();
  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const page = await instance.newPage({ viewport: { width: 1200, height: 900 }, locale: "zh-CN", extraHTTPHeaders: f.edgeHeaders() });
  const ledger = await fakeLedger(page, f.agent.id, (turnId) => ({ state: "completed", runs: [{claimId: turnId + "-claim", runId: turnId + "-run", phase: "finished"}] }));
  for (const [turnId, question, reply] of [["clipped", "问题一", "截断的回复"], ["lost", "问题二", "丢失的回复"]] as const) {
    ledger.ask(turnId, question, "running");
    ledger.reply(turnId, reply);
    ledger.turn(turnId, "completed");
  }
  await page.route("**/communication/runs/**", route => {
    const url = new URL(route.request().url()), claim = decodeURIComponent(url.pathname.split("/runs/")[1]!.split("/")[0]!), runId = claim.replace("-claim", "-run");
    if (!url.pathname.endsWith("/events")) return route.fulfill({ json: { claimId: claim, runId,
      run: { id: runId, sessionId: "s", runtimeId: "r", status: "completed", answer: claim === "clipped-claim" ? "截断的回复" : "丢失的回复" }, calls: [] } });
    const reasoning = { runId, type: "native.notification", notification: { method: "item/completed", params: { threadId: "t", item: { id: "r", type: "reasoning", summary: ["先查看目录"], content: [] } } } };
    return route.fulfill({ json: { events: [{ sequence: 1, event: reasoning }], cursor: 1, hasMore: false, liveGap: false,
      historyTruncated: claim === "lost-claim", contentTruncated: claim === "clipped-claim" } });
  });
  await signIn(page, f.base);
  const [clipped, lost] = [page.locator('.mau-run[data-run-id="clipped-claim"]'), page.locator('.mau-run[data-run-id="lost-claim"]')];
  await see(clipped).toContainText("截断的回复");
  await see(clipped.locator(".mau-muted")).toHaveCount(0);
  await see(lost).toContainText("部分执行过程未能保留。");
  await clipped.locator(".og-disclosure--room-run > .og-disclosure-row > .og-disclosure-toggle").click();
  await see(clipped).toContainText("先查看目录");
}, 30000);

it.skipIf(!existsSync(webRoot + "index.html"))("an open conversation shows the complete answer once a live run finishes and Router serves its archive", async () => {
  const f = await edgeMauFixture(cleanup, { webRoot });
  await f.api(f.path, { profileId: "cloud" });
  await f.settled();
  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const page = await instance.newPage({ viewport: { width: 1200, height: 900 }, locale: "zh-CN", extraHTTPHeaders: f.edgeHeaders() });
  const runId = "live-run";
  let finished = false;
  const note = (method: string, params: Record<string, unknown>) => ({ runId, type: "native.notification", notification: { method, params: { threadId: "t", ...params } } });
  const item = { id: "answer", type: "agentMessage", phase: "final_answer" };
  // While running, the Host numbers events in its own sequence, fragments included.
  const live = [note("item/started", { item }), ...["第一段", "，第二段"].map((delta) => note("item/agentMessage/delta", { itemId: "answer", delta }))]
    .map((event, index) => ({ sequence: 101 + index, event }));
  // Once finished, Router serves its archive: completed items only, numbered from 1.
  const archive = [note("item/started", { item }), note("item/completed", { item: { ...item, text: "第一段，第二段，完整的最终回答。" } })]
    .map((event, index) => ({ sequence: index + 1, event }));
  const ledger = await fakeLedger(page, f.agent.id, () => ({ state: finished ? "completed" : "running",
    runs: [{claimId: "live-claim", runId, phase: finished ? "finished" : "running"}] }));
  ledger.ask("live-turn", "直播问题", "running");
  await page.route("**/communication/runs/**", route => {
    const url = new URL(route.request().url()), after = Number(url.searchParams.get("after") ?? 0);
    if (!url.pathname.endsWith("/events")) return route.fulfill({ json: { claimId: "live-claim", runId, calls: [],
      run: { id: runId, sessionId: "s", runtimeId: "r", status: finished ? "completed" : "running", answer: finished ? "第一段，第二段，完整的最终回答。" : "" } } });
    const events = (finished ? archive : live).filter((entry) => entry.sequence > after);
    return route.fulfill({ json: { events, cursor: events.at(-1)?.sequence ?? after, hasMore: false, historyTruncated: false, liveGap: false } });
  });
  await signIn(page, f.base);
  const surface = page.locator(".mau-run");
  await see(surface).toHaveAttribute("aria-label", "正在执行");
  await see(surface).toContainText("第一段，第二段");
  // The run ends: Router stores the final reply and the turn's end, and serves the run's archive.
  finished = true;
  ledger.reply("live-turn", "第一段，第二段，完整的最终回答。");
  ledger.turn("live-turn", "completed");
  await see(surface).toHaveAttribute("aria-label", "已完成", { timeout: 10000 });
  await see(surface).toContainText("第一段，第二段，完整的最终回答。", { timeout: 5000 });
  await see(surface).toHaveCount(1);
}, 30000);
