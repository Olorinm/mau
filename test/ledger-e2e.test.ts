import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerClient, ledgerApi, type LedgerSocket } from "../web/src/api/ledger";
import { alice, mauFixture } from "./fixtures/mau.js";

// Mau embedding a Router with AGENT_LEDGER_READ: a Matrix-ingested owner message is served by the ledger
// history API behind Mau's console and pushed over the event socket on Mau's own HTTP server.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});
const until = async <T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> => {
  for (let n = 0; n < 300; n++) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout_" + label);
};

it("serves a Matrix-ingested message through /web history and the event socket to the ledger client", async (context) => {
  // A console root, so the SPA fallback is mounted in front of Router as in production.
  const webRoot = mkdtempSync(join(tmpdir(), "mau-ledger-web-"));
  cleanup.push(() => rmSync(webRoot, { recursive: true, force: true }));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>console</title>");
  const f = await mauFixture(cleanup, { webRoot }, undefined, {}, { ledgerRead: true });
  // Released Routers before the ledger web channel have no upgrade handler; the test needs the local Router build.
  if (typeof (f.mau.router as { upgrade?: unknown }).upgrade !== "function" || !(f.service as { web?: unknown }).web) return context.skip();
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");
  const runtime = await f.service.runtime(f.agent.id);
  const room = "!ledger-dm:example.test", chatId = `dm:${f.agent.id}`;
  runtime.connector.store.set("rooms", room, { members: [alice, f.agent.matrixId], encrypted: false });
  const ingest = (id: string, body: string) => runtime.connector.ingest(room, {
    event_id: id, sender: alice, type: "m.room.message", content: { msgtype: "m.text", body }, origin_server_ts: Date.now() + 1,
  });
  ingest("$ledger-1", "hello from matrix");

  const api = ledgerApi("alice", f.base + "/_agent-router/v1/web");
  const me = await api.me();
  expect(me.limits?.features).toMatchObject({ history: true, send: false });
  expect(await api.openDm(f.agent.id)).toMatchObject({ chatId, kind: "dm" });
  const page = await until(async () => {
    const result = await api.events(chatId);
    return result.events.some((event) => event.kind === "message" && event.text === "hello from matrix") ? result : undefined;
  }, "history");
  expect(page).toMatchObject({ mode: "page", generation: 1, newerCursor: null });
  expect(page.events.find((event) => event.kind === "message")).toMatchObject({ role: "user", sender: { type: "person" }, channel: { kind: "matrix" } });
  // Not shadowed by the console fallback (JSON, not index.html) and owner scoped.
  const unknown = await fetch(f.base + "/_agent-router/v1/web/unknown", { headers: { authorization: "Bearer alice" } });
  expect([unknown.status, unknown.headers.get("content-type")]).toEqual([404, expect.stringContaining("application/json")]);
  expect((await f.api(`/chats/${encodeURIComponent(chatId)}/events`, undefined, "bob", "/_agent-router/v1/web")).status).toBe(404);

  const port = new URL(f.base).port;
  const client = new LedgerClient(api, {
    socket: (url) => new WebSocket(url) as unknown as LedgerSocket,
    socketUrl: (ticket) => `ws://127.0.0.1:${port}/_agent-router/v1/web/socket?ticket=${encodeURIComponent(ticket)}`,
  });
  cleanup.push(() => client.disconnect());
  await client.openChat(chatId);
  client.connect();
  await until(() => client.connection.state === "open", "socket");
  const before = client.view(chatId).lastSeq;
  ingest("$ledger-2", "live over the socket");
  const live = await until(() => client.view(chatId).events.find((event) => event.kind === "message" && event.text === "live over the socket"), "live");
  expect(live.seq).toBeGreaterThan(before);
  expect(client.view(chatId).events.map((event) => event.seq)).toEqual(
    Array.from({ length: client.view(chatId).events.length }, (_, index) => client.view(chatId).events[0]!.seq + index));
  expect(client.chats.get(chatId)?.lastSeq).toBeGreaterThanOrEqual(live.seq);
  // Unknown upgrade paths are still answered by Mau's SSH handler, not left hanging.
  const rejected = await new Promise<string>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/_agent-router/v1/web/socket?ticket=tk_unknown`);
    socket.addEventListener("error", () => resolve("rejected")); socket.addEventListener("open", () => resolve("open"));
  });
  expect(rejected).toBe("rejected");
});
