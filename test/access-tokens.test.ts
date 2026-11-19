// Access tokens: what lets an Access service token of the owner do more than read. Owner and service-token requests
// are made with the fixture's stand-in for Cloudflare Access against the real embedded Router.
import { afterEach, expect, it, vi } from "vitest";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMau } from "../src/app.js";
import { AccessTokens } from "../src/access-tokens.js";
import { localLogin } from "../src/local-login.js";
import { sshUpgrade } from "../src/ssh-transport.js";
import { DurableStore } from "../src/store.js";
import { accessAudience, accessTeam } from "./fixtures/access.js";
import { aliceToken, builtCli, edgeProxy } from "./fixtures/edge.js";
import { alice, bob, mauFixture } from "./fixtures/mau.js";
import { partnersFixture } from "./fixtures/partners.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });

const edgeIdentity = { provider: "cloudflare-access", teamDomain: accessTeam, audiences: [accessAudience], owners: { "alice@example.test": alice, "bob@example.test": bob },
  serviceTokens: { "ops.alice": alice, "ops.bob": bob, "full.alice": { owner: alice, access: "owner" } } };
const refused = { status: 403, data: { error: "owner_sign_in_required" } };
const tokenFormat = /^mau_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/;
type Headers = Record<string, string>;

/** Requests as the owner (email sign-in) and as service tokens, with the path sent exactly as written. */
function callers(f: { base: string; access: { jwt(claims?: Record<string, unknown>): string } }) {
  const send = (method: string, path: string, headers: Headers, body?: unknown) => new Promise<{ status: number; data: any; headers: Record<string, unknown> }>((resolve, reject) => {
    const text = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = request(f.base, { method, path, headers: { ...(text === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }), ...headers } }, response => {
      let received = "";
      response.setEncoding("utf8").on("data", chunk => { received += chunk; }).on("end", () => {
        let data: unknown; try { data = JSON.parse(received); } catch { data = undefined; }
        resolve({ status: response.statusCode ?? 0, data, headers: response.headers });
      });
    });
    req.once("error", reject); req.end(text);
  });
  const call = async (method: string, path: string, headers: Headers, body?: unknown) => { const { status, data } = await send(method, path, headers, body); return { status, data }; };
  const service = (commonName: string, token?: string): Headers => ({ "cf-access-jwt-assertion": f.access.jwt({ email: undefined, sub: "", common_name: commonName }), origin: f.base,
    ...(token === undefined ? {} : { "mau-token": token }) });
  const human = (email = "alice@example.test"): Headers => ({ "cf-access-jwt-assertion": f.access.jwt({ email }), origin: f.base });
  const mint = async (scopes: string[], name = scopes.join("+"), owner = human(), extra: Record<string, unknown> = {}) => {
    const created = await call("POST", "/_mau/v1/tokens", owner, { name, scopes, ...extra });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    return created.data as { id: string; token: string; name: string; scopes: string[]; createdAt: string; expiresAt: string };
  };
  /** The HTTP status that answers an attempt to open the SSH tunnel. */
  const upgrade = (path: string, headers: Headers) => new Promise<number>((resolve, reject) => {
    const { origin: _origin, ...sent } = headers;
    const req = request(f.base, { path, headers: { ...sent, Connection: "Upgrade", Upgrade: sshUpgrade } });
    req.once("response", response => { response.resume(); resolve(response.statusCode ?? 0); });
    req.once("upgrade", (response, socket) => { socket.destroy(); resolve(response.statusCode ?? 0); });
    req.once("error", reject); req.end();
  });
  return { call, send, service, human, mint, upgrade };
}
const past = (answer: { status: number; data: any }) => answer.status !== 401 && answer.status !== 403 && answer.data?.error !== "owner_sign_in_required";

