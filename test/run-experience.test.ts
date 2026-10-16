import { afterEach, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { chromium, expect as see } from "@playwright/test";
import { mauFixture, alice } from "./fixtures/mau.js";
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });
const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));

it.skipIf(!existsSync(webRoot + "index.html"))("shows tool events and streamed text, restores approvals on refresh, submits native decisions once, answers questions and stops a run", async () => {
  type Event = { sequence: number; event: Record<string, unknown> };
  type Call = { id: string; runId: string; kind: string; name: string; input: unknown; status: string; deadlineAt: string; result?: unknown };
  let run: { id: string; sessionId: string; runtimeId: string; status: string; answer: string } | undefined;
  const events: Event[] = [], calls: Call[] = [], decisions: unknown[] = [];
  let starts = 0;
  const emit = (event: Record<string, unknown>) => events.push({ sequence: events.length + 1, event: { runId: run!.id, ...event } });
  const f = await mauFixture(cleanup, { webRoot, host: (url, init) => {
    const method = init?.method ?? "GET", path = url.pathname;
    if (path.endsWith("/runs") && method === "POST") {
      starts++; events.length = 0; calls.length = 0;
      const input = JSON.parse(String(init?.body)); run = { id: "run-" + starts, sessionId: input.sessionId, runtimeId: input.runtimeId, status: "running", answer: "" };
      emit({ type: "native.tool", callId: "cmd-1", phase: "started", native: { type: "commandExecution", command: "pwd" } });
      emit({ type: "assistant.delta", text: "第一段" });
      return Response.json(run);
    }
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
  } });
  await f.api(f.path, { profileId: "cloud" }); expect((await f.settled()).state).toBe("ready");
  const runtime = await f.service.runtime(f.agent.id), room = "!run:example.test";
  const members = [alice, f.agent.matrixId].map((id) => ({ type: "m.room.member", state_key: id, content: { membership: "join" } }));
  runtime.connector.store.set("rooms", room, { members: [alice, f.agent.matrixId], encrypted: false });
  const timeline: Array<Record<string, unknown>> = [];
  const event = (sender: string, content: unknown) => ({ event_id: "$" + (timeline.length + 1), sender, type: "m.room.message", content, origin_server_ts: Date.now() + 1 });
  runtime.connector.transport.state = async () => members;
  runtime.connector.transport.send = async (_room, _type, content) => { const item = event(f.agent.matrixId, content); timeline.push(item); return item.event_id; };
  const instance = await chromium.launch({ headless: true }); cleanup.push(() => instance.close());
  const page = await instance.newPage({ viewport: { width: 1200, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
  page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://example.test/_matrix/client/v3/**", async (route) => {
    const url = new URL(route.request().url()), headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (url.pathname.endsWith("/sync")) {
      await new Promise((r) => setTimeout(r, 50));
      return route.fulfill({ headers, json: { next_batch: String(timeline.length), rooms: { join: { [room]: { state: { events: members }, timeline: { events: timeline.slice(Number(url.searchParams.get("since") ?? 0)) } } } } } });
    }
    if (url.pathname.includes("/send/")) {
      const item = event(alice, route.request().postDataJSON()); timeline.push(item);
      runtime.connector.ingest(room, item);
      return route.fulfill({ headers, json: { event_id: item.event_id } });
    }
    return route.fulfill({ headers, json: {} });
  });
  await page.goto(f.base); await page.evaluate(() => localStorage.setItem("mau.session", JSON.stringify({ token: "alice", owner: "@alice:example.test" })));
  await page.reload();
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
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await see(page.locator(".mau-run")).toHaveAttribute("aria-label", "已取消", { timeout: 8000 });
  await see(detailToggle).toHaveAttribute("aria-expanded", "true");
  await see(page.locator(".mau-run")).toContainText("/workspace");
  await page.reload();
  await see(page.locator(".mau-run")).toHaveAttribute("aria-label", "已取消");
  await see(page.getByText("Cancellation requested; waiting for the worker to stop and acknowledge.", { exact: true })).toBeHidden();
  expect(starts).toBe(1); expect(errors).toEqual([]);
}, 60000);
