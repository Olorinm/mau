import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { generateSigningKey } from "@olorinm/agent-connectors/issuer";
import { TokenVerifier } from "@olorinm/agent-connectors";
import { ConnectorAccounts } from "../src/connector-accounts.js";
import { privateFile } from "../src/files.js";
import { mauFixture, alice, bob } from "./fixtures/mau.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });
async function upstream() {
  const directory = mkdtempSync(join(tmpdir(), "mau-accounts-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const authority = await generateSigningKey("authority"), caller = await generateSigningKey("caller");
  const keyFile = join(directory, "authority.json"); privateFile(keyFile, authority.privateJwk);
  const tokens = new TokenVerifier({ issuer: "fixture", audience: "fixture-connectors", callerKeys: { keys: [caller.publicJwk] }, authorityKeys: { keys: [authority.publicJwk] } });
  const state = { account: { status: "authorization_required" } as Record<string, unknown>,
    consent: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture", mode: "normal", posts: [] as string[], calls: 0,
    entries: [{ id: "alice-gmail", kind: "google", owner: alice, label: "Gmail" }, { id: "bob-drive", kind: "google", owner: bob, label: "Private other account" }] };
  const server = createServer(async (req, res) => {
    state.calls++;
    try { expect((await tokens.service(req.headers.authorization!.slice(7))).service).toBe("mau-account-management"); }
    catch { res.writeHead(401).end(); return; }
    if (req.method === "POST") {
      state.posts.push(req.url!);
      if (state.mode === "disconnect-socket") { req.socket.destroy(); return; }
      state.account = req.url?.endsWith("/disconnect") ? { status: "disconnected" } : { status: "authorization_required", authorizationUrl: state.consent, access_token: "never-return-this" };
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(state.account)); return;
    }
    if (state.mode === "redirect") { res.writeHead(302, { Location: "http://127.0.0.1:1/stolen" }).end(); return; }
    if (state.mode === "oversize") { res.end(" ".repeat(1_000_001)); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ connections: state.entries.map(entry => ({ ...entry, account: state.account, privateKey: "never-return-this" })) }));
  });
  server.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  cleanup.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const options = { url: `http://127.0.0.1:${(server.address() as any).port}`, issuer: "fixture", audience: "fixture-connectors", authorityKeyFile: keyFile, consentOrigins: ["https://accounts.google.com"] };
  return { options, state, client: new ConnectorAccounts(options, directory), directory, keyFile };
}

it("keeps unconfigured service explicit and authenticates every Mau account route", async () => {
  const f = await mauFixture(cleanup);
  expect((await f.api("/connector-accounts")).data).toEqual({ configured: false, data: [] });
  expect((await f.api("/connector-accounts", undefined, "invalid")).status).toBe(401);
  expect((await f.api("/connector-accounts/alice-gmail/connect", {}, "invalid")).status).toBe(401);
  expect((await f.api("/connector-accounts/alice-gmail/connect", {})).status).toBe(503);
});
it("uses real authority verification, isolates owner accounts and strips unreviewed fields", async () => {
  const u = await upstream();
  u.state.account = { status: "connected", verification: "oauth", scopes: ["gmail.readonly"], access_token: "never-return-this", authorizationUrl: u.state.consent };
  const f = await mauFixture(cleanup, {}, undefined, { connectorAccounts: u.options });
  const response = await f.api("/connector-accounts");
  expect(response.data).toEqual({ configured: true, data: [{ id: "alice-gmail", kind: "google", label: "Gmail", state: "connected", verification: "oauth", scopes: ["gmail.readonly"] }] });
  expect(JSON.stringify(response)).not.toContain("never-return-this");
  expect((await f.api("/connector-accounts/alice-gmail/check", {}, "bob")).status).toBe(404);
  expect((await f.api("/connector-accounts/alice-gmail/connect", {}, "bob")).status).toBe(404);
  expect((await f.api("/connector-accounts/alice-gmail/disconnect", {}, "bob")).status).toBe(404);
  expect(u.state.posts).toEqual([]);
  expect((await f.api("/connector-accounts/alice-gmail/connect", { owner: alice }, "bob")).status).toBe(400);
  expect((await f.api("/connector-accounts/alice-gmail/approve", {})).status).toBe(400);
  expect((await f.api("/connector-accounts/alice-gmail/connect", {})).data.state).toBe("connected");
  expect(u.state.posts).toEqual([]); // clicking Connect does not clear an already connected account
});
it("starts owner consent, checks the callback result and disconnects without granting Agent access", async () => {
  const u = await upstream();
  const f = await mauFixture(cleanup, {}, undefined, { connectorAccounts: u.options });
  const consent = await f.api("/connector-accounts/alice-gmail/connect", {});
  expect(consent.data).toEqual({ state: "authorization_required", verification: "none", scopes: [], authorizationUrl: u.state.consent });
  u.state.account = { status: "connected", verification: "oauth" };
  expect((await f.api("/connector-accounts/alice-gmail/check", {})).data.state).toBe("connected");
  expect((await f.api("/connector-accounts/alice-gmail/disconnect", {})).data.state).toBe("disconnected");
  expect(u.state.posts).toEqual(["/v1/connections/alice-gmail/connect", "/v1/connections/alice-gmail/disconnect"]);
});
it("rechecks ownership before a mutation and refuses unconfigured paths", async () => {
  const u = await upstream();
  await u.client.list(alice);
  u.state.entries[0]!.owner = bob;
  await expect(u.client.action(alice, "alice-gmail", "disconnect")).rejects.toThrow("connector_account_not_found");
  await expect(u.client.action(alice, "../operations", "connect")).rejects.toThrow("connector_account_not_found");
  expect(u.state.posts).toEqual([]);
});
it.each(["https://evil.example/", "https://accounts.google.com.evil.example/", "http://accounts.google.com/", "https://user:secret@accounts.google.com/", "javascript:alert(1)"])("refuses consent destination %s", async consent => {
  const u = await upstream(); u.state.consent = consent;
  await expect(u.client.action(alice, "alice-gmail", "connect")).rejects.toThrow("connector_consent_url_refused");
});
it("never retries uncertain account mutations or upstream redirects", async () => {
  const u = await upstream(); u.state.mode = "disconnect-socket";
  await expect(u.client.action(alice, "alice-gmail", "disconnect")).rejects.toThrow("connector_action_unknown");
  expect(u.state.posts).toHaveLength(1);
  u.state.mode = "redirect";
  await expect(u.client.list(alice)).rejects.toThrow("connector_service_unavailable");
  expect(u.state.calls).toBe(3);
});
it("bounds responses and refuses malformed or duplicate inventories", async () => {
  const u = await upstream(); u.state.mode = "oversize";
  await expect(u.client.list(alice)).rejects.toThrow("connector_service_unavailable");
  u.state.mode = "normal"; u.state.entries.push(u.state.entries[0]!);
  await expect(u.client.list(alice)).rejects.toThrow("connector_service_unavailable");
});
it("requires private authority keys and a fixed secure endpoint and consent origins", async () => {
  const u = await upstream();
  for (const url of ["http://external.example", "https://user:pass@example.test", "https://example.test/mcp", "https://example.test?token=x"])
    expect(() => new ConnectorAccounts({ ...u.options, url }, u.directory)).toThrow("connector_endpoint_invalid");
  expect(() => new ConnectorAccounts({ ...u.options, consentOrigins: ["http://accounts.google.com"] }, u.directory)).toThrow("connector_consent_origin_invalid");
  chmodSync(u.keyFile, 0o644);
  expect(() => new ConnectorAccounts(u.options, u.directory)).toThrow("connector_authority_key_permissions");
});