it("allows a service token exactly what the scopes of its access token cover, and never the owner's own routes", async () => {
  const f = await partnersFixture(cleanup, { mau: { edgeIdentity } }), { call, service, human, mint, upgrade } = callers(f);
  const agent = `/_mau/v1/agents/${f.agent.id}`, chat = `/_agent-router/v1/web/chats/${encodeURIComponent(f.chat(f.agent.id))}`, tunnel = `${agent}/ssh/${"a".repeat(64)}`;
  const partner = ["POST", "/_mau/v1/agents", { name: "mate", shareWith: f.agent.id }] as const, dismiss = ["POST", agent + "/dismiss", {}] as const;
  const approveMemory = ["POST", agent + "/memory/pending/p1/approve", {}] as const, answer = ["POST", chat + "/cards/c1/answer", { choiceId: "0", idempotencyKey: "k".repeat(20) }] as const;
  const reset = ["POST", chat + "/reset", { idempotencyKey: "r".repeat(20) }] as const, message = ["POST", chat + "/messages", { text: "hello", idempotencyKey: "m".repeat(20) }] as const;
  const needs = (scope: string) => ({ status: 403, data: { error: "owner_sign_in_required", scope } });

  // Without an access token nothing has changed: reads and the operator's own writes work, everything else is refused.
  const bare = service("ops.alice");
  expect((await call("GET", "/_mau/v1/agents", bare)).status).toBe(200);
  expect((await call("POST", "/_agent-router/v1/web/socket-tickets", bare, {})).status).toBe(200);
  expect(await call(...partner.slice(0, 2) as [string, string], bare, partner[2])).toEqual(needs("manage"));
  expect(await call(dismiss[0], dismiss[1], bare, dismiss[2])).toEqual(needs("manage"));
  expect(await call(approveMemory[0], approveMemory[1], bare, approveMemory[2])).toEqual(needs("approve"));
  expect(await call("DELETE", agent, bare)).toEqual(needs("manage"));
  // Router answers for its own routes, without the scope.
  for (const [method, path, body] of [answer, reset]) expect(await call(method, path, bare, body), path).toEqual(refused);
  expect(await upgrade(tunnel, bare)).toBe(403);
  expect((await call("GET", "/_mau/v1/account", bare)).data).toEqual(expect.not.objectContaining({ token: expect.anything() }));

  // chat: conversations, and nothing that decides or manages.
  const chatToken = await mint(["chat"]), chats = service("ops.alice", chatToken.token);
  expect(chatToken).toMatchObject({ name: "chat", scopes: ["chat"], token: expect.stringMatching(tokenFormat) });
  const sent = await call(message[0], message[1], chats, message[2]);
  expect(sent.status, JSON.stringify(sent.data)).toBeLessThan(300);
  await f.until(async () => (await f.answers(f.agent.id)).length === 1, "answer");
  expect(past(await call(reset[0], reset[1], chats, reset[2]))).toBe(true);
  expect(await call(partner[0], partner[1], chats, partner[2])).toEqual(needs("manage"));
  expect(await call(dismiss[0], dismiss[1], chats, dismiss[2])).toEqual(needs("manage"));
  expect(await call(approveMemory[0], approveMemory[1], chats, approveMemory[2])).toEqual(needs("approve"));
  expect(await call(answer[0], answer[1], chats, answer[2])).toEqual(refused);
  expect(await upgrade(tunnel, chats)).toBe(403);
  expect((await call("GET", "/_mau/v1/account", chats)).data.token).toEqual({ id: chatToken.id, name: "chat", scopes: ["chat"], expiresAt: chatToken.expiresAt });

  // approve: the card answer and the pending memory change reach their handlers (which know no such card or change).
  const approver = service("ops.alice", (await mint(["approve"])).token);
  const answered = await call(answer[0], answer[1], approver, answer[2]);
  expect(past(answered), JSON.stringify(answered)).toBe(true);
  expect([404, 409]).toContain(answered.status);
  const approved = await call(approveMemory[0], approveMemory[1], approver, approveMemory[2]);
  expect(past(approved), JSON.stringify(approved)).toBe(true);
  expect(await call(partner[0], partner[1], approver, partner[2])).toEqual(needs("manage"));
  expect(await call(dismiss[0], dismiss[1], approver, dismiss[2])).toEqual(needs("manage"));
  expect(await call(reset[0], reset[1], approver, reset[2])).toEqual(refused);
  expect(await upgrade(tunnel, approver)).toBe(403);

  // manage: partners and what they have; not a card, not a pending approval.
  const managerToken = await mint(["manage"]), manager = service("ops.alice", managerToken.token);
  expect(await call(dismiss[0], dismiss[1], manager, dismiss[2])).toMatchObject({ status: 200, data: { dismissed: expect.any(String) } });
  expect(await call("POST", agent + "/restore", manager, {})).toMatchObject({ status: 200, data: { dismissed: null } });
  expect(await call(partner[0], partner[1], manager, partner[2])).toMatchObject({ status: 202, data: { agent: { name: "mate", owner: alice } } });
  expect(await call(answer[0], answer[1], manager, answer[2])).toEqual(refused);
  expect(await call(approveMemory[0], approveMemory[1], manager, approveMemory[2])).toEqual(needs("approve"));
  expect(await call(reset[0], reset[1], manager, reset[2])).toEqual(refused);
  // The SSH tunnel is an upgrade of a GET: it needs manage, and then fails on the key that was never registered.
  expect(await upgrade(tunnel, manager)).not.toBe(403);
  expect(await upgrade(tunnel + "/", manager)).not.toBe(101);
  expect(await upgrade("/_mau/v1/agents", manager)).not.toBe(101);

  // No scope reaches the access tokens, a purge or the identity routes: not one, not all of them.
  const all = await mint(["chat", "approve", "manage"], "everything"), everything = service("ops.alice", all.token);
  const owners: Array<[string, string, unknown?]> = [["GET", "/_mau/v1/tokens"], ["POST", "/_mau/v1/tokens", { name: "more", scopes: ["manage"] }], ["DELETE", `/_mau/v1/tokens/${all.id}`],
    ["DELETE", `/_mau/v1/tokens/${chatToken.id}`], ["POST", chat + "/purge", { confirm: true }], ["POST", "/_agent-router/v1/web/identities/pairing-codes", {}],
    ["DELETE", "/_agent-router/v1/web/identities/pairing-codes/code"], ["DELETE", "/_agent-router/v1/web/identities/identity"]];
  for (const headers of [everything, manager, chats, approver, bare])
    for (const [method, path, body] of owners) expect(await call(method, path, headers, body), `${method} ${path}`).toEqual(refused);
  // The owner, and a service token the operator gave owner access, are not held to any of this.
  const listed = await call("GET", "/_mau/v1/tokens", human());
  expect(listed.data.data.map((token: any) => token.name)).toEqual(["everything", "manage", "approve", "chat"]);
  expect((await call("GET", "/_mau/v1/tokens", service("full.alice"))).status).toBe(200);
  expect(JSON.stringify(listed.data)).not.toMatch(/mau_[0-9a-f]{16}_|hash|secret/);
  // A token is marked used when it allowed a request; the one that only ever was refused or shown is not.
  const used = Object.fromEntries(listed.data.data.map((token: any) => [token.name, token.lastUsedAt]));
  expect(used).toEqual({ everything: undefined, manage: expect.any(String), approve: expect.any(String), chat: expect.any(String) });
  expect(Date.now() - Date.parse(used.manage)).toBeLessThan(60_000);
}, 120_000);

