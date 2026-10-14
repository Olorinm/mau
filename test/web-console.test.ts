import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, expect as see, type Page } from "@playwright/test";
import { mauFixture } from "./fixtures/mau.js";

// Browser acceptance for the built console (`npm run build:web`). CI sets MAU_WEB_E2E=1 so a missing build fails.
const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));
const built = existsSync(webRoot + "index.html");
if (!built && process.env.MAU_WEB_E2E === "1") throw new Error("web_console_build_required");

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});

async function browser(base: string) {
  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const context = await instance.newContext({ locale: "zh-CN", reducedMotion: "reduce", viewport: { width: 1200, height: 900 } });
  const matrix: string[] = [];
  // The public homeserver is the fixture server name; Playwright answers its client API, including CORS preflight.
  await context.route("https://example.test/_matrix/client/v3/**", async (route) => {
    const request = route.request(), cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "POST",
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    matrix.push(new URL(request.url()).pathname);
    if (request.url().endsWith("/login")) {
      const body = request.postDataJSON();
      return body.password === "correct"
        ? route.fulfill({ json: { access_token: "alice", user_id: "@alice:example.test" }, headers: cors })
        : route.fulfill({ status: 403, json: { errcode: "M_FORBIDDEN", error: "Invalid password" }, headers: cors });
    }
    return route.fulfill({ json: {}, headers: cors });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  return { page, matrix, errors };
}

const agentRow = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}`) });

it.skipIf(!built)("signs in, provisions an agent, controls its environment, connects a channel and signs out", async () => {
  const f = await mauFixture(cleanup, { webRoot });
  const home = await fetch(f.base + "/");
  expect(home.headers.get("content-security-policy")).toContain("connect-src 'self' https://example.test");
  for (const path of ["/health/live", "/HEALTH/live/"]) {
    const health = await fetch(f.base + path);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", component: "agent-service" });
  }
  const unknownHealth = await fetch(f.base + "/health/missing");
  expect(unknownHealth.status).toBe(404);
  expect(await unknownHealth.json()).toEqual({ error: "not_found" });
  expect((await fetch(f.base + "/_mau/v1/missing", { headers: { authorization: "Bearer alice" } })).status).toBe(404);
  const { page, matrix, errors } = await browser(f.base);

  await page.getByLabel("账号").fill("alice");
  await page.getByLabel("密码").fill("wrong");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await see(page.getByRole("alert")).toHaveText("账号或密码不正确。");
  await page.getByLabel("密码").fill("correct");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await see(page.getByText("@alice:example.test")).toBeVisible();
  // The fixture pre-creates "helper" without an environment.
  await see(agentRow(page, "helper")).toContainText("未配置环境");

  await page.getByRole("button", { name: "新建员工" }).click();
  const dialog = page.getByRole("dialog", { name: "新建员工" });
  await dialog.getByLabel("名称").fill("Writer");
  await see(dialog.getByRole("button", { name: "创建" })).toBeDisabled();
  await dialog.getByLabel("名称").fill("writer");
  await see(dialog.getByRole("radio", { name: /Cloud/ })).toBeChecked();
  await dialog.getByRole("button", { name: "创建" }).click();
  await see(page.getByRole("heading", { name: "writer" })).toBeVisible();
  await see(agentRow(page, "writer")).toContainText("可用", { timeout: 10_000 });
  expect(new URL(page.url()).searchParams.get("agent")).toBeTruthy();

  await page.getByRole("button", { name: "暂停" }).click();
  await see(agentRow(page, "writer")).toContainText("已暂停", { timeout: 10_000 });
  await see(page.getByText("已手动暂停")).toBeVisible();
  await page.getByRole("button", { name: "恢复" }).click();
  await see(agentRow(page, "writer")).toContainText("可用", { timeout: 10_000 });

  await page.getByRole("button", { name: "连接渠道" }).click();
  const connect = page.getByRole("dialog", { name: "连接渠道" });
  await connect.getByRole("button", { name: "Matrix" }).click();
  await page.getByRole("dialog", { name: "Matrix" }).getByRole("button", { name: "开始连接" }).click();
  await see(page.getByRole("region", { name: "通知" })).toContainText("Matrix 已连接");
  await see(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "运行自检" }).click();
  await see(page.getByRole("button", { name: "运行自检" })).toBeEnabled();
  // Router reports the Host check in its own words; the console shows it with a localized status.
  const hostCheck = page.locator(".agent-ui-settings-row", { hasText: "HTTP service and runtime exist" });
  await see(hostCheck).toContainText("通过");

  await page.getByRole("button", { name: "销毁环境" }).click();
  const destroy = page.getByRole("dialog", { name: "销毁 writer 的运行环境？" });
  await see(destroy).toContainText("无法恢复");
  await destroy.getByRole("button", { name: "销毁环境" }).click();
  await see(agentRow(page, "writer")).toContainText("已销毁", { timeout: 10_000 });
  expect(f.cloud.size).toBe(0);

  await page.getByRole("button", { name: "English" }).click();
  await see(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await see(page.getByRole("heading", { name: "Sign in to Mau" })).toBeVisible();
  expect(matrix).toEqual(["/_matrix/client/v3/login", "/_matrix/client/v3/login", "/_matrix/client/v3/logout"]);
  expect(await page.evaluate(() => localStorage.getItem("mau.session"))).toBeNull();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
}, 60_000);

it.skipIf(!built)("an expired session returns to sign-in with an explanation", async () => {
  const f = await mauFixture(cleanup, { webRoot });
  const { page } = await browser(f.base);
  await page.evaluate(() => localStorage.setItem("mau.session", JSON.stringify({ token: "revoked", owner: "@alice:example.test" })));
  await page.reload();
  await see(page.getByRole("region", { name: "通知" })).toContainText("登录已失效");
  await see(page.getByRole("heading", { name: "登录 Mau" })).toBeVisible();
}, 30_000);

it.skipIf(!built).each(["server", "network", "rate-limit"])("channel setup recovers from a temporary %s failure", async (failure) => {
  const f = await mauFixture(cleanup, { webRoot });
  const { page, errors } = await browser(f.base);
  await page.evaluate(() => localStorage.setItem("mau.session", JSON.stringify({ token: "alice", owner: "@alice:example.test" })));
  const job = { id: "retry-job", kind: "weixin", state: "waiting", expiresAt: new Date(Date.now() + 600_000).toISOString(), url: "https://example.test/pair" };
  await page.route("**/connection-jobs", route => route.fulfill({ json: { data: [job] } }));
  let recovered = false, reads = 0;
  await page.route("**/connection-jobs/retry-job", route => {
    reads++;
    if (recovered) return route.fulfill({ json: { ...job, state: "ready" } });
    if (failure === "network") return route.abort("failed");
    return route.fulfill({ status: failure === "rate-limit" ? 429 : 503, json: { error: "request_failed" } });
  });
  await page.goto(f.base + "?agent=" + encodeURIComponent(f.agent.id));
  await page.locator(".agent-ui-settings-row", { hasText: "微信" }).getByRole("button").click();
  const dialog = page.getByRole("dialog");
  await see(dialog.getByRole("alert")).toBeVisible();
  await see(dialog.getByRole("button", { name: "重试" })).toBeEnabled();
  const attempts = reads;
  recovered = true;
  await see(dialog).toHaveCount(0, { timeout: 10_000 });
  expect(reads).toBeGreaterThan(attempts);
  await see(page.getByRole("region", { name: "通知" })).toContainText("微信");
  expect(errors).toEqual([]);
}, 30_000);

it.skipIf(!built)("an unknown channel setup job stops polling and asks to restart", async () => {
  const f = await mauFixture(cleanup, { webRoot });
  const { page, errors } = await browser(f.base);
  await page.evaluate(() => localStorage.setItem("mau.session", JSON.stringify({ token: "alice", owner: "@alice:example.test" })));
  const job = { id: "expired-job", kind: "weixin", state: "waiting", expiresAt: new Date(Date.now() + 600_000).toISOString() };
  await page.route("**/connection-jobs", route => route.fulfill({ json: { data: [job] } }));
  let reads = 0;
  await page.route("**/connection-jobs/expired-job", route => {
    reads++;
    return route.fulfill({ status: 404, json: { error: "setup_job_not_found" } });
  });
  await page.goto(f.base + "?agent=" + encodeURIComponent(f.agent.id));
  await page.locator(".agent-ui-settings-row", { hasText: "微信" }).getByRole("button").click();
  await see(page.getByRole("dialog").getByRole("alert")).toContainText("过期");
  // More than one polling interval: a missing job must not keep requesting forever.
  await new Promise(resolve => setTimeout(resolve, 2500));
  expect(reads).toBe(1);
  expect(errors).toEqual([]);
}, 30_000);

it.skipIf(!built)("recovers a failed Feishu app with its original ID and polls binding", async () => {
  const f = await mauFixture(cleanup, { webRoot });
  const { page, errors } = await browser(f.base);
  await page.evaluate(() => localStorage.setItem("mau.session", JSON.stringify({ token: "alice", owner: "@alice:example.test" })));
  const failed = { id: "feishu-failed", kind: "feishu", state: "failed", error: "feishu_creation_outcome_unknown",
    expiresAt: new Date(Date.now() - 60_000).toISOString(), recovery: { action: "authorize_existing_app", appId: "cli_existing", domain: "lark", personalTools: false } };
  await page.route("**/connection-jobs", route => route.fulfill({ json: { data: [failed] } }));
  await page.route("**/connection-jobs/feishu-failed", route => route.fulfill({ json: failed }));
  let requested: unknown;
  await page.route("**/connections", route => {
    requested = route.request().postDataJSON();
    return route.fulfill({ status: 202, json: { id: "recovered", kind: "feishu", state: "binding", expiresAt: new Date(Date.now() + 60_000).toISOString() } });
  });
  await page.route("**/connection-jobs/recovered", route => route.fulfill({ json: { id: "recovered", kind: "feishu", state: "ready", expiresAt: new Date().toISOString() } }));
  await page.goto(f.base + "?agent=" + encodeURIComponent(f.agent.id));
  await page.locator(".agent-ui-settings-row", { hasText: "飞书" }).getByRole("button").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "恢复连接" }).click();
  await see(dialog.getByLabel("已有应用 App ID")).toHaveValue("cli_existing");
  await see(dialog.getByRole("radio", { name: "Lark（国际）" })).toBeChecked();
  await dialog.getByLabel("已有应用 App ID").fill("");
  await see(dialog.getByRole("button", { name: "开始连接" })).toBeDisabled();
  await dialog.getByLabel("已有应用 App ID").fill("cli_existing");
  await dialog.getByRole("button", { name: "开始连接" }).click();
  await see(dialog).toHaveCount(0, { timeout: 10_000 });
  expect(requested).toEqual({ kind: "feishu", appId: "cli_existing", domain: "lark", personalTools: false });
  expect(errors).toEqual([]);
}, 30_000);
