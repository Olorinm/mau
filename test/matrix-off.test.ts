import { afterEach, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, expect as see } from "@playwright/test";
import { ManagedService } from "@agent-router/server";
import { alice, mauFixture, root } from "./fixtures/mau.js";
import { accessIssuer } from "./fixtures/access.js";
import { edgeMauFixture } from "./fixtures/edge.js";

// agent-router ADR 0005 phase 7: Mau with `AGENT_MATRIX=off` (the Router service config's `matrix.enabled: false`).
// Released Routers before phase 7 have no Matrix switch and skip.
const supported = typeof (ManagedService.prototype as { matrixEnabled?: unknown }).matrixEnabled === "function";
const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));
const built = existsSync(webRoot + "index.html");
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });
const off = { matrix: { enabled: false }, ledgerRead: true, ledgerSend: true, ledgerCards: true, ledgerControl: true, ledgerGroups: true };

/** Every outbound fetch of the server process (the fixture's Matrix settings point at https://matrix.fixture). */
function recordFetch() {
  const urls: string[] = [], inner = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => { urls.push(String(input instanceof Request ? input.url : input)); return inner(input, init); });
  return urls;
}
async function edgeMau(serving: Parameters<typeof mauFixture>[1] = {}) {
  const f = await edgeMauFixture(cleanup, serving, off);
  return { f, access: f.access };
}

it.skipIf(!supported)("refuses to start with Matrix off and no edge identity", async () => {
  await expect(mauFixture(cleanup, {}, {}, off)).rejects.toThrow("matrix_off_requires_edge_identity");
});

it.skipIf(!supported)("refuses to start with Matrix off and no ledger: the console would have no chat source", async () => {
  const access = await accessIssuer(cleanup);
  await expect(mauFixture(cleanup, {}, { edgeIdentity: access.config({ "alice@example.test": alice }) }, { matrix: { enabled: false } },
    { edgeIdentityCerts: access.certsUrl })).rejects.toThrow("matrix_off_requires_ledger_read");
});

it.skipIf(!supported)("creates, configures and deletes employees without Matrix and serves the edge-only info", async () => {
  const { f, access } = await edgeMau();
  const urls = recordFetch();
  expect(await (await fetch(f.base + root + "/info")).json()).toEqual({ login: "edge", logoutUrl: "/cdn-cgi/access/logout", matrix: false });
  const jwt = access.jwt();
  expect(await (await fetch(f.base + root + "/account", { headers: { "cf-access-jwt-assertion": jwt } })).json()).toMatchObject({ owner: alice, via: "edge" });
  const router = await (await fetch(`${f.base}/_agent-router/v1/agents/${f.agent.id}`, { headers: { "cf-access-jwt-assertion": jwt } })).json() as { matrix: unknown };
  expect(router.matrix).toEqual({ state: "none", userId: null });
  expect(f.service.matrixEnabled(f.agent.id)).toBe(false);

  // The environment becomes ready and binds the Host; no Matrix connection is added.
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");
  const summary = (await f.api(`/agents/${f.agent.id}`)).data;
  expect(summary.connections).toEqual([]);
  expect(summary.host).toMatchObject({ runtimeId: "personal" });
  // A Matrix connection cannot be added while Matrix is off.
  expect((await f.api(`/agents/${f.agent.id}/connections`, { kind: "matrix" }, "alice", "/_agent-router/v1")).data).toEqual({ error: "matrix_disabled" });

  // A new employee through Mau, then deletion: no account is deactivated.
  const created = await f.api("/agents", { name: "writer", profileId: "cloud" });
  expect(created.status).toBe(202);
  expect(created.data.agent).toMatchObject({ name: "writer", matrix: { state: "none", userId: null } });
  const removed = await fetch(`${f.base}${root}/agents/${created.data.agent.id}`, { method: "DELETE", headers: { authorization: "Bearer alice" } });
  expect(removed.status).toBe(204);
  expect(f.service.store.entries("matrix_orphans")).toEqual([]);
  expect(urls.filter((url) => url.includes("matrix.fixture") || url.includes("/_matrix/"))).toEqual([]);
}, 60_000);