it("refuses a token that is expired, revoked, another owner's or malformed, and ignores it for the owner's sign-in", async () => {
  const f = await mauFixture(cleanup, {}, { edgeIdentity }), { call, service, human, mint } = callers(f);
  const dismiss = `/_mau/v1/agents/${f.agent.id}/dismiss`, needs = { status: 403, data: { error: "owner_sign_in_required", scope: "manage" } };
  const works = async (headers: Headers) => (await call("POST", dismiss, headers, {})).status === 200;
  const token = await mint(["manage"], "agent");
  expect(await works(service("ops.alice", token.token))).toBe(true);

  // Another owner's service token gets nothing from alice's token, and bob's token nothing with alice's service token.
  expect(await call("POST", dismiss, service("ops.bob", token.token), {})).toEqual(needs);
  const bobs = await mint(["chat", "approve", "manage"], "bob", human("bob@example.test"));
  expect(await call("POST", dismiss, service("ops.alice", bobs.token), {})).toEqual(needs);
  expect((await call("GET", "/_mau/v1/account", service("ops.alice", bobs.token))).data.token).toBeUndefined();
  expect((await call("GET", "/_mau/v1/account", service("ops.bob", bobs.token))).data).toMatchObject({ owner: bob, via: "edge-service", token: { id: bobs.id, scopes: ["chat", "approve", "manage"] } });
  // The tokens of one owner are not the other's to see or revoke.
  expect((await call("GET", "/_mau/v1/tokens", human("bob@example.test"))).data.data.map((item: any) => item.id)).toEqual([bobs.id]);
  expect(await call("DELETE", `/_mau/v1/tokens/${token.id}`, human("bob@example.test"))).toEqual({ status: 404, data: { error: "token_not_found" } });
  expect(await call("DELETE", "/_mau/v1/tokens/0000000000000000", human())).toMatchObject({ status: 404, data: { error: "token_not_found" } });
  expect(await works(service("ops.alice", token.token))).toBe(true);

  // Nothing but the token as it was issued.
  const [, id, secret] = token.token.split(/^mau_([0-9a-f]{16})_/), other = await mint(["manage"], "other");
  // (Spaces around a header's value are not part of it, so they are not tried.)
  const malformed = ["", "x", token.token.slice(4), "MAU" + token.token.slice(3), "mau-" + token.token.slice(4), `mau_${"0".repeat(16)}_${secret}`, `mau_${other.id}_${secret}`,
    `mau_${id}_${secret!.slice(0, -1)}`, `mau_${id}_${secret!.slice(0, -1)}${secret!.at(-1) === "A" ? "B" : "A"}`, `mau_${id}_${"A".repeat(43)}`, `mau_${id}_`, `mau_${id}`, id!, secret!,
    token.token + "_extra", token.token + "A", `${token.token}_${secret}`, `${token.token} x`, `Bearer ${token.token}`, `${token.token}, ${token.token}`,
    `${token.token}, ${other.token}`, token.token.toUpperCase(), `mau_${id!.toUpperCase()}_${secret}`, `mau_${id}_${secret}=`, "mau_%_%", "mau_" + "a".repeat(10_000), token.token + "x".repeat(10_000)];
  expect((await call("POST", `/_mau/v1/agents/${f.agent.id}/restore`, human(), {})).status).toBe(200);
  for (const [index, value] of malformed.entries()) expect(await call("POST", dismiss, service("ops.alice", value), {}), `malformed token ${index}`).toEqual(needs);
  for (const [index, value] of malformed.entries()) expect((await call("GET", "/_mau/v1/account", service("ops.alice", value))).data.token, `malformed token ${index}`).toBeUndefined();
  expect((await call("GET", `/_mau/v1/agents/${f.agent.id}`, human())).data.dismissed).toBeNull();
  expect(await works(service("ops.alice", token.token))).toBe(true);

  // The owner's own sign-in neither needs nor reads the header: a token narrows nothing and a bad one breaks nothing.
  const chatOnly = await mint(["chat"], "chat-only");
  for (const value of [chatOnly.token, "nonsense", bobs.token, "x".repeat(10_000)]) {
    expect(await works({ ...human(), "mau-token": value })).toBe(true);
    const account = await call("GET", "/_mau/v1/account", { ...human(), "mau-token": value });
    expect(account.data).toMatchObject({ owner: alice, via: "edge" });
    expect(account.data.token).toBeUndefined();
  }
  // The same for a bearer sign-in and for a service token with owner access.
  expect((await call("GET", "/_mau/v1/account", { authorization: "Bearer alice", "mau-token": token.token })).data.token).toBeUndefined();
  expect((await call("GET", "/_mau/v1/account", service("full.alice", token.token))).data.token).toBeUndefined();
  expect(await works(service("full.alice", "nonsense"))).toBe(true);
  // A token alone is no sign-in at all.
  expect((await call("POST", dismiss, { "mau-token": token.token, origin: f.base }, {})).status).toBe(401);
  expect((await call("GET", "/_mau/v1/account", { "mau-token": token.token })).status).toBe(401);
  expect((await call("GET", "/_mau/v1/account", { authorization: `Bearer ${token.token}` })).status).toBe(401);

  // Revoked: it worked, the owner revokes it, and the very next request is refused. Revoking twice changes nothing.
  expect((await call("DELETE", `/_mau/v1/tokens/${token.id}`, human())).status).toBe(204);
  expect(await call("POST", dismiss, service("ops.alice", token.token), {})).toEqual(needs);
  expect((await call("GET", "/_mau/v1/account", service("ops.alice", token.token))).data.token).toBeUndefined();
  const revokedAt = (await call("GET", "/_mau/v1/tokens", human())).data.data.find((item: any) => item.id === token.id).revokedAt;
  expect(revokedAt).toEqual(expect.any(String));
  expect((await call("DELETE", `/_mau/v1/tokens/${token.id}`, human())).status).toBe(204);
  expect((await call("GET", "/_mau/v1/tokens", human())).data.data.find((item: any) => item.id === token.id).revokedAt).toBe(revokedAt);

  // Expired: the same token a moment before and a moment after its time.
  expect(await works(service("ops.alice", other.token))).toBe(true);
  const database = new DatabaseSync(join(f.directory, "business-tools.sqlite"));
  const expire = (at: number) => database.prepare("UPDATE documents SET value=json_set(value,'$.expiresAt',?) WHERE collection='access-tokens' AND id=?").run(new Date(at).toISOString(), other.id);
  expect(expire(Date.now() + 60_000).changes).toBe(1);
  expect(await works(service("ops.alice", other.token))).toBe(true);
  expire(Date.now() - 1);
  expect(await call("POST", dismiss, service("ops.alice", other.token), {})).toEqual(needs);
  expect((await call("GET", "/_mau/v1/account", service("ops.alice", other.token))).data.token).toBeUndefined();
  // A token whose expiry cannot be read does not work either.
  database.prepare("UPDATE documents SET value=json_set(value,'$.expiresAt','never') WHERE collection='access-tokens' AND id=?").run(other.id);
  expect(await call("POST", dismiss, service("ops.alice", other.token), {})).toEqual(needs);
  database.close();
}, 120_000);

