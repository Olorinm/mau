import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, expect as see, type Page } from "@playwright/test";
import { alice, mauFixture } from "./fixtures/mau.js";
import { accessIssuer } from "./fixtures/access.js";
import { ManagedService } from "@agent-router/server";

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

async function browser(base: string) {
  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const context = await instance.newContext({
    locale: "zh-CN",
    reducedMotion: "reduce",
    viewport: { width: 1200, height: 900 },
  });
  const matrix: string[] = [];
  // The public homeserver is the fixture server name; Playwright answers its client API, including CORS preflight.
  await context.route(
    "https://example.test/_matrix/client/v3/**",
    async (route) => {
      const request = route.request(),
        cors = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "authorization, content-type",
          "Access-Control-Allow-Methods": "POST",
        };
      if (request.method() === "OPTIONS")
        return route.fulfill({ status: 204, headers: cors });
      matrix.push(new URL(request.url()).pathname);
      if (request.url().endsWith("/login")) {
        const body = request.postDataJSON();
        return body.password === "correct"
          ? route.fulfill({
              json: { access_token: "alice", user_id: "@alice:example.test" },
              headers: cors,
            })
          : route.fulfill({
              status: 403,
              json: { errcode: "M_FORBIDDEN", error: "Invalid password" },
              headers: cors,
            });
      }
      return route.fulfill({ json: {}, headers: cors });
    },
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  return { page, matrix, errors };
}

const agentRow = (page: Page, name: string) =>
  page.getByRole("button", { name: new RegExp(`^${name}`) });

it.skipIf(!built)(
  "signs in, provisions an agent, controls its environment, connects a channel and signs out",
  async () => {
    const f = await mauFixture(cleanup, { webRoot });
    const home = await fetch(f.base + "/");
    expect(home.headers.get("content-security-policy")).toContain(
      "connect-src 'self' https://example.test",
    );
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
          headers: { authorization: "Bearer alice" },
        })
      ).status,
    ).toBe(404);
    const { page, matrix, errors } = await browser(f.base);

    await page.getByLabel("账号").fill("alice");
    await page.getByLabel("密码").fill("wrong");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await see(page.getByRole("alert")).toHaveText("账号或密码不正确。");
    await page.getByLabel("密码").fill("correct");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await see(page.getByText("@alice:example.test")).toBeVisible();
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
    await page.getByRole("button", { name: "通讯录", exact: true }).click();
    // The fixture pre-creates "helper" without an environment.
    await see(agentRow(page, "helper")).toBeVisible();
    await see(page.locator(".contacts-employee-runtime-card")).toContainText(
      "未配置环境",
    );

    await page.getByRole("button", { name: "新建", exact: true }).click();
    await page.getByRole("menuitem", { name: "新建员工" }).click();
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
    await see(page.getByRole("heading", { name: "writer" })).toBeVisible();
    await see(page.locator(".contacts-employee-runtime-card")).toContainText(
      "可用",
      { timeout: 10_000 },
    );
    expect(new URL(page.url()).searchParams.get("agent")).toBeTruthy();

    await page.getByRole("button", { name: "暂停" }).click();
    await see(page.locator(".contacts-employee-runtime-card")).toContainText(
      "已暂停",
      { timeout: 10_000 },
    );
    await see(page.getByText("已手动暂停")).toBeVisible();
    await page.getByRole("button", { name: "恢复" }).click();
    await see(page.locator(".contacts-employee-runtime-card")).toContainText(
      "可用",
      { timeout: 10_000 },
    );

    await page
      .getByRole("button", { name: "连接渠道", exact: true })
      .first()
      .click();
    const connect = page.getByRole("dialog", { name: "连接渠道" });
    // Provisioning already enabled built-in chat; users do not need a separate connection step.
    await see(connect.getByRole("button", { name: /Matrix/ })).toBeDisabled();
    await page.keyboard.press("Escape");
    await see(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: "运行自检" }).click();
    await see(page.getByRole("button", { name: "运行自检" })).toBeEnabled();
    // Router reports the Host check in its own words; the console shows it with a localized status.
    const hostCheck = page.locator(".agent-ui-settings-row", {
      hasText: "HTTP service and runtime exist",
    });
    await see(hostCheck).toContainText("通过");

    await page.getByRole("button", { name: "销毁环境" }).click();
    const destroy = page.getByRole("dialog", {
      name: "销毁 writer 的运行环境？",
    });
    await see(destroy).toContainText("无法恢复");
    await destroy.getByRole("button", { name: "销毁环境" }).click();
    await see(page.locator(".contacts-employee-runtime-card")).toContainText(
      "已销毁",
      { timeout: 10_000 },
    );
    expect(f.cloud.size).toBe(0);

    await page.getByRole("button", { name: "账号", exact: true }).click();
    await page.getByRole("menuitem", { name: "English" }).click();
    await see(
      page.getByRole("button", { name: "Contacts", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Account", exact: true }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await see(
      page.getByRole("heading", { name: "Return to your Mau" }),
    ).toBeVisible();
    expect(matrix.filter((path) => !path.endsWith("/sync"))).toEqual([
      "/_matrix/client/v3/login",
      "/_matrix/client/v3/login",
      "/_matrix/client/v3/logout",
    ]);
    expect(
      await page.evaluate(() => localStorage.getItem("mau.session")),
    ).toBeNull();

    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  },
  60_000,
);

