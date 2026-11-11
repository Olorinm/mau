import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, expect as see, type WebSocketRoute } from "@playwright/test";
import { edgeMauFixture } from "./fixtures/edge.js";

// Browser acceptance for Router-native groups in the ledger console (agent-router ADR 0005 section 17.7).
// The Router web channel is a Playwright fake implementing the section 8 and 17.1 shapes.
const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));
const built = existsSync(webRoot + "index.html");
if (!built && process.env.MAU_WEB_E2E === "1") throw new Error("web_console_build_required");

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const web = "/_agent-router/v1/web";
const owner = { type: "person", id: "prs_owner", name: "Alice" };

it.skipIf(!built)("creates a Router group, sends resolved mentions, shows addressed state and edits members", async () => {
  const f = await edgeMauFixture(cleanup, { webRoot });
  const writer = { id: "agent-writer", name: "writer" };
  const helper = { id: f.agent.id, name: "helper" };
  const actor = (agent: { id: string; name: string }) => ({ type: "agent", ...agent });
  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const context = await instance.newContext({ locale: "zh-CN", reducedMotion: "reduce", viewport: { width: 1200, height: 900 },
    extraHTTPHeaders: f.edgeHeaders() });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const matrix: string[] = [];
  // The console has no Matrix client: any Matrix request is recorded and never answered.
  await context.route(/\/_matrix\//, (route) => { matrix.push(new URL(route.request().url()).pathname); return route.abort(); });

  // ---- fake Router ledger ----
  const chatId = "room:rm_01", calls: Array<{ method: string; path: string; body?: any }> = [];
  let members = [owner, actor(helper), actor(writer)];
  const events: any[] = [];
  let socket: WebSocketRoute | undefined;
  const summary = () => ({
    chatId, kind: "group", title, agentIds: members.filter((m) => m.type === "agent").map((m) => m.id), readOnly: false,
    lastSeq: events.length, generation: 1, readSeq: events.length, unread: 0, lastEvent: null, activeTurns: 0, pendingCards: 0,
    updatedAt: new Date().toISOString(),
  });
  let title = "", created = false;
  const append = (body: Record<string, unknown>, sender: unknown = { type: "system", id: "router", name: "Router" }) => {
    const event = { chatId, seq: events.length + 1, generation: 1, eventId: "ev_" + (events.length + 1), at: new Date().toISOString(), sender, ...body };
    events.push(event);
    return event;
  };
  const push = (event: string, data: unknown) => socket?.send(JSON.stringify({ type: "event", event, data }));
  await page.route(`**${web}/**`, async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice(web.length);
    const body = request.postData() ? request.postDataJSON() : undefined;
    calls.push({ method: request.method(), path: decodeURIComponent(path), ...(body ? { body } : {}) });
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/me") return json({ person: owner, ownerId: "owner", identities: [], limits: { features: { history: true, send: true, groups: true } } });
    if (path === "/socket-tickets") return json({ ticket: "t1", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    if (path === "/chats") return json({ data: created ? [summary()] : [], next: null });
    if (path === "/groups" && request.method() === "POST") {
      created = true; title = body.title;
      return json({ ...summary(), members }, 201);
    }
    if (path === "/groups/rm_01" && request.method() === "PATCH") {
      title = body.title;
      const event = append({ kind: "member", action: "rename", title });
      setTimeout(() => push("chat.event", event), 50);
      return json(summary());
    }
    if (path === "/groups/rm_01/members" && request.method() === "POST") {
      members = [...members, actor(body.agentId === writer.id ? writer : helper)];
      return json({ members });
    }
    if (path.startsWith("/groups/rm_01/members/") && request.method() === "DELETE") {
      const id = decodeURIComponent(path.split("/").at(-1)!);
      members = members.filter((m) => m.id !== id);
      return json({ members });
    }
    if (path === "/chats/" + encodeURIComponent(chatId)) return json({ ...summary(), members });
    if (path === "/chats/" + encodeURIComponent(chatId) + "/events")
      return json({ chatId, generation: 1, lastSeq: events.length, mode: "page", events, olderCursor: null, newerCursor: null, inflight: [] });
    if (path === "/chats/" + encodeURIComponent(chatId) + "/messages") {
      if (body.mentions.agentIds.some((id: string) => !members.some((m) => m.id === id))) return json({ error: "mention_not_member" }, 422);
      const event = append({ kind: "message", role: "user", text: body.text, mentions: body.mentions, idempotencyKey: body.idempotencyKey, channel: { kind: "web" } }, owner);
      const addressed = members.filter((m) => m.type === "agent").map((m) => ({ agentId: m.id,
        state: body.mentions.all || body.mentions.agentIds.includes(m.id) ? "queued" : "not_addressed" }));
      return json({ status: "accepted", event, addressed });
    }
    if (path.endsWith("/read")) return json({ readSeq: body.seq, unread: 0 });
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
  // The fixture owns one Agent; the second one exists only in this console's agent list.
  await page.route("**/_mau/v1/agents", async (route) => {
    const response = await route.fetch(), data = await response.json();
    const extra = { ...data.data[0], agent: { ...data.data[0].agent, id: writer.id, name: writer.name, matrixId: "@writer:example.test" } };
    return route.fulfill({ response, json: { data: [...data.data, extra] } });
  });

  await page.goto(f.base);
  await page.getByRole("button", { name: "对话", exact: true }).click();

  // "新建群聊" replaces Matrix group creation and reuses the OpenGrove group form. It is the "+" of the 群聊
  // section in the full list of conversations.
  await page.getByRole("button", { name: "全部对话", exact: true }).click();
  const roster = page.getByRole("complementary", { name: "全部对话" });
  await roster.getByRole("button", { name: "新建群聊", exact: true }).click();
  await see(roster).toHaveCount(0);
  const dialog = page.getByRole("dialog", { name: "新建群聊" });
  await dialog.getByRole("textbox").fill("周报小组");
  for (const box of await dialog.getByRole("checkbox").all()) await box.check();
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await see(dialog).toHaveCount(0);
  const create = calls.find((call) => call.path === "/groups")!;
  expect(create.body).toMatchObject({ title: "周报小组", agentIds: [helper.id, writer.id] });
  expect(create.body.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  // The new group is the current conversation: its figure in the header row carries the name.
  const currentChip = page.locator(".mau-chip[aria-selected='true']");
  await see(currentChip).toHaveAttribute("data-chat-key", "chat:" + chatId);
  await see(currentChip).toHaveAttribute("title", "周报小组");
  await see(currentChip.locator("strong")).toHaveText("周报小组");

  // Without a mention the message is only recorded; the hint says so.
  const composer = page.getByPlaceholder("@员工 让他回答，@所有人 让大家都回答…");
  await composer.fill("大家好");
  await see(page.getByText("未 @ 任何员工，消息只记录")).toBeVisible();
  await composer.fill("");
  await composer.pressSequentially("@");
  await see(page.getByRole("option", { name: /所有人/ })).toBeVisible();
  await see(page.getByRole("option", { name: /writer/ })).toBeVisible();
  await page.getByRole("option", { name: /helper/ }).click();
  await see(composer).toHaveValue("@helper ");
  await see(page.getByText("未 @ 任何员工，消息只记录")).toHaveCount(0);
  await composer.pressSequentially("看一下");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await see(page.getByText("已通知：helper")).toBeVisible();
  const sent = calls.find((call) => call.path.endsWith("/messages"))!;
  expect(sent.body).toMatchObject({ text: "@helper 看一下", mentions: { agentIds: [helper.id], all: false } });

  // Several agents stream into the room at once, each under its own name.
  push("chat.stream", { chatId, turnId: "t_h", agentId: helper.id, state: "delta", text: "helper 正在写", afterSeq: events.length });
  push("chat.stream", { chatId, turnId: "t_w", agentId: writer.id, state: "delta", text: "writer 正在写", afterSeq: events.length });
  await see(page.getByText("helper 正在写")).toBeVisible();
  await see(page.getByText("writer 正在写")).toBeVisible();

  // Member panel: remove and add an agent, rename the group.
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "群设置" }).click();
  const panel = page.getByRole("dialog", { name: "群成员" });
  await panel.getByRole("button", { name: "移出 writer" }).click();
  await see(panel.getByRole("button", { name: "移出 writer" })).toHaveCount(0);
  await panel.getByLabel("添加员工").selectOption(writer.id);
  await panel.getByRole("button", { name: "添加", exact: true }).click();
  await see(panel.getByRole("button", { name: "移出 writer" })).toBeVisible();
  await panel.getByLabel("群聊名称").fill("周报");
  await panel.getByRole("button", { name: "保存名称" }).click();
  await see(page.getByText("群聊名称改为“周报”")).toBeVisible();
  expect(calls.filter((call) => call.path.startsWith("/groups/")).map(({ method, path, body }) => [method, path, body])).toEqual([
    ["DELETE", `/groups/rm_01/members/${writer.id}`, undefined],
    ["POST", "/groups/rm_01/members", { agentId: writer.id }],
    ["PATCH", "/groups/rm_01", { title: "周报" }],
  ]);
  await panel.getByRole("button", { name: "关闭", exact: true }).first().click();

  // Matrix group creation is gone and no Matrix room was created.
  await page.getByRole("button", { name: "全部对话", exact: true }).click();
  await see(roster.getByRole("region", { name: "群聊" }).getByRole("button", { name: "新建群聊", exact: true })).toBeVisible();
  await see(page.getByRole("button", { name: "发起群聊" })).toHaveCount(0);
  await see(page.getByRole("menuitem", { name: "发起群聊" })).toHaveCount(0);
  expect(matrix).toEqual([]);
  expect(errors).toEqual([]);
}, 30_000);