it("never allows another spelling of a route under a weaker scope: each is the same route's scope or refused", async () => {
  const f = await mauFixture(cleanup, {}, { edgeIdentity }), { call, service, human, mint } = callers(f);
  const id = f.agent.id, agent = `/_mau/v1/agents/${id}`, chat = `/_agent-router/v1/web/chats/${encodeURIComponent(`dm:${id}`)}`;
  const weak = service("ops.alice", (await mint(["chat", "approve"], "weak")).token), manager = service("ops.alice", (await mint(["manage"])).token);
  const approver = service("ops.alice", (await mint(["approve"])).token);
  const dismissed = async () => (await call("GET", agent, human())).data.dismissed !== null;
  const restore = async () => { expect((await call("POST", agent + "/restore", human(), {})).status).toBe(200); };

  // A manage route in every spelling Express might serve: without manage it is refused in all of them.
  const spellings: Array<[string, string]> = [
    ["exact", agent + "/dismiss"], ["query", agent + "/dismiss?x=1"], ["query naming another route", agent + "/dismiss?/../memory/pending/p/approve"],
    ["empty query", agent + "/dismiss?"], ["trailing slash", agent + "/dismiss/"], ["upper-case segment", agent + "/DISMISS"], ["upper-case prefix", `/_MAU/V1/agents/${id}/dismiss`],
    ["double slash after the prefix", `/_mau/v1//agents/${id}/dismiss`], ["double slash inside", `${agent}//dismiss`], ["double slash before the prefix", `//_mau/v1/agents/${id}/dismiss`],
    ["encoded slash before the id", `/_mau/v1/agents%2F${id}/dismiss`], ["encoded slash after the id", `${agent}%2Fdismiss`], ["encoded letter", `${agent}/dismis%73`],
    ["dot segments", `/_mau/v1/agents/${id}/memory/pending/../../dismiss`], ["dot segment from an approve route", `${agent}/memory/pending/p/approve/../../../dismiss`],
    ["fragment-like", `${agent}/dismiss%23`], ["semicolon parameter", `${agent}/dismiss;x=1`], ["absolute form", `http://127.0.0.1${agent}/dismiss`]];
  for (const [name, path] of spellings) {
    const answer = await call("POST", path, weak, {});
    expect([403, 404], name).toContain(answer.status);
    expect(await dismissed(), name).toBe(false);
  }
  // With manage, a spelling is either the route itself or refused: only the exact path and its query forms work.
  const served: string[] = [];
  for (const [name, path] of spellings) {
    const answer = await call("POST", path, manager, {});
    if (await dismissed()) { expect(answer.status, name).toBe(200); served.push(name); await restore(); }
    else expect([403, 404], name).toContain(answer.status);
  }
  expect(served).toEqual(["exact", "query", "query naming another route", "empty query"]);
  // What Express would have served under another spelling is refused rather than guessed at.
  for (const name of ["trailing slash", "upper-case segment", "upper-case prefix"])
    expect(await call("POST", spellings.find(item => item[0] === name)![1], manager, {}), name).toEqual(refused);
  // The owner is served those spellings, which is why they must not be classified by a looser matcher.
  expect((await call("POST", agent + "/DISMISS/", human(), {})).status).toBe(200);
  await restore();

  // An approve token on spellings of manage and owner routes of Router, and of its own route.
  const answer = chat + "/cards/c1/answer", body = { choiceId: "0", idempotencyKey: "k".repeat(20) };
  expect(past(await call("POST", answer, approver, body))).toBe(true);
  expect(past(await call("POST", answer + "?x=1", approver, body))).toBe(true);
  for (const path of [answer + "/", chat + "/cards/c1/ANSWER", `/_agent-router/v1/WEB/chats/${encodeURIComponent(`dm:${id}`)}/cards/c1/answer`, `/_agent-router/v1/web//chats/x/cards/c1/answer`,
    chat + "/purge", chat + "/purge/", chat + "/PURGE", chat + "/purge?x=/cards/c1/answer", chat + "/cards/c1/answer/../../purge", chat + "/cards%2Fc1%2Fanswer", chat + "/reset",
    `/_agent-router/v1/agents/${id}`, `/_agent-router/v1/agents/${id}/check`, "/_agent-router/v1/web/identities/pairing-codes", "/_agent-router/v1/web/identities/pairing-codes/"])
    expect(await call("POST", path, approver, body), path).toEqual(refused);
  // The same with every scope: the owner's routes stay refused in any spelling.
  const everything = service("ops.alice", (await mint(["chat", "approve", "manage"], "everything")).token);
  for (const [method, path] of [["POST", chat + "/purge"], ["POST", chat + "/purge/"], ["POST", chat + "/PURGE"], ["POST", chat + "/purge?confirm=1"], ["GET", "/_mau/v1/tokens"],
    ["GET", "/_mau/v1/tokens/"], ["GET", "/_mau/v1/TOKENS"], ["GET", "/_mau/v1/tokens?x=1"], ["POST", "/_mau/v1/tokens/"], ["POST", "/_mau/v1/Tokens"], ["POST", "/_mau/v1/tokens?x=1"],
    ["POST", "/_MAU/v1/tokens"], ["DELETE", "/_mau/v1/tokens/0123456789abcdef/"], ["DELETE", "/_mau/v1/TOKENS/0123456789abcdef"]] as const)
    expect(await call(method, path, everything, method === "GET" || method === "DELETE" ? undefined : { name: "more", scopes: ["manage"] }), `${method} ${path}`).toEqual(refused);
  expect((await call("GET", "/_mau/v1/tokens", human())).data.data.map((token: any) => token.name)).toEqual(["everything", "approve", "manage", "weak"]);
}, 120_000);