it.skipIf(!built)(
  "an expired session returns to sign-in with an explanation",
  async () => {
    const f = await mauFixture(cleanup, { webRoot });
    const { page } = await browser(f.base);
    await page.evaluate(() =>
      localStorage.setItem(
        "mau.session",
        JSON.stringify({ token: "revoked", owner: "@alice:example.test" }),
      ),
    );
    await page.reload();
    await see(page.getByRole("region", { name: "通知" })).toContainText(
      "登录已失效",
    );
    await see(
      page.getByRole("heading", { name: "回到你的 Mau" }),
    ).toBeVisible();
  },
  30_000,
);

it.skipIf(!built).each(["server", "network", "rate-limit"])(
  "channel setup recovers from a temporary %s failure",
  async (failure) => {
    const f = await mauFixture(cleanup, { webRoot });
    const { page, errors } = await browser(f.base);
    await page.evaluate(() =>
      localStorage.setItem(
        "mau.session",
        JSON.stringify({ token: "alice", owner: "@alice:example.test" }),
      ),
    );
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
    await page
      .locator(".agent-ui-settings-row", { hasText: "微信" })
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
  "an unknown channel setup job stops polling and asks to restart",
  async () => {
    const f = await mauFixture(cleanup, { webRoot });
    const { page, errors } = await browser(f.base);
    await page.evaluate(() =>
      localStorage.setItem(
        "mau.session",
        JSON.stringify({ token: "alice", owner: "@alice:example.test" }),
      ),
    );
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
    await page
      .locator(".agent-ui-settings-row", { hasText: "微信" })
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
    const { page, errors } = await browser(f.base);
    await page.evaluate(() =>
      localStorage.setItem(
        "mau.session",
        JSON.stringify({ token: "alice", owner: "@alice:example.test" }),
      ),
    );
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
    await page
      .locator(".agent-ui-settings-row", { hasText: "飞书" })
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
    const f = await mauFixture(cleanup, { webRoot });
    const { page, errors } = await browser(f.base);
    page.setDefaultTimeout(5000);
    await page.screenshot({ path: "/tmp/mau-neutral-login.png" });
    await page.evaluate(() =>
      localStorage.setItem(
        "mau.session",
        JSON.stringify({ token: "alice", owner: "@alice:example.test" }),
      ),
    );
    const requests: string[] = [];
    const transactions: string[] = [];
    const groupBodies: any[] = [];
    let accepted = false;
    page.on("request", (request) =>
      requests.push(new URL(request.url()).pathname),
    );
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    };
    await page.route(
      "https://example.test/_matrix/client/v3/**",
      async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (request.method() === "OPTIONS")
          return route.fulfill({ status: 204, headers: cors });
        if (url.pathname.endsWith("/createRoom")) {
          expect(request.postDataJSON().invite).toEqual([f.agent.matrixId]);
          if (request.postDataJSON().preset === "private_chat") {
            groupBodies.push(request.postDataJSON());
            return route.fulfill({ json: { room_id: "!group:example.test" }, headers: cors });
          }
          return route.fulfill({
            json: { room_id: "!direct:example.test" },
            headers: cors,
          });
        }
        if (url.pathname.includes(encodeURIComponent("!group:example.test")) && url.pathname.includes("/send/")) {
          groupBodies.push(request.postDataJSON());
          return route.fulfill({ json: { event_id: "group-sent" }, headers: cors });
        }
        if (url.pathname.includes("/send/")) {
          transactions.push(url.pathname.split("/").at(-1)!);
          expect(request.postDataJSON()).toEqual({
            msgtype: "m.text",
            body: "hello from Mau",
          });
          if (transactions.length === 1)
            return route.fulfill({
              status: 503,
              json: { errcode: "M_UNKNOWN" },
              headers: cors,
            });
          accepted = true;
          return route.fulfill({ json: { event_id: "sent" }, headers: cors });
        }
        if (url.pathname.endsWith("/sync"))
          return route.fulfill({
            headers: cors,
            json: {
              next_batch: "cursor",
              rooms: {
                join: accepted
                  ? {
                      "!direct:example.test": {
                        state: {
                          events: [
                            {
                              type: "m.room.member",
                              state_key: f.agent.matrixId,
                              content: { membership: "join" },
                            },
                            {
                              type: "m.room.member",
                              state_key: "@alice:example.test",
                              content: { membership: "join" },
                            },
                          ],
                        },
                        timeline: {
                          events: [
                            {
                              event_id: "sent",
                              type: "m.room.message",
                              sender: "@alice:example.test",
                              origin_server_ts: 1,
                              content: {
                                msgtype: "m.text",
                                body: "hello from Mau",
                              },
                            },
                            {
                              event_id: "reply",
                              type: "m.room.message",
                              sender: f.agent.matrixId,
                              origin_server_ts: 2,
                              content: {
                                msgtype: "m.text",
                                body: "Reply received through account messaging",
                              },
                            },
                          ],
                        },
                      },
                    }
                  : {},
              },
            },
          });
        return route.fulfill({
          status: 501,
          json: { error: "unexpected_fixture_request" },
          headers: cors,
        });
      },
    );
    await page.reload();
    await page.getByRole("button", { name: "通讯录", exact: true }).click();
    await see(agentRow(page, "helper")).toBeVisible();
    await page.screenshot({ path: "/tmp/mau-neutral-agents.png" });
    await page.getByRole("button", { name: "对话", exact: true }).click();
    await page.getByRole("button", { name: "发起单聊", exact: true }).click();
    await page.getByLabel("选择员工").selectOption(f.agent.id);
    await page.getByRole("button", { name: "打开对话", exact: true }).click();
    await page.getByPlaceholder("发送消息…").fill("hello from Mau");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await see(
      page.getByRole("button", { name: "放弃重试", exact: true }),
    ).toBeVisible();
    await see(page.getByPlaceholder("发送消息…")).toHaveValue("hello from Mau");
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await see(
      page
        .locator(".room-chat-stream")
        .getByText("Reply received through account messaging"),
    ).toBeVisible();
    expect(transactions).toHaveLength(2);
    expect(transactions[0]).toBe(transactions[1]);
    await see(page.getByPlaceholder("发送消息…")).toHaveValue("");
    await page.screenshot({ path: "/tmp/mau-neutral-messages.png" });
    // Groups use the restored OpenGrove dialog, are marked as groups and send intentional mentions.
    await page.getByRole("button", { name: "新建", exact: true }).click();
    await page.getByRole("menuitem", { name: "发起群聊" }).click();
    const group = page.getByRole("dialog", { name: "创建群聊" });
    await group.getByRole("textbox").fill("发布组");
    await group.getByRole("checkbox").first().check();
    await group.getByRole("button", { name: "创建", exact: true }).click();
    await see(page.getByRole("region", { name: "对话" }).getByText("发布组")).toBeVisible();
    expect(groupBodies[0]).toMatchObject({ preset: "private_chat", name: "发布组",
      initial_state: [{ type: "ai.mau.room", state_key: "", content: { kind: "group" } }] });
    const composer = page.getByPlaceholder("@员工 让他回答，@所有人 让大家都回答…");
    await composer.pressSequentially("@");
    await page.getByRole("option", { name: /helper/ }).click();
    await see(composer).toHaveValue("@helper ");
    await composer.pressSequentially("看一下");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await see.poll(() => groupBodies.length).toBe(2);
    expect(groupBodies[1]).toEqual({ msgtype: "m.text", body: "@helper 看一下", "m.mentions": { user_ids: [f.agent.matrixId] } });
    await page.screenshot({ path: "/tmp/mau-group-messages.png" });
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
    const { page, errors } = await browser(f.base);
    await page.evaluate(() =>
      localStorage.setItem(
        "mau.session",
        JSON.stringify({ token: "alice", owner: "@alice:example.test" }),
      ),
    );
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
  "keeps the unavailable Files entry accessible without inventing a workspace page",
  async () => {
    const f = await mauFixture(cleanup, { webRoot });
    const { page, errors } = await browser(f.base);
    const workspaceRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/_mau/v1/workspaces"))
        workspaceRequests.push(request.url());
    });
    await page.evaluate(() =>
      localStorage.setItem(
        "mau.session",
        JSON.stringify({ token: "alice", owner: "@alice:example.test" }),
      ),
    );
    await page.reload();
    const files = page.getByRole("button", { name: "文件", exact: true });
    await files.focus();
    await page.keyboard.press("Enter");
    await see(
      page.getByText("Mau 尚未接入共享文件浏览服务。", { exact: true }),
    ).toBeVisible();
    await see(
      page.getByRole("button", { name: "重试", exact: true }),
    ).toHaveCount(0);
    await see(
      page.getByRole("link", { name: "下载", exact: true }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await see(
      page.getByText("Mau 尚未接入共享文件浏览服务。", { exact: true }),
    ).toBeVisible();
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
  const {page, errors} = await browser(f.base);
  await page.evaluate(() => localStorage.setItem("mau.session", JSON.stringify({token:"alice", owner:"@alice:example.test"})));
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
  const { page, errors } = await browser(f.base);
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
    if (action === "connect" && request.postDataJSON().scopes) return route.fulfill({ status: 400, json: { error: "invalid_request" } });
    if (action === "connect") return route.fulfill({ json: { state, verification: "none", scopes: [], authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture" } });
    if (action === "disconnect" && !failed) { failed = true; return route.fulfill({ status: 409, json: { error: "connector_action_unknown" } }); }
    state = action === "disconnect" ? "disconnected" : "connected";
    return route.fulfill({ json: { state, verification: state === "connected" ? "oauth" : "none", scopes: state === "connected" ? ["gmail.readonly"] : [] } });
  });
  await page.evaluate(() => localStorage.setItem("mau.session", JSON.stringify({ token: "alice", owner: "@alice:example.test" })));
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
  expect(mutations.at(-1)).toEqual(["connect", { scopes: ["gmail.labels.write"] }]);
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

// Edge login needs a Router with `authenticateRequest` (agent-router ADR 0005 18.2).
const edgeRouter = typeof (ManagedService.prototype as { authenticateRequest?: unknown }).authenticateRequest === "function";
it.skipIf(!built || !edgeRouter)(
  "edge login: no login form, the expiry banner reloads, and an unmapped account gets the no-access page",
  async () => {
    const access = await accessIssuer(cleanup);
    const f = await mauFixture(cleanup, { webRoot }, undefined, { edgeIdentity: access.config({ "alice@example.test": alice }) },
      { ledgerRead: true }, { edgeIdentityCerts: access.certsUrl });
    const instance = await chromium.launch({ headless: true });
    cleanup.push(() => instance.close());
    const open = async (email: string) => {
      // Cloudflare adds the JWT to every request behind Access; the console itself sends no token.
      const context = await instance.newContext({ locale: "zh-CN", reducedMotion: "reduce", viewport: { width: 1200, height: 900 },
        extraHTTPHeaders: { "cf-access-jwt-assertion": access.jwt({ email }) } });
      const page = await context.newPage(), authorization: string[] = [];
      page.on("request", (request) => { const value = request.headers()["authorization"]; if (value) authorization.push(value); });
      await page.goto(f.base);
      return { page, authorization };
    };
    const { page, authorization } = await open("alice@example.test");
    await see(page.getByText("alice@example.test").first()).toBeVisible();
    await see(page.getByLabel("密码")).toHaveCount(0);
    // An expired Access session turns API calls into redirects: the banner offers a re-login reload.
    await page.route("**/_mau/v1/agents", (route) => route.fulfill({ status: 302, headers: { Location: "https://example-team.cloudflareaccess.com/" } }));
    await page.getByRole("button", { name: "通讯录" }).click();
    await see(page.getByText("登录已过期")).toBeVisible();
    await page.unroute("**/_mau/v1/agents");
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "重新登录" }).click()]);
    await see(page.getByText("登录已过期")).toHaveCount(0);
    expect(authorization).toEqual([]);
    const stranger = await open("stranger@example.test");
    await see(stranger.page.getByText("此账号未开通 Mau（stranger@example.test）")).toBeVisible();
    await see(stranger.page.getByRole("button", { name: "切换账号" })).toBeVisible();
  },
  60_000,
);

it.skipIf(!built)("one 飞书 entry: chat in 消息渠道, personal access with a QR from the account, expiry and re-authorization", async () => {
  const f = await mauFixture(cleanup, { webRoot });
  const { page, errors } = await browser(f.base);
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
  await page.evaluate(() => localStorage.setItem("mau.session", JSON.stringify({ token: "alice", owner: "@alice:example.test" })));
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
