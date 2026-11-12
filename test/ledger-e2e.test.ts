import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerClient, attachmentLimits, foldEvents, ledgerApi, ledgerFeatures, type LedgerSocket } from "../web/src/api/ledger";
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
  // `ledgerSend` is ignored by Routers before phase 3; the send part below is keyed on the advertised feature.
  // A fake Host (with run idempotency, which Mau requires) that completes every run, so a web send runs a whole turn.
  const runs = new Map<string, Record<string, unknown>>(), inputs: string[] = [];
  const media: Array<Array<{ name: string; mediaType: string; data: string }>> = [];
  const host = (url: URL, init?: RequestInit) => {
    const method = init?.method ?? "GET", path = url.pathname;
    if (path.endsWith("/runs") && method === "POST") {
      const body = JSON.parse(String(init?.body)), id = `run-${runs.size + 1}`;
      inputs.push(String(body.input));
      media.push(Array.isArray(body.attachments) ? body.attachments : []);
      const run = { id, sessionId: body.sessionId, runtimeId: body.runtimeId, status: "completed", answer: `answer-${runs.size + 1}` };
      runs.set(id, run); return Response.json(run);
    }
    if (path.endsWith("/events")) return Response.json({ events: [], cursor: 0, hasMore: false, historyTruncated: false });
    if (path.endsWith("/calls")) return Response.json({ calls: [] });
    const run = /\/runs\/(run-\d+)$/.exec(path)?.[1];
    if (run && runs.has(run)) return Response.json(runs.get(run));
    return Response.json({ error: "fixture_unknown_path" }, { status: 404 });
  };
  const f = await mauFixture(cleanup, { webRoot, host, hostCapabilities: { runIdempotency: true } }, {}, { ledgerRead: true, ledgerSend: true, ledgerCards: true, ledgerControl: true, ledgerAttachments: true });
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
  expect(me.limits?.features).toMatchObject({ history: true });
  const sendable = ledgerFeatures(me).has("send");
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
  // The chat index frame may trail the event frame under load.
  await until(() => (client.chats.get(chatId)?.lastSeq ?? 0) >= live.seq, "index");
  if (sendable) {
    // Phase 3: the console sends through Router; the stored web message comes back once, keyed by its idempotencyKey.
    const response = await client.send(chatId, { text: "sent from the web" });
    expect(response).toMatchObject({ status: "accepted", event: { kind: "message", role: "user", text: "sent from the web", sender: { type: "person" } } });
    expect(response!.event.channel?.kind ?? "web").toBe("web");
    const key = response!.event.idempotencyKey!;
    expect(key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(await api.send(chatId, { idempotencyKey: key, text: "sent from the web" })).toMatchObject({ status: "duplicate", event: { eventId: response!.event.eventId } });
    await expect(api.send(chatId, { idempotencyKey: key, text: "a different body" })).rejects.toMatchObject({ status: 409, code: "idempotency_key_reused" });
    await until(() => client.view(chatId).events.some((event) => event.eventId === response!.event.eventId), "send echo");
    expect(client.view(chatId).events.filter((event) => event.idempotencyKey === key)).toHaveLength(1);
    expect(client.view(chatId).pending).toEqual([]);
    // web → Router → Host → reply over the socket: the turn runs in the shared owner-main session and its answer is
    // recorded for the web, not sent to Matrix.
    const reply = await until(() => client.view(chatId).events.find((event) => event.kind === "message" && event.role === "assistant"
      && event.turnId !== undefined && inputs.some((input) => input.includes("sent from the web")) && event.channel?.kind === "web"), "web reply");
    expect(reply).toMatchObject({ final: true, sender: { type: "agent", id: f.agent.id } });
    await until(() => client.view(chatId).events.find((event) => event.kind === "turn" && event.turnId === reply.turnId && event.state === "completed"), "turn completed");
    // Withdraw (撤回): the stored redaction comes back, and history renders the target as redacted.
    const withdrawn = await client.redact(chatId, response!.event.eventId);
    // The turn already took the input, so it is hidden, not dropped (ADR 15.2.9).
    expect(withdrawn).toMatchObject({ status: "accepted", dropped: false, event: { kind: "redaction", targetEventId: response!.event.eventId } });
    expect(client.view(chatId).redactions).toEqual([]);
    const history = await api.events(chatId, { limit: 200 });
    expect(history.events.find((event) => event.eventId === response!.event.eventId)).toMatchObject({ kind: "message", text: "", redacted: true });
    expect(foldEvents(history.events).items.find((item) => item.eventId === response!.event.eventId)).toMatchObject({ redacted: true, text: "" });

    if (ledgerFeatures(me).has("attachments")) {
      // Phase 4: a raw-body upload, a send that carries it, the Host receiving the bytes, and a same-origin download.
      const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("pixels")]);
      const limits = attachmentLimits(me);
      expect(limits).toMatchObject({ bytes: 25 * 1024 * 1024, perMessage: 10 });
      const uploaded = await api.uploadAttachment(new Blob([new Uint8Array(png)], { type: "image/png" }), "截图.png", { maxBytes: limits.bytes });
      expect(uploaded).toMatchObject({ name: "截图.png", contentType: "image/png", size: png.length, url: `/_agent-router/v1/web/attachments/${uploaded.attachmentId}` });
      const notes = await api.uploadAttachment(new Blob(["notes"], { type: "text/plain" }), "notes.txt");
      const runsBefore = inputs.length;
      const sent = await client.send(chatId, { text: "看看附件", attachments: [uploaded, notes] });
      expect(sent!.event).toMatchObject({ kind: "message", text: "看看附件", attachments: [
        { attachmentId: uploaded.attachmentId, name: "截图.png", contentType: "image/png", size: png.length, url: uploaded.url },
        { attachmentId: notes.attachmentId, name: "notes.txt", contentType: "text/plain", size: 5 }] });
      await until(() => inputs.length > runsBefore && inputs.at(-1)!.includes("看看附件"), "attachment run");
      expect(inputs.at(-1)).toContain("附件：截图.png (image/png)");
      expect(media.at(-1)!.map((item) => [item.name, item.mediaType, Buffer.from(item.data, "base64").toString("hex")]))
        .toEqual([["截图.png", "image/png", png.toString("hex")], ["notes.txt", "text/plain", Buffer.from("notes").toString("hex")]]);
      const bytes = Buffer.from(await (await api.downloadAttachment(uploaded)).arrayBuffer());
      expect(bytes.equals(png)).toBe(true);
      const raw = await fetch(f.base + uploaded.url, { headers: { authorization: "Bearer alice" } });
      expect([raw.status, raw.headers.get("content-type"), raw.headers.get("x-content-type-options")]).toEqual([200, "image/png", "nosniff"]);
      expect((await fetch(f.base + uploaded.url, { headers: { authorization: "Bearer bob" } })).status).toBe(404);
      // A bound upload cannot be sent again, and the client surfaces the server code.
      await expect(api.send(chatId, { idempotencyKey: "0123456789abcdef0001", text: "again", attachments: [uploaded.attachmentId] }))
        .rejects.toMatchObject({ status: 422, code: "attachment_not_found" });
      const folded = foldEvents((await api.events(chatId, { limit: 200 })).events).items.find((item) => item.eventId === sent!.event.eventId);
      expect(folded!.attachments.map((item) => item.name)).toEqual(["截图.png", "notes.txt"]);
    }
  }
  if (sendable && ledgerFeatures(me).has("reset")) {
    // Phase 4 control through Mau's server: "新对话" opens a new window for every owner channel; purge needs the chat id.
    expect(ledgerFeatures(me).has("cards")).toBe(true);
    const reset = await client.reset(chatId, true);
    expect(reset.event).toMatchObject({ kind: "window", reason: "reset", window: reset.window });
    await until(() => client.view(chatId).events.some((event) => event.eventId === reset.event.eventId), "window event");
    await expect(api.purge(chatId, "dm:someone-else", "purge-confirm-000001")).rejects.toMatchObject({ status: 422, code: "purge_confirmation_required" });
    const generation = client.view(chatId).generation;
    const purged = await client.purge(chatId, chatId, true);
    expect(purged).toMatchObject({ generation: generation + 1, window: reset.window + 1 });
    expect(purged.purgedEvents).toBeGreaterThan(0);
    await until(() => client.view(chatId).generation === purged.generation, "purged generation");
    expect(client.view(chatId).events.filter((event) => event.kind === "message")).toEqual([]);
    expect((await api.events(chatId)).events.map((event) => event.kind)).toEqual(["window"]);
  }
  // Unknown upgrade paths are still answered by Mau's SSH handler, not left hanging.
  const rejected = await new Promise<string>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/_agent-router/v1/web/socket?ticket=tk_unknown`);
    socket.addEventListener("error", () => resolve("rejected")); socket.addEventListener("open", () => resolve("open"));
  });
  expect(rejected).toBe("rejected");
}, 60_000);