it("holds an allowed write to Router's cross-site guard, and gives a cross-site page no way to send the token", async () => {
  const f = await mauFixture(cleanup, {}, { edgeIdentity }), { call, send, service, human, mint } = callers(f);
  const agent = `/_mau/v1/agents/${f.agent.id}`, token = (await mint(["chat", "approve", "manage"], "agent")).token;
  const { origin: own, ...granted } = service("ops.alice", token);
  const dismissed = async () => (await call("GET", agent, human())).data.dismissed !== null;
  // The token allows the request; the guard still wants the service's own origin and a body no form can send.
  for (const headers of [granted, { ...granted, origin: "https://evil.example.test" }, { ...granted, origin: "null" }, { ...granted, origin: own!.replace("127.0.0.1", "localhost") }]) {
    expect(await call("POST", agent + "/dismiss", headers, {}), headers.origin).toMatchObject({ status: 403, data: { error: "origin_not_allowed" } });
    expect(await call("POST", `/_agent-router/v1/agents/${f.agent.id}/check`, headers, {}), headers.origin).toMatchObject({ status: 403, data: { error: "origin_not_allowed" } });
  }
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"])
    expect(await call("POST", agent + "/dismiss", { ...granted, origin: own!, "content-type": type, "content-length": "2" }, "{}"), type).toMatchObject({ status: 415, data: { error: "content_type_not_allowed" } });
  expect(await dismissed()).toBe(false);
  expect((await call("POST", agent + "/dismiss", { ...granted, origin: own! }, {})).status).toBe(200);
  // `Mau-Token` is not a header a page may set on a cross-site request without asking first, and the preflight that
  // asks is answered without any CORS permission, on Mau's routes and on Router's, signed in or not.
  for (const path of [agent + "/dismiss", "/_mau/v1/tokens", `/_agent-router/v1/agents/${f.agent.id}/check`]) for (const signedIn of [{}, { "cf-access-jwt-assertion": granted["cf-access-jwt-assertion"]! }]) {
    const preflight = await send("OPTIONS", path, { ...signedIn, origin: "https://evil.example.test", "access-control-request-method": "POST", "access-control-request-headers": "mau-token,content-type" });
    expect(preflight.status, path).not.toBe(204);
    expect(Object.keys(preflight.headers).filter(name => name.startsWith("access-control-")), path).toEqual([]);
  }
  for (const headers of [{ ...granted, origin: own! }, { ...granted, origin: "https://evil.example.test" }])
    expect(Object.keys((await send("GET", "/_mau/v1/account", headers)).headers).filter(name => name.startsWith("access-control-"))).toEqual([]);
}, 120_000);

it("creates tokens within their limits and keeps no secret: only its digest is stored", async () => {
  const f = await mauFixture(cleanup, {}, { edgeIdentity }), { call, human, mint } = callers(f);
  const create = (body: unknown, headers = human()) => call("POST", "/_mau/v1/tokens", headers, body);
  for (const body of [{}, { name: "x" }, { name: "x", scopes: [] }, { name: "x", scopes: ["owner"] }, { name: "x", scopes: ["read"] }, { name: "x", scopes: ["manage", "owner"] },
    { name: "x", scopes: "manage" }, { name: "", scopes: ["chat"] }, { name: "n".repeat(61), scopes: ["chat"] }, { name: 1, scopes: ["chat"] }, { name: "x", scopes: ["chat"], expiresInDays: 0 },
    { name: "x", scopes: ["chat"], expiresInDays: 91 }, { name: "x", scopes: ["chat"], expiresInDays: 1.5 }, { name: "x", scopes: ["chat"], expiresInDays: null },
    { name: "x", scopes: ["chat"], expiresAt: "2999-01-01T00:00:00Z" }, { name: "x", scopes: ["chat"], owner: bob }, { name: "x", scopes: ["chat", "chat", "chat", "chat"] }])
    expect(await create(body), JSON.stringify(body)).toMatchObject({ status: 400, data: { error: "invalid_request" } });
  expect((await call("GET", "/_mau/v1/tokens", human())).data).toEqual({ data: [] });

  // Expiry is always set: seven days unless given, ninety at most.
  const first = await mint(["manage", "chat", "chat"], "first"), days = (token: { createdAt: string; expiresAt: string }) => (Date.parse(token.expiresAt) - Date.parse(token.createdAt)) / 86_400_000;
  expect(Object.keys(first).sort()).toEqual(["createdAt", "expiresAt", "id", "name", "scopes", "token"]);
  expect(first).toMatchObject({ id: expect.stringMatching(/^[0-9a-f]{16}$/), scopes: ["chat", "manage"], token: expect.stringMatching(tokenFormat) });
  expect(first.token.startsWith(`mau_${first.id}_`)).toBe(true);
  expect(days(first)).toBe(7);
  expect(days(await mint(["chat"], "long", human(), { expiresInDays: 90 }))).toBe(90);
  expect(days(await mint(["chat"], "short", human(), { expiresInDays: 1 }))).toBe(1);
  // A name is taken while its token works, and free again once that is revoked.
  expect(await create({ name: "first", scopes: ["approve"] })).toMatchObject({ status: 409, data: { error: "token_name_in_use" } });
  expect((await call("DELETE", `/_mau/v1/tokens/${first.id}`, human())).status).toBe(204);
  const again = await mint(["approve"], "first");
  expect(again.id).not.toBe(first.id);
  expect((await call("GET", "/_mau/v1/tokens", human())).data.data.map((token: any) => [token.name, Boolean(token.revokedAt)])).toEqual([["first", false], ["short", false], ["long", false], ["first", true]]);

  // Twenty working tokens for one owner; the twenty-first is refused until one is revoked. Another owner has their own.
  const secrets = [again.token];
  for (let n = 4; n <= 20; n++) secrets.push((await mint(["chat"], `token-${n}`)).token);
  expect(await create({ name: "token-21", scopes: ["chat"] })).toMatchObject({ status: 409, data: { error: "token_limit_reached", limit: 20 } });
  expect((await mint(["chat"], "bobs", human("bob@example.test"))).name).toBe("bobs");
  expect((await call("DELETE", `/_mau/v1/tokens/${again.id}`, human())).status).toBe(204);
  secrets.push((await mint(["chat"], "token-21")).token);
  expect(await create({ name: "token-22", scopes: ["chat"] })).toMatchObject({ status: 409, data: { error: "token_limit_reached" } });
  const listed = (await call("GET", "/_mau/v1/tokens", human())).data.data;
  expect(listed).toHaveLength(22);
  expect(listed.filter((token: any) => !token.revokedAt)).toHaveLength(20);
  for (const token of listed) expect(Object.keys(token).filter(key => !["id", "name", "scopes", "createdAt", "expiresAt", "lastUsedAt", "revokedAt"].includes(key))).toEqual([]);

  // Nothing in the state directory holds a token or its secret, in any file of the databases (their logs included).
  const files = readdirSync(f.directory, { recursive: true, encoding: "utf8" }).map(name => join(f.directory, name)).filter(path => statSync(path).isFile());
  const store = files.filter(path => path.includes("business-tools.sqlite"));
  expect(store.length).toBeGreaterThan(0);
  expect(Buffer.concat(store.map(path => readFileSync(path))).includes(first.id)).toBe(true);
  for (const path of files) {
    const bytes = readFileSync(path);
    for (const token of [first.token, ...secrets]) {
      const secret = token.slice(`mau_${first.id}_`.length);
      expect(bytes.includes(secret), path).toBe(false);
      expect(bytes.includes(Buffer.from(secret, "base64url")), path).toBe(false);
    }
  }
}, 120_000);

