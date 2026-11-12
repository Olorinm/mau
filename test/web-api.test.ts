import { afterEach, expect, it, vi } from "vitest";
import { ApiError, accessExpiredEvent, request, safeExternalUrl } from "../web/src/api/http.js";
import { bootSession, logout, reloadDrafts, saveReloadDrafts } from "../web/src/api/session.js";
import { mauApi, routerApi } from "../web/src/api/client.js";
import { errorMessage, translator } from "../web/src/i18n.js";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  get size() { return this.values.size; }
}
type Call = { url: string; method: string; headers: Headers; body: unknown };
function stubFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const call = { url, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return respond(call);
  });
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); });

it("bounds stalled requests and preserves caller cancellation", async () => {
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  await expect(request("/stalled", { timeoutMs: 10 })).rejects.toMatchObject({ code: "request_timeout" });
  const controller = new AbortController();
  const response = request("/cancelled", { signal: controller.signal });
  controller.abort(new Error("navigation_cancelled"));
  await expect(response).rejects.toThrow("navigation_cancelled");
});

it("requests carry a given bearer and map Mau and Router failures to stable codes; a foreign errcode is not a code", async () => {
  const calls = stubFetch((call) =>
    call.url.endsWith("/mau") ? Response.json({ error: "environment_operation_running" }, { status: 409 })
      : call.url.endsWith("/foreign") ? Response.json({ errcode: "M_FORBIDDEN", error: "Invalid password" }, { status: 403 })
        : call.url.endsWith("/limited") ? new Response("Too many requests", { status: 429 })
          : call.url.endsWith("/odd") ? Response.json({ error: "<script>" }, { status: 500 })
            : call.url.endsWith("/empty") ? new Response(null, { status: 204 })
              : Response.json({ ok: true }));
  await expect(request("/ok", { token: "secret", body: { a: 1 } })).resolves.toEqual({ ok: true });
  expect(calls[0]).toMatchObject({ method: "POST", body: { a: 1 } });
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer secret");
  expect(calls[0]!.headers.get("content-type")).toBe("application/json");
  for (const [path, code, status] of [["/mau", "environment_operation_running", 409], ["/foreign", "request_failed", 403],
    ["/limited", "rate_limited", 429], ["/odd", "request_failed", 500]] as const)
    await expect(request(path)).rejects.toEqual(new ApiError(code, status));
  await expect(request("/empty", { body: {} })).resolves.toBeNull();
  vi.stubGlobal("fetch", async () => { throw new TypeError("offline"); });
  await expect(request("/ok")).rejects.toMatchObject({ code: "network_error", status: 0 });
});

it("only https links are rendered or opened", () => {
  expect(safeExternalUrl("https://open.feishu.cn/qr?x=1")).toBe("https://open.feishu.cn/qr?x=1");
  for (const url of ["http://example.test", "javascript:alert(1)", "https://example.test/\u0007", "not a url", undefined])
    expect(safeExternalUrl(url)).toBeUndefined();
});

it("client paths encode agent and job IDs and send the documented bodies", async () => {
  const calls = stubFetch((call) => call.url.endsWith("/pairing") ? new Response(null, { status: 204 }) : Response.json({ data: [], checks: [] }));
  const mau = mauApi("t"), router = routerApi("t");
  await mau.environmentAction("a/b", "pause");
  await mau.createAgent("helper", "cloud");
  await router.connect("a/b", { kind: "feishu", domain: "lark" });
  await router.pair("a/b", "job 1", "123456");
  await router.check("a/b");
  expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
    ["POST", "/_mau/v1/agents/a%2Fb/environment/pause", {}],
    ["POST", "/_mau/v1/agents", { name: "helper", profileId: "cloud" }],
    ["POST", "/_agent-router/v1/agents/a%2Fb/connections", { kind: "feishu", domain: "lark" }],
    ["POST", "/_agent-router/v1/agents/a%2Fb/connection-jobs/job%201/pairing", { code: "123456" }],
    ["POST", "/_agent-router/v1/agents/a%2Fb/check", {}],
  ]);
});

