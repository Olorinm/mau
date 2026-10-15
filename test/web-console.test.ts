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
    await page.getByRole("button", { name: "查看通讯录", exact: true }).click();
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
    await connect.getByRole("button", { name: "Matrix" }).click();
    await page
      .getByRole("dialog", { name: "Matrix" })
      .getByRole("button", { name: "开始连接" })
      .click();
    await see(page.getByRole("region", { name: "通知" })).toContainText(
      "Matrix 已连接",
    );
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
      page.getByRole("button", { name: "Agents", exact: true }),
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
        personalTools: false,
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
      personalTools: false,
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
          return route.fulfill({
            json: { room_id: "!direct:example.test" },
            headers: cors,
          });
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
    await page.getByRole("button", { name: "查看通讯录", exact: true }).click();
    await see(agentRow(page, "helper")).toBeVisible();
    await page.screenshot({ path: "/tmp/mau-neutral-agents.png" });
    await page.getByRole("button", { name: "对话", exact: true }).click();
    await page.getByRole("button", { name: "发起会话", exact: true }).click();
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