it("drops a token thirty days after it stopped working, and records its use at most once a minute", () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const store = new DurableStore(":memory:", "example.test"), tokens = new AccessTokens(store, () => now), day = 86_400_000;
  cleanup.push(() => store.close());
  const request = (token: string, originalUrl = "/_mau/v1/agents/a/dismiss", method = "POST") => ({ method, originalUrl, headers: { "mau-token": token } });
  const short = tokens.create(alice, { name: "short", scopes: ["manage"], expiresInDays: 1 }), long = tokens.create(alice, { name: "long", scopes: ["manage"], expiresInDays: 90 });
  const revoked = tokens.create(alice, { name: "revoked", scopes: ["manage"], expiresInDays: 90 });
  const names = () => tokens.list(alice).map(token => token.name);
  expect(tokens.authorize({ ownerId: alice }, request(short.token))).toBe(true);
  expect(tokens.authorize({ ownerId: bob }, request(short.token))).toBe(false);
  // Use is written once, then not again within the minute.
  const used = () => tokens.list(alice).find(token => token.id === short.id)!.lastUsedAt;
  expect(used()).toBe("2026-01-01T00:00:00.000Z");
  now += 59_000; expect(tokens.authorize({ ownerId: alice }, request(short.token))).toBe(true); expect(used()).toBe("2026-01-01T00:00:00.000Z");
  now += 1_000; expect(tokens.authorize({ ownerId: alice }, request(short.token))).toBe(true); expect(used()).toBe("2026-01-01T00:01:00.000Z");
  // A refusal records nothing, and a store that cannot be written does not turn an allowed request into a refusal.
  expect(tokens.authorize({ ownerId: alice }, request(long.token, "/_mau/v1/tokens"))).toBe(false);
  expect(tokens.authorize({ ownerId: alice }, request(long.token, "/_mau/v1/agents/a/memory/pending/p/approve"))).toBe(false);
  expect(tokens.list(alice).find(token => token.id === long.id)!.lastUsedAt).toBeUndefined();
  const set = vi.spyOn(store, "set").mockImplementation(() => { throw new Error("disk_full"); });
  expect(tokens.authorize({ ownerId: alice }, request(long.token))).toBe(true);
  set.mockRestore();
  // A store that cannot be read refuses.
  const get = vi.spyOn(store, "get").mockImplementation(() => { throw new Error("database_unreadable"); });
  expect(tokens.authorize({ ownerId: alice }, request(long.token))).toBe(false);
  get.mockRestore();
  // What cannot be classified is refused whatever the token carries.
  for (const value of [{ headers: { "mau-token": long.token } }, { ...request(long.token), method: undefined }, { ...request(long.token), originalUrl: undefined },
    request(long.token, "/_mau/v1/agents/a/dismiss/"), request(long.token, "/other"), request(long.token, "/_mau/v1/agents/a/dismiss", "PATCH"),
    { ...request(long.token), headers: { "mau-token": [long.token] } }, { ...request(long.token), headers: {} }, { ...request(long.token), headers: { "Mau-Token": long.token } }])
    expect(tokens.authorize({ ownerId: alice }, value as Parameters<AccessTokens["authorize"]>[1])).toBe(false);

  // Expired at its time, listed for thirty days more, then gone; a revoked one the same from its revocation.
  now = Date.parse(short.expiresAt) - 1; expect(tokens.authorize({ ownerId: alice }, request(short.token))).toBe(true);
  now += 1; expect(tokens.authorize({ ownerId: alice }, request(short.token))).toBe(false);
  tokens.revoke(alice, revoked.id);
  expect(tokens.authorize({ ownerId: alice }, request(revoked.token))).toBe(false);
  expect(() => tokens.revoke(bob, long.id)).toThrow("token_not_found");
  now += 30 * day; expect(names()).toEqual(["revoked", "long", "short"]);
  now += 1; expect(names()).toEqual(["long"]);
  expect(store.entries("access-tokens").map(entry => entry.id)).toEqual([long.id]);
  // The name of a token that stopped working is free.
  expect(tokens.create(alice, { name: "short", scopes: ["chat"] }).name).toBe("short");
  now = Date.parse(long.expiresAt) + 30 * day + 1; expect(tokens.list(bob)).toEqual([]); expect(store.entries("access-tokens")).toHaveLength(2);
  expect(names()).toEqual([]);
  expect(store.entries("access-tokens")).toEqual([]);
});