it("edge login boots without a login page, token or stored session; sign-out goes to the Access logout URL", async () => {
  const storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  const seen: Array<{ url: string; authorization: string | null; credentials: RequestCredentials | undefined }> = [];
  let info: unknown = { login: "edge", logoutUrl: "/cdn-cgi/access/logout" };
  let account: () => Response = () => Response.json({ owner: "@alice:agents.example", via: "edge", email: "alice@example.test", expiresAt: "2026-11-06T10:00:00.000Z" });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    seen.push({ url, authorization: new Headers(init.headers).get("authorization"), credentials: init.credentials });
    return url === "/_mau/v1/info" ? Response.json(info) : account();
  });
  const boot = await bootSession();
  expect(boot).toEqual({ mode: "edge", session: { token: "", owner: "@alice:agents.example",
    edge: { logoutUrl: "/cdn-cgi/access/logout", email: "alice@example.test", expiresAt: "2026-11-06T10:00:00.000Z" } } });
  expect(seen).toEqual([{ url: "/_mau/v1/info", authorization: null, credentials: "same-origin" },
    { url: "/_mau/v1/account", authorization: null, credentials: "same-origin" }]);
  // Nothing is kept in the browser: the session lives in the Access cookie only.
  expect(storage.size).toBe(0);
  // Sign-out is a navigation to the logout URL, with no request of its own.
  const visited: string[] = [];
  vi.stubGlobal("location", { assign: (url: string) => { visited.push(url); } });
  if (boot.mode !== "edge") throw new Error("edge_boot_expected");
  logout(boot.session);
  expect(visited).toEqual(["/cdn-cgi/access/logout"]);
  expect(seen).toHaveLength(2);
  // Only a same-origin path is followed for the logout.
  for (const logoutUrl of ["https://evil.example/logout", "//evil.example/logout", undefined]) {
    info = { login: "edge", logoutUrl };
    expect(await bootSession()).toMatchObject({ mode: "edge", session: { edge: { logoutUrl: "/cdn-cgi/access/logout" } } });
  }
  info = { login: "edge", logoutUrl: "/cdn-cgi/access/logout" };
  account = () => Response.json({ error: "owner_not_configured", email: "stranger@example.test" }, { status: 403 });
  expect(await bootSession()).toEqual({ mode: "edge-denied", email: "stranger@example.test", logoutUrl: "/cdn-cgi/access/logout" });
  account = () => new Response(null, { status: 302, headers: { Location: "https://example-team.cloudflareaccess.com/" } });
  const events: string[] = [];
  vi.stubGlobal("dispatchEvent", (event: Event) => { events.push(event.type); return true; });
  expect(await bootSession()).toEqual({ mode: "edge-failed", code: "access_session_expired" });
  expect(events).toEqual([accessExpiredEvent]);
});

it("a service without edge login has no web login: the boot fails with web_login_unavailable and asks for nothing else", async () => {
  const storage = new MemoryStorage();
  // A session an older console stored is never read or used.
  storage.setItem("mau.session", JSON.stringify({ token: "kept", owner: "@alice:agents.example" }));
  vi.stubGlobal("localStorage", storage);
  for (const info of [{ login: "other" }, {}]) {
    const calls = stubFetch(() => Response.json(info));
    expect(await bootSession()).toEqual({ mode: "edge-failed", code: "web_login_unavailable" });
    expect(calls.map((call) => [call.url, call.headers.get("authorization")])).toEqual([["/_mau/v1/info", null]]);
  }
  for (const language of ["zh-CN", "en"] as const) {
    const message = errorMessage(translator(language), "web_login_unavailable");
    expect(message).toContain("Cloudflare Access");
    expect(message).not.toContain("web_login_unavailable");
  }
  expect(errorMessage(translator("zh-CN"), "web_login_unavailable")).toBe("这个服务没有开启网页登录。请为它配置边缘身份（例如 Cloudflare Access）后再打开控制台。");
});

it("a failed /info offers a retry code and never falls back to a login or a stored session", async () => {
  const storage = new MemoryStorage();
  storage.setItem("mau.session", JSON.stringify({ token: "stale", owner: "@alice:agents.example" }));
  vi.stubGlobal("localStorage", storage);
  const urls: string[] = [];
  const failing = (respond: () => Promise<Response>) => vi.stubGlobal("fetch", async (url: string) => { urls.push(url); return respond(); });
  failing(async () => { throw new TypeError("fetch failed"); });
  expect(await bootSession()).toEqual({ mode: "edge-failed", code: "network_error" });
  failing(async () => new Response("bad gateway", { status: 502 }));
  expect(await bootSession()).toEqual({ mode: "edge-failed", code: "request_failed" });
  vi.stubGlobal("dispatchEvent", () => true);
  failing(async () => new Response(null, { status: 302, headers: { Location: "https://example-team.cloudflareaccess.com/" } }));
  expect(await bootSession()).toEqual({ mode: "edge-failed", code: "access_session_expired" });
  // Only /info was asked each time: no account read, no other origin.
  expect(urls).toEqual(["/_mau/v1/info", "/_mau/v1/info", "/_mau/v1/info"]);
});

it("keeps unsent composer text across the Access re-login reload", () => {
  const storage = new MemoryStorage() as unknown as Storage;
  saveReloadDrafts({ "dm:a": "half a thought", "dm:b": "  " }, storage);
  expect(reloadDrafts(storage)).toEqual({ "dm:a": "half a thought" });
  expect(reloadDrafts(storage, true)).toEqual({ "dm:a": "half a thought" });
  expect(reloadDrafts(storage)).toEqual({});
});

it("frames only a Cloudflare live-view link from a handoff card", async () => {
  const { liveViewUrl } = await import("../web/src/screens/side-views.js");
  const url = "https://live.browser.run/ui/view?mode=tab&wss=live.browser.run/api/devtools/browser/s/page/t?jwt=abc.def";
  expect(liveViewUrl(`浏览器已交给你接管。请在此私密链接中操作，不要转发：\n${url}\n完成后点页面里的 Done。`)).toBe(url);
  expect(liveViewUrl("see https://live.browser.run.evil.example/ui/view?x=1")).toBeUndefined();
  expect(liveViewUrl("see https://example.test/ui/view and http://live.browser.run/ui/view")).toBeUndefined();
  expect(liveViewUrl(undefined)).toBeUndefined();
});