it.skipIf(!supported || !built)("runs the console with features.matrix=false without any Matrix code path", async (context) => {
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
  const { f, access } = await edgeMau({ webRoot, host, hostCapabilities: { runIdempotency: true } });
  const jwt = access.jwt();
  const me = await (await fetch(f.base + "/_agent-router/v1/web/me", { headers: { "cf-access-jwt-assertion": jwt } })).json() as { limits?: { features?: Record<string, boolean> } };
  if (me.limits?.features?.matrix !== false) return context.skip();
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");

  // Build assertion: the console contains no Matrix client code at all, in the entry or in any other asset.
  const assets = readdirSync(webRoot + "assets");
  expect(assets.some((name) => /^index-.*\.js$/.test(name))).toBe(true);
  expect(assets.filter((name) => /_matrix\/client|m\.login\.password/.test(readFileSync(webRoot + "assets/" + name, "utf8")))).toEqual([]);
  expect(assets.filter((name) => /^(matrix-login|login)-.*\.js$/.test(name))).toEqual([]);

  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const browser = await instance.newContext({ locale: "zh-CN", reducedMotion: "reduce", viewport: { width: 1200, height: 900 },
    extraHTTPHeaders: { "cf-access-jwt-assertion": jwt } });
  const matrixRequests: string[] = [], scripts: string[] = [];
  // Any Matrix request fails the test (and is never answered).
  await browser.route(/\/_matrix\//, (route) => { matrixRequests.push(route.request().url()); return route.abort(); });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname); });
  await page.goto(f.base);
  page.setDefaultTimeout(10_000);
  // No login page: the console starts from the Access session, and chats come from the ledger.
  await page.getByRole("button", { name: "对话", exact: true }).click();
  // The employee is in the header row before any chat exists; a click opens the DM.
  await page.locator(`.mau-chip[data-chat-key="agent:${f.agent.id}"]`).click();
  const composer = page.getByPlaceholder("发送消息…");
  await see(composer).toBeEnabled();
  await composer.fill("没有 Matrix 也能聊");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await see(page.locator(".thread-md-p", { hasText: "收到-1" })).toBeVisible();
  // Matrix wording is hidden: no Matrix connector, no Matrix channel to connect.
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("dialog", { name: "设置" }).getByRole("button", { name: "消息渠道", exact: true }).click();
  await see(page.getByRole("button", { name: "连接飞书", exact: true })).toBeVisible();
  await see(page.getByText("Matrix", { exact: true })).toHaveCount(0);
  expect(matrixRequests).toEqual([]);
  // Feature detection fails (Router restarting, network): a retry, never another console or a login form.
  const detection = await browser.newPage();
  let down = true;
  detection.on("request", (request) => { if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname); });
  await detection.route(/\/web\/me$/, (route) => down ? route.abort() : route.continue());
  await detection.goto(f.base);
  await detection.getByRole("button", { name: "对话", exact: true }).click();
  const retry = detection.getByRole("alert").getByRole("button", { name: "重试", exact: true });
  await see(retry).toBeVisible();
  down = false;
  await retry.click();
  await see(detection.locator(".thread-md-p", { hasText: "收到-1" })).toBeVisible();
  // `/_mau/v1/info` itself fails: the console offers a retry, never a login form.
  const boot = await browser.newPage();
  boot.on("request", (request) => { if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname); });
  await boot.route(/\/_mau\/v1\/info$/, (route) => route.abort());
  await boot.goto(f.base);
  await see(boot.getByRole("alert").getByRole("button", { name: "重试", exact: true })).toBeVisible();
  await see(boot.getByLabel("密码")).toHaveCount(0);
  expect(matrixRequests).toEqual([]);
  expect(scripts.filter((path) => /\/(matrix-login|login)-[^/]*\.js$/.test(path))).toEqual([]);
  expect(errors).toEqual([]);
}, 90_000);