it("does nothing in local mode: the one owner signs in with the local token, and no request is a service token's", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mau-token-local-")), tokenFile = join(directory, "token"), optionsFile = join(directory, "mau.json");
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const local = "local-owner-token-of-the-test-0123456789abc", config = { serverName: "localhost", publicUrl: "http://127.0.0.1:8790/_agent-router/v1", stateDir: join(directory, "state") };
  writeFileSync(tokenFile, local + "\n", { mode: 0o600 });
  writeFileSync(optionsFile, JSON.stringify({ environments: { configFile: "providers.json", profiles: [{ id: "codex", label: "Codex", owners: ["@owner:localhost"], provider: "local", template: "node24",
    kernel: "codex", runtimeId: "personal", hostConfigFile: "host.json" }] } }));
  writeFileSync(join(directory, "host.json"), JSON.stringify({ stateDirectory: "state", runtimes: [{ id: "personal", kernel: "codex", cwd: "/home/user/workspace" }] }));
  const mau = createMau(config, optionsFile, { router: { authenticate: localLogin(tokenFile, "127.0.0.1", config, optionsFile) },
    environments: async () => ({ provider: () => { throw new Error("no_environment_in_this_test"); } }) });
  const server = mau.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await mau.close(); });
  const f = { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, access: { jwt: () => "" } }, { call } = callers(f), bearer = { authorization: "Bearer " + local };
  const agent = await mau.router.service.create("@owner:localhost", "helper"), dismiss = `/_mau/v1/agents/${agent.id}/dismiss`;
  // The owner can create a token there; it signs nobody in and changes no answer.
  const created = await call("POST", "/_mau/v1/tokens", bearer, { name: "agent", scopes: ["chat", "approve", "manage"] });
  expect(created.status).toBe(201);
  for (const headers of [{ "mau-token": created.data.token }, { authorization: `Bearer ${created.data.token}` }, { "mau-token": created.data.token, origin: f.base },
    { "mau-token": created.data.token, "cf-access-jwt-assertion": created.data.token }]) {
    expect((await call("GET", "/_mau/v1/account", headers)).status).toBe(401);
    expect((await call("POST", dismiss, headers, {})).status).toBe(401);
    expect((await call("POST", "/_agent-router/v1/agents", headers, { name: "other" })).status).toBe(401);
  }
  for (const value of [created.data.token, "nonsense"]) {
    expect((await call("GET", "/_mau/v1/account", { ...bearer, "mau-token": value })).data).toEqual({ owner: "@owner:localhost", person: expect.anything(), via: "bearer" });
    expect((await call("POST", dismiss, { ...bearer, "mau-token": value }, {})).status).toBe(200);
    expect((await call("POST", `/_mau/v1/agents/${agent.id}/restore`, { ...bearer, "mau-token": value }, {})).status).toBe(200);
  }
  expect((await call("GET", "/_mau/v1/tokens", bearer)).data.data[0].lastUsedAt).toBeUndefined();
}, 60_000);

