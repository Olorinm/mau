import { afterEach, expect, it } from "vitest";
import { request } from "node:http";
import { connectSshTunnel, sshUpgrade } from "../src/ssh-transport.js";
import { accessAudience, accessTeam } from "./fixtures/access.js";
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

it("holds an Access service token to reading: no write under /_mau/v1 and no SSH tunnel, unless it has owner access", async () => {
  const f = await mauFixture(cleanup, {}, { edgeIdentity: { provider: "cloudflare-access", teamDomain: accessTeam, audiences: [accessAudience],
    owners: { "alice@example.test": alice }, serviceTokens: { "ops.access": alice, "full.access": { owner: alice, access: "owner" } } } });
  const token = (common_name: string) => ({ "cf-access-jwt-assertion": f.access.jwt({ email: undefined, sub: "", common_name }), origin: f.base });
  const operator = token("ops.access"), full = token("full.access"), human = { "cf-access-jwt-assertion": f.access.jwt(), origin: f.base };
  const call = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
    const response = await fetch(f.base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json().catch(() => undefined) as any };
  };
  expect(await call("GET", "/_mau/v1/account", operator)).toMatchObject({ status: 200, data: { owner: alice, via: "edge-service" } });
  expect((await call("GET", "/_mau/v1/agents", operator)).data.data.map((item: any) => item.agent.id)).toEqual([f.agent.id]);
  expect((await call("GET", `/_mau/v1/agents/${f.agent.id}/environment`, operator)).status).toBe(200);
  expect((await call("GET", "/_mau/v1/connector-accounts", operator)).data.error).not.toBe("owner_sign_in_required");
  expect((await call("POST", "/_agent-router/v1/web/socket-tickets", operator, {})).status).toBe(200);
  const agent = `/_mau/v1/agents/${f.agent.id}`;
  // The last member is the scope the answer names: what an access token would need, for a route of Mau's that has one.
  const writes: Array<[string, string, unknown, string?]> = [["POST", "/_mau/v1/agents", { name: "other" }, "manage"], ["DELETE", agent, undefined, "manage"], ["POST", agent + "/environment", { profileId: "cloud" }, "manage"],
    ["POST", agent + "/environment/destroy", {}, "manage"], ["POST", agent + "/memory", {}, "manage"], ["PUT", agent + "/model-settings", {}, "manage"], ["PUT", agent + "/instructions", {}],
    ["POST", "/_mau/v1/proactive", {}, "manage"], ["PUT", "/_mau/v1/connector-accounts/account/policy", {}], ["POST", "/_mau/v1/connector-accounts", {}],
    ["POST", "/_agent-router/v1/web/identities/pairing-codes", {}], ["POST", "/_agent-router/v1/web/chats/chat/cards/card/answer", {}], ["POST", "/_agent-router/v1/web/chats/chat/purge", {}],
    ["DELETE", `/_agent-router/v1/agents/${f.agent.id}`, undefined]];
  for (const [method, path, body, scope] of writes) expect(await call(method, path, operator, body), `${method} ${path}`)
    .toEqual({ status: 403, data: { error: "owner_sign_in_required", ...(scope ? { scope } : {}) } });
  // The same requests from the owner and from a token with owner access get past the sign-in check.
  for (const headers of [human, full]) for (const [method, path, body] of writes.slice(-8, -1))
    expect((await call(method, path, headers, body)).data?.error, `${method} ${path}`).not.toBe("owner_sign_in_required");
  const upgrade = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const req = request(`${f.base}${agent}/ssh/${"a".repeat(64)}`, { headers: { "cf-access-jwt-assertion": headers["cf-access-jwt-assertion"]!, Connection: "Upgrade", Upgrade: sshUpgrade } });
    req.once("response", (response) => { response.resume(); resolve(response.statusCode ?? 0); }); req.once("upgrade", (response, socket) => { socket.destroy(); resolve(response.statusCode ?? 0); });
    req.once("error", reject); req.end();
  });
  expect(await upgrade(operator)).toBe(403);
  expect(await upgrade(human)).not.toBe(403);
  expect((await call("GET", "/_mau/v1/agents", human)).data.data.map((item: any) => item.agent.id)).toEqual([f.agent.id]);
}, 60_000);
