import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, expect as see, type Page } from "@playwright/test";
import { mauFixture } from "./fixtures/mau.js";

// Browser acceptance for the built console (`npm run build:web`). CI sets MAU_WEB_E2E=1 so a missing build fails.
const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));
const built = existsSync(webRoot + "index.html");
if (!built && process.env.MAU_WEB_E2E === "1")
  throw new Error("web_console_build_required");

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});

type Fixture = Awaited<ReturnType<typeof mauFixture>>;
/** The console opened from the Access session: Cloudflare adds the JWT to every request, the console sends no token. */
async function browser(f: Fixture, claims: Record<string, unknown> = {}) {
  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const context = await instance.newContext({
    locale: "zh-CN",
    reducedMotion: "reduce",
    viewport: { width: 1200, height: 900 },
    extraHTTPHeaders: f.edgeHeaders(claims),
  });
  const matrix: string[] = [], authorization: string[] = [];
  // The console has no Matrix client: any Matrix request is recorded and never answered.
  await context.route(/\/_matrix\//, (route) => {
    matrix.push(new URL(route.request().url()).pathname);
    return route.abort();
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const value = request.headers()["authorization"];
    if (value) authorization.push(value);
  });
  await page.goto(f.base);
  return { page, context, matrix, authorization, errors };
}

// Conversations are served by Router's owner ledger; without these flags the console has no conversation page.
/** An employee's figure in the header row of the conversation page. */
const agentChip = (page: Page, agentId: string) =>
  page.locator(`.mau-chip[data-chat-key="agent:${agentId}"]`);
/** The employee profile in the people panel (the former contacts detail); the current employee's figure opens it. */
const profileCard = (page: Page) =>
  page.getByRole("complementary", { name: "员工资料" });
/** The profile's sections are icon tabs: 状态, 消息渠道, 能力 and 配置. */
const profileTab = (page: Page, name: string) =>
  profileCard(page).getByRole("group", { name: "员工资料分类" }).getByRole("button", { name, exact: true }).click();
/** The environment state shown on the 状态 tab. */
const profileState = (page: Page) => profileCard(page).locator(".agent-status-line").first();