it("mau token creates, lists and revokes, and a service token's commands carry the access token", async () => {
  const f = await mauFixture(cleanup, {}, { edgeIdentity });
  const edge = await edgeProxy(cleanup, () => f.base, f.access.jwt, { "client.access": { secret: "client-secret", commonName: "ops.alice" } });
  const directory = mkdtempSync(join(tmpdir(), "mau-token-cli-")), out = join(directory, "agent.token");
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const service = { CF_ACCESS_CLIENT_ID: "client.access", CF_ACCESS_CLIENT_SECRET: "client-secret" };
  const owner = builtCli(cleanup, { CF_ACCESS_TOKEN: aliceToken }), agent = builtCli(cleanup, service), holder = builtCli(cleanup, { ...service, MAU_TOKEN_FILE: out });
  const ok = async (cli: typeof owner, ...args: string[]) => { const run = await cli(...args); expect(run, args.join(" ")).toMatchObject({ code: 0 }); return run.json; };
  for (const cli of [owner, agent]) expect(await ok(cli, "login", edge)).toEqual({ owner: alice, url: edge });
  // A token file that is named and cannot be read is a failure, not a request without the token.
  expect((await holder("login", edge)).error).toEqual({ error: "credential_file_unreadable" });

  // The owner creates a token into a private file; the token is in the file and nowhere in the output.
  expect((await owner("token", "create", "agent")).error).toMatchObject({ error: "option_required", option: "--scope" });
  expect((await owner("token", "create", "agent", "--scope", "owner")).error).toEqual({ error: "unknown_scope", scopes: ["chat", "approve", "manage"] });
  for (const days of ["0", "91", "7d", "1.5", ""]) expect((await owner("token", "create", "agent", "--scope", "chat", "--days", days)).error, days).toEqual({ error: "invalid_days", min: 1, max: 90 });
  const made = await owner("token", "create", "agent", "--scope", "manage", "--scope", "chat", "--days", "3", "--out", out);
  expect(made.code).toBe(0);
  expect(made.json).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), name: "agent", scopes: ["chat", "manage"], createdAt: expect.any(String), expiresAt: expect.any(String), tokenFile: out });
  expect(Date.parse(made.json.expiresAt) - Date.parse(made.json.createdAt)).toBe(3 * 86_400_000);
  const token = readFileSync(out, "utf8");
  expect(token).toMatch(/^mau_[0-9a-f]{16}_[A-Za-z0-9_-]{43}\n$/);
  expect(statSync(out).mode & 0o777).toBe(0o600);
  expect(made.stdout + made.stderr).not.toContain(token.trim().split("_")[2]);
  // An existing file is never written over, and no token is created for it.
  expect((await owner("token", "create", "second", "--scope", "chat", "--out", out)).error).toEqual({ error: "file_exists", file: out });
  expect(readFileSync(out, "utf8")).toBe(token);
  expect((await owner("token", "create", "second", "--scope", "chat", "--out", join(directory, "missing", "x"))).error).toEqual({ error: "file_not_writable", file: join(directory, "missing", "x") });
  // A refused creation leaves no file behind.
  expect((await owner("token", "create", "agent", "--scope", "chat", "--out", join(directory, "taken"))).error).toMatchObject({ error: "token_name_in_use", httpStatus: 409 });
  expect(existsSync(join(directory, "taken"))).toBe(false);
  expect((await ok(owner, "token", "list")).data.map((item: any) => item.name)).toEqual(["agent"]);
  // Without --out the token is in the result, once.
  const printed = await ok(owner, "token", "create", "printed", "--scope", "approve");
  expect(printed).toMatchObject({ name: "printed", scopes: ["approve"], token: expect.stringMatching(tokenFormat) });
  expect(JSON.stringify(await ok(owner, "token", "list"))).not.toContain("mau_");

  // The service token alone reads; a command that changes something says which scope it needs.
  expect(await ok(agent, "whoami")).toEqual({ owner: alice, person: expect.anything(), via: "edge-service", expiresAt: expect.any(String) });
  expect((await ok(agent, "partner", "list")).data).toHaveLength(1);
  expect((await agent("partner", "dismiss", "helper")).error).toEqual({ error: "owner_sign_in_required", needs: "manage", httpStatus: 403 });
  expect((await agent("token", "list")).error).toEqual({ error: "owner_sign_in_required", httpStatus: 403 });
  // With the access token the same command works, and whoami shows what the token allows.
  expect(await ok(holder, "login", edge)).toEqual({ owner: alice, url: edge });
  expect((await ok(holder, "whoami")).token).toEqual({ id: made.json.id, name: "agent", scopes: ["chat", "manage"], expiresAt: made.json.expiresAt });
  expect((await ok(holder, "partner", "dismiss", "helper")).dismissed).toEqual(expect.any(String));
  expect((await ok(agent, "partner", "restore", "helper", "--mau-token-file", out)).dismissed).toBeNull();
  expect((await ok(builtCli(cleanup, { ...service, MAU_TOKEN: token.trim(), MAU_CONFIG_DIR: join(directory, "config") }), "login", edge)).owner).toBe(alice);
  expect((await ok(builtCli(cleanup, { ...service, MAU_TOKEN: token.trim(), MAU_CONFIG_DIR: join(directory, "config") }), "whoami")).token.name).toBe("agent");
  // The token is read for each command and kept nowhere: not in the session, and gone when the file is.
  expect(readFileSync(join(directory, "config", "session.json"), "utf8")).not.toContain("mau_");
  // Its scopes hold: no approval, no token of its own, and the scope it lacks is named.
  expect((await holder("token", "create", "more", "--scope", "manage")).error).toEqual({ error: "owner_sign_in_required", httpStatus: 403 });
  expect((await holder("token", "revoke", made.json.id)).error).toEqual({ error: "owner_sign_in_required", httpStatus: 403 });
  expect((await holder("api", "POST", `/_mau/v1/agents/${f.agent.id}/memory/pending/p1/approve`)).error).toEqual({ error: "owner_sign_in_required", needs: "approve", httpStatus: 403 });
  // What is not a token is refused before anything is sent.
  const junk = join(directory, "junk"); writeFileSync(junk, "not-a-token\n"); chmodSync(junk, 0o600);
  expect((await agent("partner", "list", "--mau-token-file", junk)).error).toEqual({ error: "invalid_mau_token" });
  expect((await agent("partner", "list", "--mau-token-file", join(directory, "absent"))).error).toEqual({ error: "credential_file_unreadable" });

  // The route list says what every route needs.
  const reference = await ok(holder, "api");
  for (const route of reference.routes) expect(["read", "chat", "approve", "manage", "owner"], `${route.method} ${route.path}`).toContain(route.scope);
  expect(reference.routes.find((route: any) => route.method === "POST" && route.path === "/_mau/v1/tokens").scope).toBe("owner");
  expect(reference.routes.find((route: any) => route.method === "POST" && route.path === "/_agent-router/v1/web/chats/:chatId/cards/:cardId/answer").scope).toBe("approve");

  // Revoked by the owner: the next command of the agent is refused again.
  expect((await owner("token", "revoke", "0000000000000000")).error).toEqual({ error: "token_not_found", httpStatus: 404 });
  expect(await ok(owner, "token", "revoke", made.json.id)).toEqual({ revoked: made.json.id });
  expect((await holder("partner", "dismiss", "helper")).error).toEqual({ error: "owner_sign_in_required", needs: "manage", httpStatus: 403 });
  expect((await ok(holder, "whoami")).token).toBeUndefined();
  expect((await ok(owner, "token", "list")).data.map((item: any) => [item.name, Boolean(item.revokedAt), Boolean(item.lastUsedAt)])).toEqual([["printed", false, false], ["agent", true, true]]);
}, 180_000);
