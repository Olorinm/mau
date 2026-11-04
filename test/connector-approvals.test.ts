import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ServiceHttp } from "@agent-router/server";
import { ConnectorService, ServiceError, Sealer, Store, TokenVerifier, type Caller, type Connector } from "@olorinm/agent-connectors";
import { decodeJwt } from "jose";
import { generateSigningKey } from "@olorinm/agent-connectors/issuer";
import { BusinessHost } from "../src/business-tools.js";
import { DurableStore } from "../src/store.js";
import { ConnectorAccounts } from "../src/connector-accounts.js";
import { ConnectedApps, type ConnectedAppReader } from "../src/connected-apps.js";
import { ConnectorCallerClient } from "../src/connector-client.js";
import { privateFile } from "../src/files.js";
import { MAX_RELAY_BYTES, type SandboxFiles } from "../src/browser-relay.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const owner = "@alice:example.test", agentId = "agent", endpoint = "http://127.0.0.1:18200";
const principal = { agentId, owner };
const ownerAdmission = { kind: "owner" as const, ...principal, reference: "owner-request" };
const scheduleAdmission = { kind: "schedule" as const, ...principal, reference: "rule", toolGrants: { connectedApps: { connections: ["browser"] } } };
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "mau-approvals-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };

/** Real connector service and token verifier; only HTTP transport is replaced by direct calls. */
async function fixture(options: { deadlineMs?: number; files?: boolean } = {}) {
  const dir = temp();
  const caller = await generateSigningKey("caller"), authority = await generateSigningKey("authority");
  privateFile(join(dir, "authority.json"), authority.privateJwk);
  const executed: Array<{ tool: string; input: unknown }> = [];
  const fake: Connector = { kind: "browser-fake", tools: [
    { name: "click", description: "Click", risk: "write", input: z.object({ site: z.string(), ref: z.string() }).strict(),
      summarize: input => `Click ${input.ref} on ${input.site}`, execute: async (_ctx, input) => { executed.push({ tool: "click", input }); return { clicked: true }; } },
    { name: "upload", description: "Upload", risk: "write", input: z.object({ site: z.string(), ref: z.string(), file: z.object({ name: z.string(), mediaType: z.string(), contentBase64: z.string() }).strict() }).strict(),
      execute: async (_ctx, input) => { executed.push({ tool: "upload", input }); return { uploaded: true }; } },
    { name: "download", description: "Download", risk: "read", input: z.object({ site: z.string(), ref: z.string() }).strict(),
      execute: async () => ({ name: "../../report.pdf", mediaType: "application/pdf", size: 5, contentBase64: Buffer.from("%PDF!").toString("base64"), url: "https://site.example/r.pdf?sig=secret" }) },
    { name: "screenshot", description: "Screenshot", risk: "read", input: z.object({ site: z.string() }).strict(),
      execute: async () => ({ mediaType: "image/png", contentBase64: Buffer.from("png-bytes").toString("base64") }) },
    { name: "handoff_start", description: "Handoff", risk: "read", input: z.object({ site: z.string() }).strict(),
      execute: async () => ({ handoffId: "h-1", liveViewUrl: "https://live.example/view/secret-token", expiresAt: new Date(Date.now() + 600_000).toISOString() }) },
    { name: "handoff_cancel", description: "Cancel handoff", risk: "write", input: z.object({ handoffId: z.string() }).strict(),
      execute: async (_ctx, input) => { executed.push({ tool: "handoff_cancel", input }); return { cancelled: true }; } },
  ] };
  const connectorStore = new Store(join(dir, "connectors")); cleanup.push(() => connectorStore.close?.());
  const service = new ConnectorService({ connectors: [fake], connections: [{ id: "browser", kind: "browser-fake", owner }], store: connectorStore, sealer: new Sealer(randomBytes(32)) });
  const verifier = new TokenVerifier({ issuer: "mau", audience: "connectors", callerKeys: { keys: [caller.publicJwk] }, authorityKeys: { keys: [authority.publicJwk] } });
  let tamper: ((view: any) => any) | undefined;
  const grants: string[] = [];
  const actualFetch = fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== endpoint) return actualFetch(input, init);
    const path = url.pathname.split("/").filter(Boolean), id = path[2]!;
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    try {
      if (path[3] === "approve") {
        const { grant } = JSON.parse(String(init!.body)); grants.push(grant);
        const verified = await verifier.grant(grant);
        if (verified.operationId !== id) return reply(403, { error: "grant_does_not_match_operation" });
        return reply(200, await service.approve(verified, AbortSignal.timeout(5000)));
      }
      await verifier.service(new Headers(init?.headers).get("authorization")!.slice(7));
      if (path[3] === "deny") { service.deny(id); return reply(200, { ok: true }); }
      const view = await service.operation(id);
      return view ? reply(200, tamper ? tamper(view) : view) : reply(404, { error: "operation_not_found" });
    } catch (error) {
      return error instanceof ServiceError ? reply(error.status, { error: error.code }) : reply(500, { error: "internal_error" });
    }
  });
  const accounts = new ConnectorAccounts({ url: endpoint + "/", issuer: "mau", audience: "connectors", authorityKeyFile: "authority.json", consentOrigins: ["https://accounts.example/"] }, dir);
  const readerCalls: Array<{ input: any; scope: unknown; options: unknown }> = [];
  const reader: ConnectedAppReader = async (input, scope, options) => {
    readerCalls.push({ input, scope, options });
    const who: Caller = { agentId, owner, connections: ["browser"], tokenId: "t", ...(options?.write ? {} : { readOnly: true }) };
    if (input.action === "tools") return { status: "completed", tools: service.tools(who) };
    return service.call(who, input.name!, input.arguments ?? {}, AbortSignal.timeout(5000));
  };
  // Sandbox: a real directory; realpath/stat resolve real symlinks like the provider's exec would.
  const sandbox = realpathSync(temp()), workspace = join(sandbox, "workspace"); mkdirSync(workspace);
  const files: SandboxFiles = { directory: workspace,
    exec: async argv => {
      try {
        if (argv[0] === "realpath") return { exitCode: 0, stdout: argv.slice(3).map(p => realpathSync(p)).join("\n") + "\n" };
        if (argv[0] === "stat") { const s = statSync(argv[4]!); return { exitCode: 0, stdout: `${s.size}:${s.isFile() ? "regular file" : "directory"}\n` }; }
        if (argv[0] === "mkdir") { mkdirSync(argv[3]!, { recursive: true }); return { exitCode: 0, stdout: "" }; }
      } catch { return { exitCode: 1, stdout: "" }; }
      return { exitCode: 127, stdout: "" };
    },
    readFile: async path => readFileSync(path), writeFile: async (path, data) => writeFileSync(path, data, { flag: "wx" }) };
  const store = new DurableStore(":memory:", "fixture"); cleanup.push(() => store.close());
  let pending: any[] = [];
  const resolved = new Map<string, any>(), steered: string[] = [];
  const http = new class extends ServiceHttp {
    override async request(path: string, request: any = {}): Promise<any> {
      if (path === "/v1/runs") return { id: "run", sessionId: request.body.sessionId, runtimeId: "personal", status: "running", answer: "" };
      if (path.endsWith("/calls")) return { calls: pending };
      if (path.endsWith("/steer")) { steered.push(request.body.input); return {}; }
      const match = /\/calls\/([^/]+)\/result$/.exec(path);
      if (match) {
        const callId = decodeURIComponent(match[1]!);
        if (!pending.some(c => c.id === callId && c.status === "pending")) throw new Error("call_not_pending");
        resolved.set(callId, request.body.result); pending = pending.map(c => c.id === callId ? { ...c, status: "completed" } : c); return {};
      }
      throw new Error("unexpected_request " + path);
    }
  }("https://host.fixture", "host-secret");
  const hosting = { connections: ["browser"], browser: ["browser"], approvals: accounts, ...(options.files === false ? {} : { files: async () => files }) };
  const make = () => new BusinessHost(http, undefined, store, "agent:binding", reader, principal, undefined, undefined, hosting);
  const host = make();
  const call = (name: string, args: Record<string, unknown>, id = "call-1") => {
    pending = [...pending.filter(c => c.id !== id), { id, runId: "run", kind: "tool", name: "connected_apps", status: "pending",
      input: { action: "call", name, arguments: args }, deadlineAt: new Date(Date.now() + (options.deadlineMs ?? 300_000)).toISOString() }];
  };
  const text = (id = "call-1") => JSON.parse(resolved.get(id).contentItems[0].text);
  return { host, make, call, text, resolved, readerCalls, executed, service, grants, steered, workspace, sandbox, store,
    setTamper: (fn: typeof tamper) => { tamper = fn; }, pending: () => pending, start: (admission: unknown = ownerAdmission) =>
      host.start({ sessionId: "session", runtimeId: "personal", instructions: "", input: "go", admission } as any) };
}