it.skipIf(!built)(
  "opens from the Access session, provisions an agent, controls its environment, connects a channel and signs out",
  async () => {
    // What the employee's kernel reports and its runtime owner allows callers to select.
    const host = (url: URL) => url.pathname.endsWith("/runtimes/discover") ? Response.json({ id: "personal", kernel: "codex", model: "large",
      allowedSettings: { model: { values: ["large", "small"] }, effort: { values: ["low", "high"] } },
      native: { models: { data: [
        { model: "large", displayName: "Large", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
        { model: "small", displayName: "Small", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] } } })
      : Response.json({ error: "fixture_unknown_path" }, { status: 404 });
    const f = await mauFixture(cleanup, { webRoot, host });
    const home = await fetch(f.base + "/");
    expect(home.headers.get("content-security-policy")).toContain("connect-src 'self';");
    for (const path of ["/health/live", "/HEALTH/live/"]) {
      const health = await fetch(f.base + path);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        status: "ok",
        component: "agent-service",
      });
    }
    const unknownHealth = await fetch(f.base + "/health/missing");
    expect(unknownHealth.status).toBe(404);
    expect(await unknownHealth.json()).toEqual({ error: "not_found" });
    expect(
      (
        await fetch(f.base + "/_mau/v1/missing", {
          headers: f.edgeHeaders(),
        })
      ).status,
    ).toBe(404);
    const { page, matrix, authorization, errors } = await browser(f);

    // No sign-in step: the account is the Access identity.
    await see(page.getByText("alice@example.test").first()).toBeVisible();
    await see(page.getByLabel("密码")).toHaveCount(0);
    await page.getByRole("button", { name: "新建应用", exact: true }).click();
    const createApp = page.getByRole("dialog", {
      name: "新建应用",
      exact: true,
    });
    await see(createApp).toContainText("尚未接入");
    await createApp
      .getByRole("textbox", { name: "App 名称", exact: true })
      .fill("不可提交的草稿");
    await see(
      createApp.getByRole("button", { name: "创建并打开", exact: true }),
    ).toBeDisabled();
    await createApp.getByRole("button", { name: "取消", exact: true }).click();
    await see(createApp).toBeHidden();
    await see(
      page.getByRole("button", { name: "新建应用", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "新建应用", exact: true }).click();
    await see(
      createApp.getByRole("textbox", { name: "App 名称", exact: true }),
    ).toHaveValue("");
    await createApp.getByRole("button", { name: "取消", exact: true }).click();
    // There is no contacts page: the fixture's pre-created "helper" (without an environment) is a figure in the
    // header row; a click opens the conversation, a second click on the current one its profile card.
    for (const name of ["通讯录", "文件"])
      await see(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    const helper = agentChip(page, f.agent.id);
    await see(helper).toHaveAttribute("title", "helper");
    await see(helper.locator(".agent-pixel-avatar")).toBeVisible();
    await helper.click();
    await see(helper).toHaveAttribute("aria-selected", "true");
    await helper.click();
    const profile = profileCard(page);
    await see(profile.getByRole("heading", { name: "helper" })).toBeVisible();
    await see(profileState(page)).toContainText(
      "未配置环境",
    );

    // A new employee is created from the "+" of the 员工 section in the full list of conversations.
    await page.getByRole("button", { name: "全部对话", exact: true }).click();
    await page
      .getByRole("complementary", { name: "全部对话" })
      .getByRole("button", { name: "新建员工", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "新建员工" });
    await dialog.getByLabel("名称").fill("Writer");
    await see(dialog.getByRole("button", { name: "创建" })).toBeDisabled();
    await dialog.getByLabel("名称").fill("writer");
    await dialog.getByRole("tab", { name: "运行环境" }).click();
    await see(dialog.getByRole("button", { name: /Cloud/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await dialog.getByRole("button", { name: "创建" }).click();
    // The new employee's conversation opens; its figure opens its profile.
    const writer = page.locator(".mau-chip[aria-selected='true']");
    await see(writer).toHaveAttribute("title", "writer");
    expect(await writer.getAttribute("data-chat-key")).toMatch(/^agent:.+/);
    await writer.click();
    await see(profile.getByRole("heading", { name: "writer" })).toBeVisible();
    await see(profileState(page)).toContainText(
      "可用",
      { timeout: 10_000 },
    );

    await page.getByRole("button", { name: "暂停" }).click();
    await see(profileState(page)).toContainText(
      "已暂停",
      { timeout: 10_000 },
    );
    await see(page.getByText("已手动暂停")).toBeVisible();
    await page.getByRole("button", { name: "恢复" }).click();
    await see(profileState(page)).toContainText(
      "可用",
      { timeout: 10_000 },
    );

    await profileTab(page, "消息渠道");
    await page
      .getByRole("button", { name: "连接渠道", exact: true })
      .first()
      .click();
    const connect = page.getByRole("dialog", { name: "连接渠道" });
    await see(connect.getByRole("button", { name: /Matrix/ })).toHaveCount(0);
    for (const name of ["飞书", "微信", "Telegram"])
      await see(connect.getByRole("button", { name, exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await see(page.getByRole("dialog")).toHaveCount(0);
    await see(profile.getByText("Matrix", { exact: true })).toHaveCount(0);

    await profileTab(page, "状态");
    await page.getByRole("button", { name: "运行自检" }).click();
    await see(page.getByRole("button", { name: "运行自检" })).toBeEnabled();
    // Router reports the Host check in its own words; the console shows it with a localized status.
    const hostCheck = page.locator(".agent-list-row", {
      hasText: "HTTP service and runtime exist",
    });
    await see(hostCheck).toContainText("通过");

    await profileTab(page, "配置");
    // Model and effort are chosen from what the kernel reports; an effort the new model lacks returns to its default.
    const choose = async (name: string, option: string) => {
      await profile.getByRole("combobox", { name, exact: true }).click();
      await page.getByRole("option", { name: option, exact: true }).click();
    };
    const employees = (await (await fetch(f.base + "/_mau/v1/agents", { headers: f.edgeHeaders() })).json()).data as Array<{ agent: { id: string; name: string } }>;
    const writerId = employees.find((item) => item.agent.name === "writer")!.agent.id;
    const saved = async () => (await (await fetch(`${f.base}/_mau/v1/agents/${writerId}/model-settings`, { headers: f.edgeHeaders() })).json()).selection;
    await see(profile.getByRole("combobox", { name: "模型", exact: true })).toContainText("默认 · Large");
    await choose("思考强度", "高");
    await see(profile.getByRole("combobox", { name: "思考强度", exact: true })).toContainText("高");
    expect(await saved()).toEqual({ effort: "high" });
    await choose("模型", "Small");
    await see(profile.getByRole("combobox", { name: "模型", exact: true })).toContainText("Small");
    await see(profile.getByRole("combobox", { name: "思考强度", exact: true })).toContainText("默认");
    expect(await saved()).toEqual({ model: "small" });
    await page.getByRole("button", { name: "销毁环境" }).click();
    const destroy = page.getByRole("dialog", {
      name: "销毁 writer 的运行环境？",
    });
    await see(destroy).toContainText("无法恢复");
    await destroy.getByRole("button", { name: "销毁环境" }).click();
    await profileTab(page, "状态");
    await see(profileState(page)).toContainText(
      "已销毁",
      { timeout: 10_000 },
    );
    expect(f.cloud.size).toBe(0);

    await page.getByRole("button", { name: "账号", exact: true }).click();
    await page.getByRole("menuitem", { name: "English" }).click();
    await see(
      page.getByRole("button", { name: "Conversations", exact: true }),
    ).toBeVisible();
    await see(
      page.getByRole("button", { name: "Contacts", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Account", exact: true }).click();
    // Sign-out ends the Access session: the console navigates to the logout URL `/info` names, and nowhere else.
    await page.route("**/cdn-cgi/access/logout", (route) =>
      route.fulfill({ contentType: "text/html", body: "<title>signed out</title>" }),
    );
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL(f.base + "/cdn-cgi/access/logout");
    await see(page).toHaveTitle("signed out");
    expect(matrix).toEqual([]);
    expect(authorization).toEqual([]);
    expect(errors).toEqual([]);
  },
  60_000,
);

it.skipIf(!built).each(["server", "network", "rate-limit"])(
  "channel setup recovers from a temporary %s failure",
  async (failure) => {
    const f = await mauFixture(cleanup, { webRoot });
    const { page, errors } = await browser(f);
    const job = {
      id: "retry-job",
      kind: "weixin",
      state: "waiting",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      url: "https://example.test/pair",
    };
    await page.route("**/connection-jobs", (route) =>
      route.fulfill({ json: { data: [job] } }),
    );
    let recovered = false,
      reads = 0;
    await page.route("**/connection-jobs/retry-job", (route) => {
      reads++;
      if (recovered) return route.fulfill({ json: { ...job, state: "ready" } });
      if (failure === "network") return route.abort("failed");
      return route.fulfill({
        status: failure === "rate-limit" ? 429 : 503,
        json: { error: "request_failed" },
      });
    });
    await page.goto(f.base + "?agent=" + encodeURIComponent(f.agent.id));
    // `?agent=` opens the conversation with that employee; its channels are in the profile card.
    await see(agentChip(page, f.agent.id)).toHaveAttribute("aria-selected", "true");
    await agentChip(page, f.agent.id).click();
    await profileTab(page, "消息渠道");
    await profileCard(page)
      .locator(".agent-list-row", { hasText: "微信" })
      .getByRole("button")
      .click();
    const dialog = page.getByRole("dialog");
    await see(dialog.getByRole("alert")).toBeVisible();
    await see(dialog.getByRole("button", { name: "重试" })).toBeEnabled();
    const attempts = reads;
    recovered = true;
    await see(dialog).toHaveCount(0, { timeout: 10_000 });
    expect(reads).toBeGreaterThan(attempts);
    await see(page.getByRole("region", { name: "通知" })).toContainText("微信");
    expect(errors).toEqual([]);
  },
  30_000,
);

it.skipIf(!built)(
  "the profile lists the employee's documents: instructions are read beside the conversation and memory is edited there as one document",
  async () => {
    const f = await mauFixture(cleanup, { webRoot });
    await f.api(f.path, { profileId: "cloud" }); expect((await f.settled()).state).toBe("ready");
    const memory = `/agents/${f.agent.id}/memory`;
    await f.api(memory, { action: "add", target: "user", content: "Prefers short answers." });
    // Entries a Markdown editor writes back in its own way; they have to stay four entries, in order.
    const tricky = ["Naming: use snake_case_names; 2*3 = 6; path C:\\tmp\\a_b", "Checklist:\n- first item\n- second item\n1. numbered",
      "中文条目：先说结论，**重点**加粗。# 不是标题", "<b>html</b> & [link](https://example.test/a_b) `code`"];
    for (const content of tricky) await f.api(memory, { action: "add", target: "memory", content });
    const { page, errors } = await browser(f);
    await page.goto(f.base + "?agent=" + encodeURIComponent(f.agent.id));
    await see(agentChip(page, f.agent.id)).toHaveAttribute("aria-selected", "true");
    await agentChip(page, f.agent.id).click();
    await profileTab(page, "文档");
    const profile = profileCard(page);
    await see(profile.locator(".agent-list-row", { hasText: "USER.md" })).toContainText("22 / 1375");
    // The instructions open as a card beside the conversation, at its level, and cannot be changed.
    await profile.getByRole("button", { name: "AGENTS.md", exact: true }).click();
    const document = page.getByRole("complementary", { name: "文档" });
    await see(document).toContainText("Work carefully.");
    await see(document.getByRole("button", { name: "保存" })).toHaveCount(0);
    const [chat, card] = await page.evaluate(() => [".room-main-panel", ".mau-side-document"].map((q) => document.querySelector(q)!.getBoundingClientRect()).map((r) => [r.left, r.top, r.right, r.bottom]));
    expect(card![0]!).toBeGreaterThan(chat![2]!); expect(Math.abs(card![1]! - chat![1]!)).toBeLessThan(1); expect(Math.abs(card![3]! - chat![3]!)).toBeLessThan(1);
    // The people panel stays open while a document is used, so another one can be opened from it.
    await see(profile).toBeVisible();
    await profile.getByRole("button", { name: "MEMORY.md", exact: true }).click();
    // The file is one document in the Markdown editor, with a divider between its entries.
    const editor = document.locator(".ProseMirror"), save = document.getByRole("button", { name: "保存" });
    await see(editor.locator("hr")).toHaveCount(3);
    await see(editor.locator("li")).toHaveCount(3);
    await see(save).toBeDisabled();
    await editor.getByText("先说结论").click(); await page.keyboard.press("End"); await page.keyboard.type(" Added.");
    await save.click();
    await see(page.getByRole("region", { name: "通知" })).toContainText("已保存");
    await see(save).toBeDisabled();
    const entries = async (target: string) => (await f.api(memory)).data.files.find((file: { target: string }) => file.target === target).entries as string[];
    const saved = await entries("memory");
    expect(saved).toHaveLength(4);
    expect(saved[0]).toContain("snake_case_names"); expect(saved[1]).toContain("second item"); expect(saved[1]).toContain("1. numbered");
    expect(saved[2]).toBe(tricky[2] + " Added."); expect(saved[3]).toBe(tricky[3]);
    // Saving again what the editor wrote changes nothing more.
    await see(editor.locator("hr")).toHaveCount(3);
    // A divider typed at the end starts a new entry.
    await editor.click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight");
    // The editor takes a moment to settle its cursor after a selection; a key pressed before that is lost.
    await page.waitForTimeout(300); await page.keyboard.press("Enter"); await see(editor.locator("p").last()).toBeEmpty();
    await page.keyboard.type("---"); await see(editor.locator("hr")).toHaveCount(4);
    await page.keyboard.press("Enter"); await page.keyboard.type("Remember the release checklist.");
    await save.click();
    await see(save).toBeDisabled();
    expect(await entries("memory")).toEqual([...saved, "Remember the release checklist."]);
    // Deleting an entry's text removes the entry; the divider left behind separates nothing.
    await editor.getByText("Remember the release checklist.").click({ clickCount: 3 }); await page.keyboard.press("Backspace");
    await see(editor).not.toContainText("release checklist");
    await save.click();
    await see(save).toBeDisabled();
    expect(await entries("memory")).toEqual(saved);
    await see(editor.locator("hr")).toHaveCount(3);
    await see(profile.locator(".agent-list-row", { hasText: "USER.md" })).toContainText("22 / 1375");
    await document.getByRole("button", { name: "关闭", exact: true }).click();
    await see(document).toHaveCount(0);
    expect(errors).toEqual([]);
  },
  30_000,
);

it.skipIf(!built)(
  "an unknown channel setup job stops polling and asks to restart",
  async () => {
    const f = await mauFixture(cleanup, { webRoot });
    const { page, errors } = await browser(f);
    const job = {
      id: "expired-job",
      kind: "weixin",
      state: "waiting",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    await page.route("**/connection-jobs", (route) =>
      route.fulfill({ json: { data: [job] } }),
    );
    let reads = 0;
    await page.route("**/connection-jobs/expired-job", (route) => {
      reads++;
      return route.fulfill({
        status: 404,
        json: { error: "setup_job_not_found" },
      });
    });
    await page.goto(f.base + "?agent=" + encodeURIComponent(f.agent.id));
    // `?agent=` opens the conversation with that employee; its channels are in the profile card.
    await see(agentChip(page, f.agent.id)).toHaveAttribute("aria-selected", "true");
    await agentChip(page, f.agent.id).click();
    await profileTab(page, "消息渠道");
    await profileCard(page)
      .locator(".agent-list-row", { hasText: "微信" })
      .getByRole("button")
      .click();
    await see(page.getByRole("dialog").getByRole("alert")).toContainText(
      "过期",
    );
    // More than one polling interval: a missing job must not keep requesting forever.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(reads).toBe(1);
    expect(errors).toEqual([]);
  },
  30_000,
);

it.skipIf(!built)(
  "recovers a failed Feishu app with its original ID and polls binding",
  async () => {
    const f = await mauFixture(cleanup, { webRoot });
    const { page, errors } = await browser(f);
    const failed = {
      id: "feishu-failed",
      kind: "feishu",
      state: "failed",
      error: "feishu_creation_outcome_unknown",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      recovery: {
        action: "authorize_existing_app",
        appId: "cli_existing",
        domain: "lark",
      },
    };
    await page.route("**/connection-jobs", (route) =>
      route.fulfill({ json: { data: [failed] } }),
    );
    await page.route("**/connection-jobs/feishu-failed", (route) =>
      route.fulfill({ json: failed }),
    );
    let requested: unknown;
    await page.route("**/connections", (route) => {
      requested = route.request().postDataJSON();
      return route.fulfill({
        status: 202,
        json: {
          id: "recovered",
          kind: "feishu",
          state: "binding",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    });
    await page.route("**/connection-jobs/recovered", (route) =>
      route.fulfill({
        json: {
          id: "recovered",
          kind: "feishu",
          state: "ready",
          expiresAt: new Date().toISOString(),
        },
      }),
    );
    await page.goto(f.base + "?agent=" + encodeURIComponent(f.agent.id));
    // `?agent=` opens the conversation with that employee; its channels are in the profile card.
    await see(agentChip(page, f.agent.id)).toHaveAttribute("aria-selected", "true");
    await agentChip(page, f.agent.id).click();
    await profileTab(page, "消息渠道");
    await profileCard(page)
      .locator(".agent-list-row", { hasText: "飞书" })
      .getByRole("button")
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "恢复连接" }).click();
    await see(dialog.getByLabel("已有应用 App ID")).toHaveValue("cli_existing");
    await see(
      dialog.getByRole("radio", { name: "Lark（国际）" }),
    ).toBeChecked();
    await dialog.getByLabel("已有应用 App ID").fill("");
    await see(dialog.getByRole("button", { name: "开始连接" })).toBeDisabled();
    await dialog.getByLabel("已有应用 App ID").fill("cli_existing");
    await dialog.getByRole("button", { name: "开始连接" }).click();
    await see(dialog).toHaveCount(0, { timeout: 10_000 });
    expect(requested).toEqual({
      kind: "feishu",
      appId: "cli_existing",
      domain: "lark",
    });
    expect(errors).toEqual([]);
  },
  30_000,
);

it.skipIf(!built)(
  "composes generic pages with Mau-owned messages and never calls a native kernel or Bridge",
  async () => {
    // The employee answers through a fixture Host behind Router; the browser only ever talks to Mau and Router.
    const runs = new Map<string, Record<string, unknown>>();
    const host = (url: URL, init?: RequestInit) => {
      const method = init?.method ?? "GET", path = url.pathname;
      if (path.endsWith("/runs") && method === "POST") {
        const body = JSON.parse(String(init?.body)), id = `run-${runs.size + 1}`;
        const run = { id, sessionId: body.sessionId, runtimeId: body.runtimeId, status: "completed", answer: "Reply received through account messaging" };
        runs.set(id, run);
        return Response.json(run);
      }
      if (path.endsWith("/events")) return Response.json({ events: [], cursor: 0, hasMore: false, historyTruncated: false });
      if (path.endsWith("/calls")) return Response.json({ calls: [] });
      const run = /\/runs\/(run-\d+)$/.exec(path)?.[1];
      if (run && runs.has(run)) return Response.json(runs.get(run));
      return Response.json({ error: "fixture_unknown_path" }, { status: 404 });
    };
    const f = await mauFixture(cleanup, { webRoot, host, hostCapabilities: { runIdempotency: true } });
    expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
    expect((await f.settled()).state).toBe("ready");
    const { page, matrix, errors } = await browser(f);
    page.setDefaultTimeout(5000);
    const requests: string[] = [];
    const sends: any[] = [];
    const groupBodies: any[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      requests.push(path);
      if (request.method() === "POST" && path === "/_agent-router/v1/web/groups")
        groupBodies.push(request.postDataJSON());
    });
    // Router's first answer to a send is lost; the message is sent again under the same idempotency key.
    await page.route("**/_agent-router/v1/web/chats/*/messages", (route) => {
      sends.push(route.request().postDataJSON());
      return sends.length === 1
        ? route.fulfill({ status: 503, json: { error: "request_failed" } })
        : route.continue();
    });
    await page.reload();
    const helper = agentChip(page, f.agent.id);
    await see(helper).toHaveAttribute("title", "helper");
    await page.screenshot({ path: "/tmp/mau-neutral-agents.png" });
    await helper.click();
    await page.getByPlaceholder("发送消息…").fill("hello from Mau");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    // The unsent message stays in the conversation with its state and can be given up.
    const unsent = page.locator(".room-chat-message.from-user", { hasText: "hello from Mau" });
    await see(unsent).toContainText("发送失败，正在重试…");
    await see(unsent.getByRole("button", { name: "放弃", exact: true })).toBeVisible();
    await see(
      page
        .locator(".room-chat-stream")
        .getByText("Reply received through account messaging")
        .first(),
    ).toBeVisible();
    expect(sends).toHaveLength(2);
    expect(sends[0]).toMatchObject({ text: "hello from Mau" });
    expect(sends[0].idempotencyKey).toEqual(expect.any(String));
    expect(sends[1]).toEqual(sends[0]);
    expect(runs.size).toBe(1);
    await see(page.locator(".room-chat-message.from-user", { hasText: "hello from Mau" })).toHaveCount(1);
    await see(page.getByPlaceholder("发送消息…")).toHaveValue("");
    await page.screenshot({ path: "/tmp/mau-neutral-messages.png" });
    // Groups are Router groups created with the OpenGrove dialog, and send intentional mentions.
    await page.getByRole("button", { name: "全部对话", exact: true }).click();
    await page
      .getByRole("complementary", { name: "全部对话" })
      .getByRole("button", { name: "新建群聊", exact: true })
      .click();
    const group = page.getByRole("dialog", { name: "新建群聊" });
    await group.getByRole("textbox").fill("发布组");
    await group.getByRole("checkbox").first().check();
    await group.getByRole("button", { name: "创建", exact: true }).click();
    const current = page.locator(".mau-chip[aria-selected='true']");
    await see(current).toHaveAttribute("title", "发布组");
    expect(await current.getAttribute("data-chat-key")).toMatch(/^chat:/);
    expect(groupBodies).toHaveLength(1);
    expect(groupBodies[0]).toMatchObject({ title: "发布组", agentIds: [f.agent.id] });
    const composer = page.getByPlaceholder("@员工 让他回答，@所有人 让大家都回答…");
    await composer.pressSequentially("@");
    await page.getByRole("option", { name: /helper/ }).click();
    await see(composer).toHaveValue("@helper ");
    await composer.pressSequentially("看一下");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await see.poll(() => sends.length).toBe(3);
    expect(sends[2]).toMatchObject({ text: "@helper 看一下", mentions: { agentIds: [f.agent.id], all: false } });
    await page.screenshot({ path: "/tmp/mau-group-messages.png" });
    // Messages are Mau's own (Router's ledger): nothing is sent to a Matrix homeserver.
    expect(matrix).toEqual([]);
    expect(
      requests.some(
        (path) =>
          path.includes("/ask/") ||
          path.includes("/host/") ||
          path.includes("/bridge") ||
          path.includes("/auth/session"),
      ),
    ).toBe(false);
    await page.getByRole("button", { name: "App 商店", exact: true }).click();
    await see(page.getByText("尚未接入", { exact: true })).toBeVisible();
    for (const name of ["钱包", "提现", "直接内核聊天"])
      await see(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  },
  30_000,
);

it.skipIf(!built)(
  "keeps appearance menus and original dialogs in the selected theme scope",
  async () => {
    const f = await mauFixture(cleanup, { webRoot });
    const { page, errors } = await browser(f);
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置" });
    await see(settings.getByRole("heading", { name: "通用" })).toBeVisible();
    await settings.getByRole("combobox", { name: "外观" }).click();
    await page.getByRole("option", { name: "深色", exact: true }).click();
    await see(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("mau.theme"))).toBe(
      "dark",
    );
    await settings.getByRole("combobox", { name: "外观" }).click();
    const menu = page.getByRole("listbox");
    await see(menu).toBeVisible();
    expect(
      await menu.evaluate((element) =>
        element.closest(".af-scope")?.getAttribute("data-resolved-theme"),
      ),
    ).toBe("dark");
    await page.keyboard.press("Escape");
    await settings.getByRole("button", { name: "关闭设置" }).click();
    await see(settings).toBeHidden();
    await page.getByRole("button", { name: "新建应用", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建应用", exact: true });
    await see(dialog).toBeVisible();
    expect(
      await dialog.evaluate((element) =>
        element.closest(".af-scope")?.getAttribute("data-resolved-theme"),
      ),
    ).toBe("dark");
    await see(
      dialog.getByRole("button", { name: "创建并打开", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await see(
      page.getByRole("button", { name: "新建应用", exact: true }),
    ).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    for (const language of ["zh-CN", "en"]) {
      if (language === "en") {
        await page.evaluate(() => { location.hash = "#/settings/general"; });
        await page.getByRole("combobox", { name: "语言" }).click();
        await page.getByRole("option", { name: "English", exact: true }).click();
        await page.getByRole("button", { name: "Close settings" }).click();
      }
      await page.locator(".app-titlebar-control").click();
      await page
        .getByRole("button", {
          name: language === "en" ? "Create app" : "新建应用",
          exact: true,
        })
        .click();
      const mobileDialog = page.locator(".app-create-dialog");
      await see(mobileDialog).toBeVisible();
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        const bounds = await mobileDialog.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
        const overflow = await mobileDialog.evaluate((element) =>
          [
            element,
            ...element.querySelectorAll(
              ".app-create-wizard, .app-create-section, .app-create-group, .settings-form-actions, .settings-form-actions button",
            ),
          ]
            .filter((node) => node.scrollWidth > node.clientWidth + 1)
            .map((node) => ({
              className: node.className,
              width: node.clientWidth,
              scroll: node.scrollWidth,
            })),
        );
        expect(overflow).toEqual([]);
        for (let index = 0; index < 12; index++) {
          await page.keyboard.press("Tab");
          expect(
            await mobileDialog.evaluate((element) =>
              element.contains(document.activeElement),
            ),
          ).toBe(true);
        }
        const actions = mobileDialog.locator(".settings-form-actions button");
        for (const action of await actions.all()) {
          await action.scrollIntoViewIfNeeded();
          const box = await action.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
          expect(box!.y).toBeGreaterThanOrEqual(0);
          expect(box!.y + box!.height).toBeLessThanOrEqual(845);
        }
        await page.screenshot({
          path: `/tmp/mau-review-mobile-app-dialog-${language}-${width}.png`,
        });
      }
      await page.keyboard.press("Escape");
      await see(mobileDialog).toBeHidden();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.reload();
    await see(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(errors).toEqual([]);
  },
  90_000,
);

it.skipIf(!built)(
  "has no Files entry and requests no workspace while shared files are not offered",
  async () => {
    const f = await mauFixture(cleanup, { webRoot });
    const { page, errors } = await browser(f);
    const workspaceRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/_mau/v1/workspaces"))
        workspaceRequests.push(request.url());
    });
    await page.reload();
    await see(
      page.getByRole("button", { name: "对话", exact: true }),
    ).toBeVisible();
    await see(
      page.getByRole("button", { name: "文件", exact: true }),
    ).toHaveCount(0);
    // The console may frame Cloudflare's live view (a browser handoff) and nothing else, and cannot be framed itself.
    const policy = (await page.request.get(f.base)).headers()["content-security-policy"] ?? "";
    expect(policy).toContain("frame-src https://live.browser.run;");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("default-src 'self'");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(workspaceRequests).toEqual([]);
    expect(errors).toEqual([]);
  },
  30_000,
);

it.skipIf(!built)("opens settings as a deep-linkable modal with messaging channels and connectors", async () => {
  const f = await mauFixture(cleanup, {webRoot});
  const {page, errors} = await browser(f);
  await page.reload();
  // One 设置 entry replaces 连接器 / 扩展 / 设置 in the main navigation.
  for (const name of ["连接器", "扩展"]) await see(page.getByRole("button", {name, exact:true})).toHaveCount(0);
  await page.getByRole("button", {name:"设置", exact:true}).click();
  const settings = page.getByRole("dialog", {name:"设置"});
  await see(settings.getByRole("heading", {name:"通用"})).toBeVisible();
  await see(page).toHaveURL(/#\/settings\/general$/);
  await settings.getByRole("button", {name:"连接器", exact:true}).click();
  await see(page).toHaveURL(/#\/settings\/connectors$/);
  // Without a connector service nothing is offered and there is no fake consent button.
  await see(settings.getByText("连接器服务尚未配置")).toBeVisible();
  await see(settings.getByRole("button", {name:"连接", exact:true})).toHaveCount(0);
  await settings.getByRole("button", {name:"消息渠道", exact:true}).click();
  await see(settings.getByRole("heading", {name:"helper", exact:true})).toBeVisible();
  await settings.getByRole("button", {name:"连接飞书", exact:true}).click();
  await see(settings.getByRole("heading", {name:"连接飞书"})).toBeVisible();
  await see(settings.getByLabel("已有应用 App ID")).toBeVisible();
  await settings.getByRole("button", {name:"消息渠道", exact:true}).last().click();
  await see(settings.getByRole("heading", {name:"消息渠道"})).toBeVisible();
  for (const [name, heading] of [["身份与配对", "身份与配对"], ["扩展", "扩展"], ["数据控制", "数据控制"], ["帮助与法律", "帮助与法律"]]) {
    await settings.getByRole("button", {name, exact:true}).click();
    await see(settings.getByRole("heading", {name:heading, exact:true})).toBeVisible();
  }
  await see(settings.getByRole("link", {name:/查看/})).toHaveAttribute("href", "https://www.openmau.com/privacy.html");
  // A reload keeps the page; closing removes it from the URL.
  await page.evaluate(() => { location.hash = "#/settings/channels"; });
  await page.reload();
  await see(page.getByRole("dialog", {name:"设置"}).getByRole("heading", {name:"消息渠道"})).toBeVisible();
  await page.getByRole("button", {name:"关闭设置"}).click();
  await see(page.getByRole("dialog")).toHaveCount(0);
  await see(page).toHaveURL(f.base + "/");
  // Mobile: full screen, the navigation is the first page and each page has a back button.
  await page.setViewportSize({width:390, height:844});
  await page.locator(".app-titlebar-control").click();
  await page.getByRole("button", {name:"设置", exact:true}).click();
  const mobile = page.getByRole("dialog", {name:"设置"});
  await see(mobile.getByRole("navigation", {name:"设置"})).toBeVisible();
  await expect.poll(() => mobile.boundingBox()).toEqual({x:0, y:0, width:390, height:844});
  await mobile.getByRole("button", {name:"通用", exact:true}).click();
  await see(mobile.getByRole("heading", {name:"通用"})).toBeVisible();
  await mobile.getByRole("button", {name:"返回"}).click();
  await see(mobile.getByRole("navigation", {name:"设置"})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
}, 90_000);

it.skipIf(!built)("connects Gmail after consent, returns to its page, edits permissions and gates uncertain disconnects", async () => {
  const f = await mauFixture(cleanup, { webRoot });
  const { page, errors } = await browser(f);
  let state = "authorization_required", failed = false, legacy = true;
  const mutations: Array<[string, unknown]> = [];
  const operation = (id: string, labelZh: string, risk: string, setting: string, extra = {}) =>
    ({ id, label: id, labelZh, risk, setting, default: setting, available: true, ...extra });
  let send = "ask";
  const policy = () => ({ groups: [
    { id: "read", label: "Read", labelZh: "读取权限", operations: [operation("gmail.read", "阅读邮件", "read", "allow")] },
    { id: "write", label: "Write", labelZh: "写入和删除权限", operations: [operation("gmail.send", "发邮件", "write", send),
      operation("gmail.labels.write", "管理标签", "write", "ask", { available: false, unavailableReason: "scope_required", grantable: true })] },
  ], background: [operation("gmail.sync", "后台同步", "read", "deny", { available: false, unavailableReason: "not_supported", grantable: false })] });
  // The provider callback completes the authorization before it lands back on the console.
  await page.route("https://accounts.google.com/**", route => { state = "connected"; return route.fulfill({ status: 302, headers: { location: f.base + "/?view=connectors&oauth=connected" } }); });
  await page.route("**/_mau/v1/connector-accounts**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith("/connector-accounts")) return route.fulfill({ json: { configured: true, data: [
      { id: "work-gmail", kind: "google", label: "Gmail", state, verification: "none", scopes: [], assignedAgents: [f.agent.id], permission: "read-only",
        ...(state === "connected" ? { account: { email: "alice@example.test" } } : {}) },
      { id: "work-calendar", kind: "google", label: "Google 日历", state: "needs_setup", verification: "none", scopes: [] }] } });
    if (path.endsWith("/policy") && request.method() === "GET") return legacy ? route.fulfill({ status: 404, json: { error: "not_found" } }) : route.fulfill({ json: policy() });
    const action = path.endsWith("/policy") ? "policy" : path.endsWith("/policy/reset") ? "reset" : path.split("/").at(-1)!;
    mutations.push([action, request.postDataJSON()]);
    if (action === "policy") { send = request.postDataJSON().settings["gmail.send"]; return route.fulfill({ json: policy() }); }
    if (action === "reset") { send = "ask"; return route.fulfill({ json: policy() }); }
    if (action === "connect" && request.postDataJSON().operations) return route.fulfill({ status: 400, json: { error: "invalid_request" } });
    if (action === "connect") return route.fulfill({ json: { state, verification: "none", scopes: [], authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture" } });
    if (action === "disconnect" && !failed) { failed = true; return route.fulfill({ status: 409, json: { error: "connector_action_unknown" } }); }
    state = action === "disconnect" ? "disconnected" : "connected";
    return route.fulfill({ json: { state, verification: state === "connected" ? "oauth" : "none", scopes: state === "connected" ? ["gmail.readonly"] : [] } });
  });
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("button", { name: "连接器", exact: true }).click();
  // Coming-soon apps are hidden; there are no featured cards, and each row shows its status.
  await see(settings.getByRole("button", { name: "Google 日历", exact: true })).toHaveCount(0);
  await see(settings.getByRole("heading", { name: "精选" })).toHaveCount(0);
  await see(settings.locator(".agent-status-line").first()).toBeVisible();
  // A server without the policy API shows what it enforces, read-only.
  await settings.getByRole("button", { name: "Gmail", exact: true }).click();
  await see(settings.getByRole("heading", { name: "Gmail" })).toBeVisible();
  await see(page).toHaveURL(/#\/settings\/connectors\/gmail$/);
  await see(settings.getByText("搜索邮件")).toBeVisible();
  await see(settings.getByRole("combobox")).toHaveCount(0);
  await see(settings.getByRole("button", { name: "重置为默认" })).toHaveCount(0);
  await settings.getByRole("button", { name: "所有连接器" }).click();
  legacy = false;
  await settings.getByRole("button", { name: "连接", exact: true }).click();
  const consent = page.getByRole("dialog", { name: "Gmail" });
  await see(consent).toContainText("授权凭据保存在 Mau，不会进入员工的沙箱。");
  await see(consent).toContainText("写入操作按你的设置请求批准");
  await see(consent.getByRole("link", { name: "隐私政策" })).toHaveAttribute("href", "https://www.openmau.com/privacy.html");
  await page.screenshot({ path: "/tmp/mau-consent.png" });
  await consent.getByRole("button", { name: "取消", exact: true }).click();
  expect(mutations).toEqual([]);
  await settings.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("dialog", { name: "Gmail" }).getByRole("button", { name: "继续", exact: true }).click();
  // The OAuth callback lands on /?view=connectors&oauth=connected and reopens the page the owner started from.
  await see(page.getByText("授权完成，连接器已连接", { exact: true })).toBeVisible();
  await see(page).toHaveURL(f.base + "/#/settings/connectors/gmail");
  const detail = page.getByRole("dialog", { name: "设置" });
  // Checked automatically on open; no "check connection" button.
  await see(detail.getByText("alice@example.test")).toBeVisible();
  await see(detail.getByRole("button", { name: "检查连接" })).toHaveCount(0);
  expect(mutations.map(([action]) => action)).toEqual(["connect", "check"]);
  await see(detail.getByRole("combobox", { name: "发邮件" })).toHaveText(/请求/);
  await see(detail.getByText("在定时任务和委派工作中，设为「请求」的操作会被拒绝。")).toBeVisible();
  await see(detail.getByText("后台同步")).toBeVisible();
  await page.screenshot({ path: "/tmp/mau-gmail-detail.png" });
  await detail.getByRole("combobox", { name: "发邮件" }).click();
  await page.getByRole("option", { name: "允许", exact: true }).click();
  const allow = page.getByRole("dialog", { name: "允许「发邮件」？" });
  await see(allow).toContainText("以后员工执行此操作不会再询问你。");
  await allow.getByRole("button", { name: "允许", exact: true }).click();
  await see(detail.getByRole("combobox", { name: "发邮件" })).toHaveText(/允许/);
  expect(mutations.at(-1)).toEqual(["policy", { settings: { "gmail.send": "allow" } }]);
  await detail.getByRole("button", { name: "添加", exact: true }).click();
  await see(page.getByText("暂时无法添加这项权限。")).toBeVisible();
  expect(mutations.at(-1)).toEqual(["connect", { operations: ["gmail.labels.write"] }]);
  await detail.getByRole("button", { name: "重置为默认" }).click();
  await page.getByRole("dialog", { name: "重置为默认权限？" }).getByRole("button", { name: "重置", exact: true }).click();
  await see(detail.getByRole("combobox", { name: "发邮件" })).toHaveText(/请求/);
  // An unconfirmed disconnect must be checked before anything else; nothing is retried automatically.
  await detail.getByRole("button", { name: "断开", exact: true }).click();
  await page.getByRole("dialog", { name: "断开Gmail？" }).getByRole("button", { name: "断开", exact: true }).click();
  await see(detail.getByText("无法确认连接状态")).toBeVisible();
  await see(detail.getByRole("button", { name: "断开", exact: true })).toHaveCount(0);
  await detail.getByRole("button", { name: "重新检查" }).click();
  await detail.getByRole("button", { name: "断开", exact: true }).click();
  await page.getByRole("dialog", { name: "断开Gmail？" }).getByRole("button", { name: "断开", exact: true }).click();
  await see(detail.getByRole("button", { name: "连接Gmail" })).toBeVisible();
  expect(mutations.map(([action]) => action)).toEqual(["connect", "check", "policy", "connect", "reset", "disconnect", "check", "disconnect"]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
}, 90_000);

it.skipIf(!built)(
  "edge login: no login form, the expiry banner reloads, and an unmapped account gets the no-access page",
  async () => {
    const f = await mauFixture(cleanup, { webRoot });
    const { page, authorization } = await browser(f);
    await see(page.getByText("alice@example.test").first()).toBeVisible();
    await see(page.getByLabel("密码")).toHaveCount(0);
    // An expired Access session turns API calls into redirects: the banner offers a re-login reload.
    await page.route("**/_mau/v1/agents", (route) => route.fulfill({ status: 302, headers: { Location: "https://example-team.cloudflareaccess.com/" } }));
    // Returning to the conversation page reads the employees again.
    await page.getByRole("button", { name: "App 商店", exact: true }).click();
    await page.getByRole("button", { name: "对话", exact: true }).click();
    await see(page.getByText("登录已过期")).toBeVisible();
    await page.unroute("**/_mau/v1/agents");
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "重新登录" }).click()]);
    await see(page.getByText("登录已过期")).toHaveCount(0);
    expect(authorization).toEqual([]);
    const stranger = await browser(f, { email: "stranger@example.test" });
    await see(stranger.page.getByText("此账号未开通 Mau（stranger@example.test）")).toBeVisible();
    await see(stranger.page.getByRole("button", { name: "切换账号" })).toBeVisible();
  },
  60_000,
);

it.skipIf(!built)(
  "edge login: a request refused as unauthenticated (the Access JWT ran out) shows the expiry banner, never a sign-in page",
  async () => {
    const f = await mauFixture(cleanup, { webRoot });
    const { page, context, errors } = await browser(f);
    await see(page.getByText("alice@example.test").first()).toBeVisible();
    // From now on the edge header carries an expired JWT: Router refuses the next API call itself.
    const past = Math.floor(Date.now() / 1000) - 3600;
    await context.setExtraHTTPHeaders(f.edgeHeaders({ iat: past - 600, exp: past }));
    const refused = page.waitForResponse((response) => new URL(response.url()).pathname === "/_mau/v1/agents" && response.status() === 401);
    await page.getByRole("button", { name: "App 商店", exact: true }).click();
    await page.getByRole("button", { name: "对话", exact: true }).click();
    await refused;
    await see(page.getByRole("alert").filter({ hasText: "登录已过期" })).toBeVisible();
    await see(page.getByLabel("密码")).toHaveCount(0);
    // "重新登录" reloads; with a renewed Access session the console is back without the banner.
    await context.setExtraHTTPHeaders(f.edgeHeaders());
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "重新登录" }).click()]);
    await see(page.getByText("alice@example.test").first()).toBeVisible();
    await see(page.getByText("登录已过期")).toHaveCount(0);
    expect(errors).toEqual([]);
  },
  60_000,
);

it.skipIf(!built)(
  "a service without an edge identity has no web login: the access page says so and offers a retry",
  async () => {
    const f = await mauFixture(cleanup, { webRoot });
    const { page, context, matrix, errors } = await browser(f);
    const plain = await context.newPage();
    await plain.route("**/_mau/v1/info", (route) => route.fulfill({ json: { login: "other" } }));
    const requests: string[] = [];
    plain.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await plain.goto(f.base);
    const alert = plain.getByRole("alert");
    await see(alert).toContainText("这个服务没有开启网页登录。请为它配置边缘身份（例如 Cloudflare Access）后再打开控制台。");
    await see(alert.getByRole("button", { name: "重试", exact: true })).toBeVisible();
    await see(plain.getByLabel("密码")).toHaveCount(0);
    expect(requests.filter((path) => path.startsWith("/_mau/v1/") && path !== "/_mau/v1/info")).toEqual([]);
    expect(matrix).toEqual([]);
    await page.close();
    expect(errors).toEqual([]);
  },
  30_000,
);

it.skipIf(!built)("one 飞书 entry: chat in 消息渠道, personal access with a QR from the account, expiry and re-authorization", async () => {
  const f = await mauFixture(cleanup, { webRoot });
  const { page, errors } = await browser(f);
  let state: Record<string, unknown> = { state: "expired", reason: "refresh_token_expired" }, confirmed = false;
  const requests: Array<[string, unknown]> = [];
  const link = "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=FIXTURE";
  await page.route("**/_mau/v1/agents", async route => {
    const response = await route.fetch(), body = await response.json();
    body.data = body.data.map((a: any) => ({ ...a, connections: [...a.connections, { id: "feishu", kind: "feishu" }] }));
    return route.fulfill({ response, json: body });
  });
  await page.route("**/_mau/v1/connector-accounts**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/connector-accounts")) return route.fulfill({ json: { configured: true, data: [
      { id: "alice-feishu", kind: "feishu", label: "飞书", usage: "owner_private", verification: "none", scopes: [], assignedAgents: [f.agent.id], permission: "read-only", ...state }] } });
    if (path.endsWith("/policy")) return route.fulfill({ status: 404, json: { error: "not_found" } });
    const action = path.split("/").at(-1)!; requests.push([action, route.request().postDataJSON()]);
    if (action === "check") return route.fulfill({ json: { verification: "none", scopes: [], ...state } });
    if (action === "feishu-application") return route.fulfill({ json: { ...state, verification: "none", scopes: [] } });
    // The list API reports a pending authorization with its link; the QR comes from the account.
    if (action === "connect") { state = { state: "authorization_pending", authorizationUrl: link, expiresAt: new Date(Date.now() + 600_000).toISOString() };
      return route.fulfill({ json: { verification: "none", scopes: [], ...state } }); }
    if (confirmed) state = { state: "connected", name: "Alice", account: { name: "Alice" } };
    return route.fulfill({ json: { verification: confirmed ? "provider" : "none", scopes: [], ...state } });
  });
  await page.reload();
  await page.evaluate(() => { location.hash = "#/settings/connectors"; });
  const settings = page.getByRole("dialog", { name: "设置" });
  await see(settings.getByText("飞书的授权已过期")).toBeVisible();
  await settings.getByRole("button", { name: "重新授权", exact: true }).click();
  await see(settings.getByRole("heading", { name: "飞书" })).toBeVisible();
  await see(settings.getByText(/授权已到期。员工暂时无法使用，请重新授权。/)).toBeVisible();
  await see(settings.getByText("仅私聊")).toBeVisible();
  await settings.getByRole("button", { name: "重新授权", exact: true }).click();
  const consent = page.getByRole("dialog", { name: "飞书" });
  await see(consent).toContainText("只在你和员工的私聊中可用，群聊中不可用");
  await consent.getByRole("button", { name: "继续", exact: true }).click();
  await see(settings.getByRole("link", { name: "在浏览器中打开" })).toHaveAttribute("href", link);
  expect(requests.filter(([action]) => action !== "check" && action !== "complete").slice(0, 2)).toEqual([["feishu-application", { agentId: f.agent.id }], ["connect", {}]]);
  // A reload keeps the QR: it is rendered from the account's authorizationUrl, and completion keeps polling.
  await page.reload();
  await see(page.getByRole("dialog", { name: "设置" }).getByRole("link", { name: "在浏览器中打开" })).toHaveAttribute("href", link);
  confirmed = true;
  await see(page.getByRole("dialog", { name: "设置" }).getByText("Alice", { exact: true })).toBeVisible({ timeout: 10_000 });
  await see(page.getByRole("link", { name: "在浏览器中打开" })).toHaveCount(0);
  // 消息渠道 shows the chat and links to personal access.
  await page.getByRole("dialog", { name: "设置" }).getByRole("button", { name: "消息渠道", exact: true }).click();
  await see(settings.getByText("个人权限已授权")).toBeVisible();
  await see(settings.getByRole("button", { name: "检查飞书" })).toBeVisible();
  await settings.getByRole("button", { name: "个人权限", exact: true }).click();
  await see(settings.getByRole("heading", { name: "飞书" })).toBeVisible();
  expect(errors).toEqual([]);
}, 60_000);
