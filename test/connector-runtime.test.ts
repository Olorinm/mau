import { afterEach, expect, it, vi } from "vitest";
import { ConnectorRuntime } from "../src/connector-runtime.js";
import { DurableStore } from "../src/store.js";
import { loadConfig, startConfigured } from "@olorinm/agent-connectors";
vi.mock("@olorinm/agent-connectors", async original => ({ ...await original<object>(), loadConfig: vi.fn(), startConfigured: vi.fn() }));
const stores: DurableStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); vi.resetAllMocks(); });
async function fixture() {
  const store = new DurableStore(":memory:", "fixture"); stores.push(store);
  const callback = vi.fn(async () => {}), close = vi.fn(async () => {});
  vi.mocked(loadConfig).mockReturnValue({ listen: { host: "127.0.0.1", port: 18100 }, oauthRedirectUrl: "https://mau.example/oauth/callback" } as any);
  vi.mocked(startConfigured).mockResolvedValue({ url: "http://127.0.0.1:18100", service: { oauthCallback: callback }, close } as any);
  const runtime = new ConnectorRuntime("fixture.json", "http://127.0.0.1:18100", "https://mau.example", store);
  const res = { cookie: vi.fn(), clearCookie: vi.fn(), redirect: vi.fn(), set: vi.fn() };
  await runtime.start();
  const bind = (state = "fixture-state") => {
    runtime.bind("https://accounts.google.com/auth?state=" + state, res as any);
    const [name, value, options] = res.cookie.mock.calls.at(-1)!;
    expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/oauth/callback" });
    return name + "=" + value;
  };
  const req = (query: string, cookie?: string) => ({ originalUrl: "/oauth/callback?" + query, headers: { ...(cookie ? { cookie } : {}) } }) as any;
  return { runtime, callback, close, store, bind, req, res };
}
it("binds consent to its initiating browser, consumes it once and redirects without leaking the code", async () => {
  const f = await fixture(), cookie = f.bind();
  await expect(f.runtime.callback(f.req("state=fixture-state&code=private-code"), f.res as any)).rejects.toThrow("oauth_browser_mismatch_or_expired");
  expect(f.callback).not.toHaveBeenCalled();
  await f.runtime.callback(f.req("state=fixture-state&code=private-code", cookie), f.res as any);
  expect(f.callback).toHaveBeenCalledWith("fixture-state", "private-code", expect.any(AbortSignal));
  expect(f.res.redirect).toHaveBeenCalledWith(303, "/?view=connectors&oauth=connected");
  expect(JSON.stringify(f.res.redirect.mock.calls)).not.toContain("private-code");
  await expect(f.runtime.callback(f.req("state=fixture-state&code=replay", cookie), f.res as any)).rejects.toThrow("oauth_browser_mismatch_or_expired");
  await f.runtime.close(); expect(f.close).toHaveBeenCalledOnce();
});
it("refuses malformed queries, Origin, expired or duplicate cookies, and does not replay failed exchanges", async () => {
  const f = await fixture(), cookie = f.bind();
  for (const query of ["code=x", "state=x&state=y&code=x", "state=x&code=x&code=y", "state=x", "state=x&code=x&error=denied"])
    await expect(f.runtime.callback(f.req(query, cookie), f.res as any)).rejects.toThrow("oauth_callback_invalid");
  const request = f.req("state=fixture-state&code=x", cookie); request.headers.origin = "https://evil.example";
  await expect(f.runtime.callback(request, f.res as any)).rejects.toThrow("oauth_origin_refused");
  await expect(f.runtime.callback(f.req("state=fixture-state&code=x", cookie + "; " + cookie), f.res as any)).rejects.toThrow("oauth_browser_mismatch_or_expired");
  const entry = f.store.entries<any>("connector_oauth")[0]!; f.store.set("connector_oauth", entry.id, { ...entry.value, expires: 0 });
  await expect(f.runtime.callback(f.req("state=fixture-state&code=x", cookie), f.res as any)).rejects.toThrow("oauth_browser_mismatch_or_expired");
  const fresh = f.bind(); f.callback.mockRejectedValueOnce(new Error("provider-secret"));
  await f.runtime.callback(f.req("state=fixture-state&code=x", fresh), f.res as any);
  expect(f.res.redirect).toHaveBeenLastCalledWith(303, "/?view=connectors&oauth=failed");
  expect(f.callback).toHaveBeenCalledOnce();
});
it("handles owner cancellation and refuses a runtime at a different endpoint or callback", async () => {
  const f = await fixture(), cookie = f.bind();
  await f.runtime.callback(f.req("state=fixture-state&error=access_denied", cookie), f.res as any);
  expect(f.callback).toHaveBeenCalledWith("fixture-state", undefined, expect.any(AbortSignal));
  expect(f.res.redirect).toHaveBeenLastCalledWith(303, "/?view=connectors&oauth=cancelled");
  await f.runtime.close();
  for (const config of [{ listen: { host: "0.0.0.0", port: 18100 } }, { listen: { host: "127.0.0.1", port: 18101 } },
    { listen: { host: "127.0.0.1", port: 18100 }, oauthRedirectUrl: "https://evil.example/oauth/callback" }]) {
    vi.mocked(loadConfig).mockReturnValue(config as any);
    await expect(f.runtime.start()).rejects.toThrow("connector_runtime_configuration_mismatch");
  }
});