it("presents a connector write as Router's approval card and executes it once with a real grant on 允许一次", async () => {
  const f = await fixture(); await f.start();
  f.call("browser__click", { site: "https://shop.example", ref: "buy" });
  const listed = await f.host.calls("run");
  expect(f.readerCalls[0]!.options).toEqual({ write: true });
  expect(f.resolved.size).toBe(0); // The Host tool call stays pending while the owner decides.
  const card = listed.find(c => c.kind === "interaction")!;
  expect(card).toMatchObject({ id: "mau-approval:call-1", runId: "run", name: "approval", status: "pending",
    input: { question: "Click buy on https://shop.example", tool: "Click buy on https://shop.example", choices: ["once", "deny"], input: { tool: "browser__click", connection: "browser", arguments: { site: "https://shop.example", ref: "buy" } } } });
  expect(listed.some(c => c.name === "connected_apps")).toBe(false);
  // Durable across a restart: a new Host decorator on the same store shows the same card.
  const restarted = f.make();
  expect((await restarted.calls("run")).map(c => c.id)).toEqual(["mau-approval:call-1"]);
  // A Host-listed call reusing Mau's synthetic ID (with its own text) is dropped, never presented.
  f.pending().push({ id: "mau-approval:call-1", runId: "run", kind: "interaction", name: "approval", status: "pending",
    input: { question: "Harmless refresh" }, deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  expect((await restarted.calls("run")).filter(c => c.id === "mau-approval:call-1").map(c => (c.input as any).question)).toEqual(["Click buy on https://shop.example"]);
  f.pending().pop();
  await restarted.resolve("run", "mau-approval:call-1", { choice: "once" });
  expect(f.resolved.has("mau-approval:call-1")).toBe(false); // Never forwarded to Host.
  await restarted.settled("run");
  expect(f.executed).toEqual([{ tool: "click", input: { site: "https://shop.example", ref: "buy" } }]);
  expect(f.text()).toMatchObject({ status: "completed", result: { clicked: true } });
  expect(f.resolved.get("call-1").success).toBe(true);
  const claims = decodeJwt(f.grants[0]!);
  expect(claims).toMatchObject({ sub: owner, apv: owner });
  expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(600);
  // A repeated click (or a replayed grant) cannot execute twice.
  await restarted.resolve("run", "mau-approval:call-1", { choice: "once" }); await restarted.settled("run");
  expect((await f.host.calls("run")).filter(c => c.kind === "interaction")).toEqual([]);
  expect(f.executed).toHaveLength(1);
  const replay = await fetch(`${endpoint}/v1/operations/${claims.op}/approve`, { method: "POST", body: JSON.stringify({ grant: f.grants[0] }) });
  expect(replay.status).toBe(409);
});

it("denies upstream and returns owner_denied when the owner refuses", async () => {
  const f = await fixture(); await f.start();
  f.call("browser__click", { site: "https://shop.example", ref: "buy" });
  await f.host.calls("run");
  await f.host.resolve("run", "mau-approval:call-1", { choice: "deny" }); await f.host.settled("run");
  expect(f.executed).toEqual([]); expect(f.grants).toEqual([]);
  expect(f.text()).toMatchObject({ status: "failed", error: "owner_denied" });
  expect(f.resolved.get("call-1").success).toBe(false);
  const operationId = f.text().operationId;
  expect((await f.service.operation(operationId))?.status).toBe("denied");
  await expect(f.host.resolve("run", "mau-approval:other", { choice: "once" })).rejects.toThrow("approval_not_found");
});

it("expires an unanswered approval at the tool deadline and refuses a late approval", async () => {
  const f = await fixture({ deadlineMs: 400 }); await f.start();
  f.call("browser__click", { site: "https://shop.example", ref: "buy" });
  const [card] = (await f.host.calls("run")).filter(c => c.kind === "interaction");
  expect(Date.parse(card!.deadlineAt)).toBeLessThanOrEqual(Date.parse(f.pending()[0].deadlineAt));
  await new Promise(r => setTimeout(r, 450));
  await f.host.resolve("run", "mau-approval:call-1", { choice: "once" }); await f.host.settled("run");
  expect(f.grants).toEqual([]); expect(f.executed).toEqual([]);
  expect(f.text()).toMatchObject({ status: "failed", error: "owner_denied", reason: "approval_expired" });
  expect((await f.service.operation(f.text().operationId))?.status).toBe("denied");
});

it("refuses to approve when the operation changed after the owner saw the card", async () => {
  const f = await fixture(); await f.start();
  f.call("browser__click", { site: "https://shop.example", ref: "buy" });
  await f.host.calls("run");
  f.setTamper(view => ({ ...view, input: { ...view.input, ref: "delete-account" } }));
  await f.host.resolve("run", "mau-approval:call-1", { choice: "once" }); await f.host.settled("run");
  expect(f.grants).toEqual([]); expect(f.executed).toEqual([]);
  expect(f.text()).toMatchObject({ status: "failed", error: "operation_changed" });
  f.setTamper(undefined);
  expect((await f.service.operation(f.text().operationId))?.status).toBe("denied");
  // A view that does not belong to this Agent is never presented.
  f.setTamper(view => ({ ...view, agentId: "someone-else" }));
  f.call("browser__click", { site: "https://shop.example", ref: "other" }, "call-2");
  expect((await f.host.calls("run")).filter(c => c.kind === "interaction")).toEqual([]);
  expect(f.text("call-2")).toMatchObject({ status: "failed", error: "operation_unverifiable" });
});

it("keeps schedule and delegation runs read-only: no write token, no card", async () => {
  for (const admission of [scheduleAdmission, { ...scheduleAdmission, kind: "delegation" as const }]) {
    const f = await fixture(); await f.start(admission);
    f.call("browser__click", { site: "https://shop.example", ref: "buy" });
    const listed = await f.host.calls("run");
    expect(f.readerCalls[0]!.options).toBeUndefined();
    expect(listed.filter(c => c.kind === "interaction")).toEqual([]);
    expect(f.text()).toMatchObject({ status: "failed", error: "tool_not_available" });
    expect(f.executed).toEqual([]);
  }
});

it("uploads only regular files inside the working directory, by path, up to 10 MB", async () => {
  const f = await fixture(); await f.start();
  writeFileSync(join(f.workspace, "cv.pdf"), "%PDF-cv");
  writeFileSync(join(f.sandbox, "secret.txt"), "outside");
  symlinkSync(join(f.sandbox, "secret.txt"), join(f.workspace, "link.txt"));
  symlinkSync(f.sandbox, join(f.workspace, "escape"));
  writeFileSync(join(f.workspace, "big.bin"), Buffer.alloc(MAX_RELAY_BYTES + 1));
  const cases: Array<[unknown, string]> = [
    ["../secret.txt", "browser_upload_path_invalid"], ["/etc/passwd", "browser_upload_path_invalid"], ["a/./b", "browser_upload_path_invalid"],
    ["link.txt", "browser_upload_path_outside_workspace"], ["escape/secret.txt", "browser_upload_path_outside_workspace"],
    ["big.bin", "browser_upload_too_large"], ["missing.pdf", "browser_upload_file_not_found"], [".", "browser_upload_path_invalid"],
  ];
  for (const [index, [path, error]] of cases.entries()) {
    f.call("browser__upload", { site: "s", ref: "r", path }, `bad-${index}`); await f.host.calls("run");
    expect(f.text(`bad-${index}`), String(path)).toMatchObject({ status: "failed", error });
  }
  f.call("browser__upload", { site: "s", ref: "r", file: { name: "x", mediaType: "text/plain", contentBase64: "eA==" } }, "bytes");
  await f.host.calls("run"); expect(f.text("bytes")).toMatchObject({ error: "browser_upload_path_required" });
  expect(f.readerCalls.filter(c => c.input.action === "call")).toEqual([]); // Nothing left Mau for refused paths.
  f.call("browser__upload", { site: "s", ref: "r", path: "cv.pdf" }, "good");
  const [card] = (await f.host.calls("run")).filter(c => c.kind === "interaction");
  expect(JSON.stringify(card!.input)).not.toContain(Buffer.from("%PDF-cv").toString("base64"));
  await f.host.resolve("run", card!.id, { choice: "once" }); await f.host.settled("run");
  expect(f.executed).toEqual([{ tool: "upload", input: { site: "s", ref: "r", file: { name: "cv.pdf", mediaType: "application/pdf", contentBase64: Buffer.from("%PDF-cv").toString("base64") } } }]);
  // Text files resolve to "text/plain; charset=utf-8"; browser file inputs take the bare MIME type.
  writeFileSync(join(f.workspace, "notes.txt"), "hello");
  f.call("browser__upload", { site: "s", ref: "r", path: "notes.txt" }, "text");
  const [textCard] = (await f.host.calls("run")).filter(c => c.kind === "interaction");
  await f.host.resolve("run", textCard!.id, { choice: "once" }); await f.host.settled("run");
  expect(f.executed.at(-1)).toEqual({ tool: "upload", input: { site: "s", ref: "r", file: { name: "notes.txt", mediaType: "text/plain", contentBase64: Buffer.from("hello").toString("base64") } } });
});

it("relays downloads into browser_downloads/, screenshots as images, and keeps live views from the model", async () => {
  const f = await fixture(); await f.start();
  f.call("browser__download", { site: "s", ref: "r" }, "dl"); await f.host.calls("run");
  const download = f.text("dl");
  expect(download.result).toEqual({ path: expect.stringMatching(/^browser_downloads\/[0-9a-f]{8}-report\.pdf$/), name: "report.pdf", mediaType: "application/pdf", size: 5 });
  expect(JSON.stringify(download)).not.toContain("contentBase64"); expect(JSON.stringify(download)).not.toContain("sig=secret");
  expect(readFileSync(join(f.workspace, download.result.path), "utf8")).toBe("%PDF!");
  // A browser_downloads symlink out of the workspace is refused, not followed.
  rmSync(join(f.workspace, "browser_downloads"), { recursive: true }); symlinkSync(f.sandbox, join(f.workspace, "browser_downloads"));
  f.call("browser__download", { site: "s", ref: "r" }, "dl2"); await f.host.calls("run");
  expect(f.text("dl2")).toMatchObject({ status: "failed" });
  expect(readdirSync(f.sandbox).filter(name => name.endsWith("report.pdf"))).toEqual([]);

  f.call("browser__screenshot", { site: "s" }, "shot"); await f.host.calls("run");
  const shot = f.resolved.get("shot");
  expect(shot.contentItems[1]).toEqual({ type: "inputImage", imageUrl: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}` });
  expect(shot.contentItems[0].text).not.toContain(Buffer.from("png-bytes").toString("base64"));

  f.call("browser__handoff_start", { site: "s" }, "handoff");
  const listed = await f.host.calls("run");
  expect(f.text("handoff").result).toMatchObject({ handoffId: "h-1" });
  expect(f.resolved.get("handoff").contentItems[0].text).not.toContain("live.example");
  const card = listed.find(c => c.id === "mau-handoff:handoff")!;
  expect(card).toMatchObject({ kind: "interaction", name: "item/tool/requestUserInput", input: { questions: [{ id: "handoff", options: [{ label: "取消接管" }] }] } });
  expect(JSON.stringify(card.input)).toContain("https://live.example/view/secret-token");
  await f.host.resolve("run", card.id, { answers: { handoff: { answers: ["取消接管"] } } });
  expect(f.resolved.has(card.id)).toBe(false);
  expect(f.executed).toEqual([{ tool: "handoff_cancel", input: { handoffId: "h-1" } }]);
  expect((await f.host.calls("run")).some(c => c.id === card.id)).toBe(false);
  // The catalog the model sees asks for a workspace path, not bytes.
  f.call("unused", {}, "noop"); f.pending().pop();
  const pendingTools = { id: "tools", runId: "run", kind: "tool", name: "connected_apps", status: "pending", input: { action: "tools" }, deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  f.pending().push(pendingTools); await f.host.calls("run");
  const upload = f.text("tools").tools.find((t: any) => t.name === "browser__upload");
  expect(upload.inputSchema.properties.path).toBeDefined(); expect(upload.inputSchema.properties.file).toBeUndefined();
  expect(upload.inputSchema.required).toEqual(["site", "ref", "path"]);
});

it("refuses the workspace relay when the sandbox is unavailable", async () => {
  const f = await fixture({ files: false }); await f.start();
  f.call("browser__upload", { site: "s", ref: "r", path: "cv.pdf" }); await f.host.calls("run");
  expect(f.text()).toMatchObject({ status: "failed", error: "browser_workspace_unavailable" });
});

it("mints write-capable caller tokens only through the owner path", async () => {
  const dir = temp(), key = await generateSigningKey("caller"), agent = "6f1f2d4e-6d1c-4f5b-9a7a-1f4f1a0c2b3d";
  privateFile(join(dir, "caller.json"), key.privateJwk);
  const config = { url: "http://127.0.0.1:18100", issuer: "mau", audience: "connectors", callerKeyFile: "caller.json",
    assignments: [{ agentId: agent, owner, connections: ["browser"] }], browserConnections: ["browser"] };
  const tokens: string[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    tokens.push(new Headers(init?.headers).get("authorization")!.slice(7));
    const body = JSON.parse(String(init!.body));
    if (!("id" in body)) return new Response(null, { status: 202 });
    const result = body.method === "initialize" ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
      : body.method === "tools/list" ? { tools: [{ name: "browser__click", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } }] }
      : { content: [], structuredContent: { status: "approval_required", operationId: "op", summary: "s", expiresAt: new Date().toISOString() } };
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  });
  const apps = new ConnectedApps(config, dir, true);
  expect(apps.browser(agent, owner)).toEqual(["browser"]);
  expect(await apps.reader(agent, owner)!({ action: "tools" }, undefined, { write: true })).toMatchObject({ tools: [{ name: "browser__click", risk: "write" }] });
  expect(await apps.reader(agent, owner)!({ action: "call", name: "browser__click", arguments: {} }, undefined, { write: true })).toMatchObject({ status: "approval_required" });
  expect(tokens.length).toBeGreaterThan(0);
  for (const token of tokens) expect(decodeJwt(token)).toMatchObject({ sub: agent, owner, connections: ["browser"], readOnly: false });
  // Without an approval presenter, Mau never builds the write-capable client.
  const readOnly = vi.spyOn(ConnectorCallerClient.prototype, "call");
  const unconfigured = new ConnectedApps(config, dir, false);
  expect(unconfigured.writable).toBe(false);
  await unconfigured.reader(agent, owner)!({ action: "call", name: "browser__click", arguments: {} }, undefined, { write: true }).catch(() => undefined);
  expect(readOnly).not.toHaveBeenCalled();
});

const webInteractions = new URL("../web/node_modules/@olorinm/agent-host/dist/interactions.js", import.meta.url);
it("renders Mau's cards in Router chat and maps each button to the answer Mau resolves", async () => {
  const { interaction } = await import("../node_modules/@agent-router/server/dist/communication/interaction.js" as string) as { interaction(call: unknown): { text: string; choices: Array<{ label: string; result: unknown }> } };
  const f = await fixture(); await f.start();
  f.call("browser__click", { site: "https://shop.example", ref: "buy" });
  f.call("browser__handoff_start", { site: "s" }, "handoff");
  const cards = (await f.host.calls("run")).filter(c => c.kind === "interaction");
  const approval = interaction(cards.find(c => c.name === "approval"));
  expect(approval.text).toContain("Click buy on https://shop.example"); expect(approval.text).toContain("browser__click");
  expect(approval.choices).toEqual([{ label: "允许一次", result: { choice: "once" } }, { label: "拒绝", result: { choice: "deny" } }]);
  const handoff = interaction(cards.find(c => c.id === "mau-handoff:handoff"));
  expect(handoff.text).toContain("https://live.example/view/secret-token");
  expect(handoff.choices).toEqual([{ label: "取消接管", result: { answers: { handoff: { answers: ["取消接管"] } } } }]);
});
it.skipIf(!existsSync(webInteractions))("renders Mau's cards in the web console with the same answers", async () => {
  const web = await import(webInteractions.href) as { describeInteraction(native: unknown): any; answerInteraction(request: unknown, answer: unknown): unknown };
  const f = await fixture(); await f.start();
  f.call("browser__click", { site: "https://shop.example", ref: "buy" });
  f.call("browser__handoff_start", { site: "s" }, "handoff");
  const cards = (await f.host.calls("run")).filter(c => c.kind === "interaction");
  const approval = web.describeInteraction({ method: "approval", params: cards.find(c => c.name === "approval")!.input });
  expect(approval).toMatchObject({ kind: "approval", title: "Click buy on https://shop.example" });
  expect(approval.choices.map((c: any) => c.id)).toEqual(["once", "deny"]);
  expect(web.answerInteraction(approval, { choice: "once" })).toEqual({ choice: "once" });
  const card = cards.find(c => c.id === "mau-handoff:handoff")!;
  const handoff = web.describeInteraction({ method: card.name, params: card.input });
  expect(handoff).toMatchObject({ kind: "questions", questions: [{ id: "handoff", options: [{ label: "取消接管" }] }] });
  expect(web.answerInteraction(handoff, { answers: { handoff: "取消接管" } })).toEqual({ answers: { handoff: { answers: ["取消接管"] } } });
});
