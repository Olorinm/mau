import { afterEach, expect, it, vi } from "vitest";
import { ApiError, request, safeExternalUrl } from "../web/src/api/http.js";
import { clearSession, loadSession, loginWithPassword, loginWithToken, logout, saveSession } from "../web/src/api/session.js";
import { mauApi, routerApi } from "../web/src/api/client.js";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
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

it("requests carry the account bearer and map Mau, Router and Matrix failures to stable codes", async () => {
  const calls = stubFetch((call) =>
    call.url.endsWith("/mau") ? Response.json({ error: "environment_operation_running" }, { status: 409 })
      : call.url.endsWith("/matrix") ? Response.json({ errcode: "M_FORBIDDEN", error: "Invalid password" }, { status: 403 })
        : call.url.endsWith("/limited") ? new Response("Too many requests", { status: 429 })
          : call.url.endsWith("/odd") ? Response.json({ error: "<script>" }, { status: 500 })
            : call.url.endsWith("/empty") ? new Response(null, { status: 204 })
              : Response.json({ ok: true }));
  await expect(request("/ok", { token: "secret", body: { a: 1 } })).resolves.toEqual({ ok: true });
  expect(calls[0]).toMatchObject({ method: "POST", body: { a: 1 } });
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer secret");
  expect(calls[0]!.headers.get("content-type")).toBe("application/json");
  for (const [path, code, status] of [["/mau", "environment_operation_running", 409], ["/matrix", "M_FORBIDDEN", 403],
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

it("password login follows mau login: public homeserver, Matrix login, then Mau account", async () => {
  const calls = stubFetch((call) =>
    call.url === "/_mau/v1/info" ? Response.json({ homeserver: "https://matrix.example/" })
      : call.url === "https://matrix.example/_matrix/client/v3/login" ? Response.json({ access_token: "token-1" })
        : Response.json({ owner: "@alice:agents.example" }));
  const session = await loginWithPassword(" alice ", "pw");
  expect(session).toEqual({ token: "token-1", owner: "@alice:agents.example", homeserver: "https://matrix.example" });
  expect(calls.map((c) => c.url)).toEqual(["/_mau/v1/info", "https://matrix.example/_matrix/client/v3/login", "/_mau/v1/account"]);
  expect(calls[1]!.body).toEqual({ type: "m.login.password", identifier: { type: "m.id.user", user: "alice" },
    password: "pw", initial_device_display_name: "Mau Web" });
  expect(calls[1]!.headers.get("authorization")).toBeNull();
  expect(calls[2]!.headers.get("authorization")).toBe("Bearer token-1");
});

it("token login verifies the account; logout revokes only devices created by password login", async () => {
  const storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  const calls = stubFetch(() => Response.json({ owner: "@alice:agents.example" }));
  const pasted = await loginWithToken("  pasted  ");
  expect(pasted).toEqual({ token: "pasted", owner: "@alice:agents.example" });
  saveSession(pasted);
  expect(loadSession()).toEqual(pasted);
  await logout(pasted);
  expect(calls).toHaveLength(1);
  expect(loadSession()).toBeNull();
  saveSession({ ...pasted, homeserver: "https://matrix.example" });
  await logout({ ...pasted, homeserver: "https://matrix.example" });
  expect(calls[1]).toMatchObject({ url: "https://matrix.example/_matrix/client/v3/logout", method: "POST" });
  expect(calls[1]!.headers.get("authorization")).toBe("Bearer pasted");
  expect(loadSession()).toBeNull();
  storage.setItem("mau.session", "{not json");
  expect(loadSession()).toBeNull();
  clearSession();
});

it("client paths encode agent and job IDs and send the documented bodies", async () => {
  const calls = stubFetch((call) => call.url.endsWith("/pairing") ? new Response(null, { status: 204 }) : Response.json({ data: [], checks: [] }));
  const mau = mauApi("t"), router = routerApi("t");
  await mau.environmentAction("a/b", "pause");
  await mau.createAgent("helper", "cloud");
  await router.connect("a/b", { kind: "feishu", domain: "lark", personalTools: false });
  await router.pair("a/b", "job 1", "123456");
  await router.check("a/b");
  expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
    ["POST", "/_mau/v1/agents/a%2Fb/environment/pause", {}],
    ["POST", "/_mau/v1/agents", { name: "helper", profileId: "cloud" }],
    ["POST", "/_agent-router/v1/agents/a%2Fb/connections", { kind: "feishu", domain: "lark", personalTools: false }],
    ["POST", "/_agent-router/v1/agents/a%2Fb/connection-jobs/job%201/pairing", { code: "123456" }],
    ["POST", "/_agent-router/v1/agents/a%2Fb/check", {}],
  ]);
});
