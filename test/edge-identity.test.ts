import { afterEach, expect, it } from "vitest";
import { connectSshTunnel } from "../src/ssh-transport.js";
import { alice, mauFixture } from "./fixtures/mau.js";
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function accessFixture() {
  const f = await mauFixture(cleanup);
  const jwt = f.access.jwt;
  const call = async (path: string, headers: Record<string, string>, body?: unknown) => {
    const response = await fetch(f.base + path, { headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any };
  };
  return { f, jwt, call };
}

it("authenticates /_mau/v1, Router owner routes and the SSH upgrade with the Access JWT", async () => {
  const { f, jwt, call } = await accessFixture();
  expect((await call("/_mau/v1/info", {})).data).toEqual({ login: "edge", logoutUrl: "/cdn-cgi/access/logout" });
  const edge = { "cf-access-jwt-assertion": jwt() };
  expect(await call("/_mau/v1/account", edge)).toMatchObject({ status: 200,
    data: { owner: alice, via: "edge", email: "alice@example.test", person: { name: "alice" } } });
  expect((await call("/_mau/v1/agents", edge)).data.data.map((item: any) => item.agent.id)).toEqual([f.agent.id]);
  expect((await call("/_agent-router/v1/agents", edge)).data.data.map((agent: any) => agent.id)).toEqual([f.agent.id]);
  expect(await call("/_mau/v1/account", { "cf-access-jwt-assertion": jwt({ email: "stranger@example.test" }) }))
    .toEqual({ status: 403, data: { error: "owner_not_configured", email: "stranger@example.test" } });
  // A bad JWT never falls back to the bearer; the plain email header is never trusted.
  expect(await call("/_mau/v1/account", { "cf-access-jwt-assertion": jwt({ aud: ["other"] }), authorization: "Bearer alice" }))
    .toEqual({ status: 401, data: { error: "edge_identity_invalid" } });
  expect((await call("/_mau/v1/account", { "cf-access-authenticated-user-email": "alice@example.test" })).status).toBe(401);
  // Unsafe edge requests need the console's own origin (Cloudflare adds the JWT to cross-site requests too).
  for (const headers of [{ origin: "https://evil.example.test" }, {}])
    expect(await call("/_mau/v1/proactive", { ...edge, ...headers }, { name: "x" })).toEqual({ status: 403, data: { error: "origin_not_allowed" } });
  expect((await call("/_mau/v1/proactive", { ...edge, origin: f.base }, {})).status).toBe(400);
  // Bearer callers still work alongside.
  expect((await call("/_mau/v1/account", { authorization: "Bearer alice" })).data).toMatchObject({ owner: alice, via: "bearer" });
  const ssh = new URL(`${f.base}/_mau/v1/agents/00000000-0000-4000-8000-000000000000/ssh/${"a".repeat(64)}`);
  await expect(connectSshTunnel(ssh, { "cf-access-jwt-assertion": jwt({ aud: ["other"] }) })).rejects.toThrow("account_session_invalid");
  // Authenticated: the request gets past the owner check and fails on the unknown Agent instead.
  await expect(connectSshTunnel(ssh, edge)).rejects.toThrow("ssh_connection_rejected");
});
