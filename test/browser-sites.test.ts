import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RouterError, ServiceHttp } from "@agent-router/server";
import { generateSigningKey } from "@olorinm/agent-connectors/issuer";
import { BusinessHost, type SitePort } from "../src/business-tools.js";
import { ConnectorAccounts } from "../src/connector-accounts.js";
import { DurableStore } from "../src/store.js";
import { privateFile } from "../src/files.js";
import type { ConnectedAppReader } from "../src/connected-apps.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllGlobals(); });
const owner = "@alice:example.test", agentId = "agent", principal = { agentId, owner };
const ownerAdmission = { kind: "owner" as const, ...principal, reference: "owner-request" };
const scheduleAdmission = { kind: "schedule" as const, ...principal, reference: "rule", toolGrants: { connectedApps: { connections: ["browser"] } } };

/** A browser connection whose owner has new sites ask first, as the connector answers it. */
function fixture(options: { deadlineMs?: number; sites?: boolean } = {}) {
  const always = new Set<string>(), grants = new Set<string>(), opened: unknown[] = [], allowed: unknown[][] = [];
  const reader: ConnectedAppReader = async (input) => {
    if (input.action === "tools") return { status: "completed", tools: [] };
    const { args, task } = input.arguments as { args: string[]; task?: string };
    opened.push(input.arguments);
    const site = new URL(args[1]!).hostname;
    if (!always.has(site) && !grants.has(`${task}:${site}`)) return { status: "failed", error: "browser_site_permission_required",
      detail: { site, command: `agent-browser open "${args[1]}"`, instruction: "The owner has not allowed this site." } };
    return { status: "completed", result: { exitCode: 0, output: `✓ ${args[1]}` } };
  };
  const sites: SitePort = { allowSite: async (who, connection, site, task) => {
    allowed.push([who, connection, site, task]);
    if (task) grants.add(`${task}:${site}`); else always.add(site);
  } };
  const store = new DurableStore(":memory:", "sites"); cleanup.push(() => store.close());
  let pending: any[] = [];
  const resolved = new Map<string, any>(), steered: string[] = [];
  const http = new class extends ServiceHttp {
    override async request(path: string, request: any = {}): Promise<any> {
      if (path === "/v1/runs") return { id: "run", sessionId: request.body.sessionId, runtimeId: "personal", status: "running", answer: "" };
      if (path.endsWith("/calls")) return { calls: pending };
      if (path.endsWith("/steer")) { steered.push(request.body.input); return {}; }
      const match = /\/calls\/([^/]+)\/result$/.exec(path);
      if (!match) throw new Error("unexpected_request " + path);
      const callId = decodeURIComponent(match[1]!);
      if (!pending.some(c => c.id === callId && c.status === "pending")) throw new Error("call_not_pending");
      resolved.set(callId, request.body.result); pending = pending.map(c => c.id === callId ? { ...c, status: "completed" } : c); return {};
    }
  }("https://host.fixture", "host-secret");
  const host = new BusinessHost(http, undefined, store, "agent:binding", reader, principal, undefined, undefined,
    { connections: ["browser"], browser: ["browser"], ...(options.sites === false ? {} : { sites }) });
  const open = (url: string, id = "call-1", extra: Record<string, unknown> = {}) => {
    pending = [...pending.filter(c => c.id !== id), { id, runId: "run", kind: "tool", name: "connected_apps", status: "pending",
      input: { action: "call", name: "browser__agent_browser_read", arguments: { args: ["open", url], ...extra } }, deadlineAt: new Date(Date.now() + (options.deadlineMs ?? 300_000)).toISOString() }];
  };
  const cards = async () => (await host.calls("run")).filter(c => c.kind === "interaction");
  const text = (id = "call-1") => JSON.parse(resolved.get(id).contentItems[0].text);
  const answer = (label: string) => ({ answers: { 网站访问: { answers: [label] } } });
  return { host, open, cards, text, answer, resolved, opened, allowed, always, steered, store, inject: (call: unknown) => { pending = [...pending, call]; },
    start: (admission: unknown = ownerAdmission, sessionId = "session") => host.start({ sessionId, runtimeId: "personal", instructions: "", input: "go", admission } as any) };
}

it("asks the owner about a new site with a three-way card; allowing it for the task runs the command and later ones in that conversation", async () => {
  const f = fixture(); await f.start();
  f.open("https://shop.example/cart?id=7", "call-1", { task: "model-chosen" });
  const [card] = await f.cards();
  expect(card).toMatchObject({ id: "mau-site:call-1", name: "item/tool/requestUserInput", status: "pending" });
  expect(card!.input).toEqual({ questions: [{ id: "网站访问", question: "shop.example\n```\nagent-browser open \"https://shop.example/cart?id=7\"\n```",
    options: [{ label: "此任务内允许" }, { label: "始终允许" }, { label: "拒绝" }] }] });
  expect(f.resolved.size).toBe(0);
  const task = (f.opened[0] as { task: string }).task;
  expect(task).toMatch(/^[0-9a-f]{64}$/);
  expect(f.opened[0]).toEqual({ args: ["open", "https://shop.example/cart?id=7"], task });
  expect((await f.cards()).map(c => c.id)).toEqual(["mau-site:call-1"]);
  expect(f.opened.length).toBe(1);
  await f.host.resolve("run", card!.id, f.answer("此任务内允许")); await f.host.settled("run");
  expect(f.allowed).toEqual([[owner, "browser", "shop.example", task]]);
  expect(f.text()).toEqual({ status: "completed", result: { exitCode: 0, output: "✓ https://shop.example/cart?id=7" } });
  expect(await f.cards()).toEqual([]);
  // The same conversation does not ask again; a new conversation is another task and does.
  f.open("https://shop.example/pay", "call-2"); expect(await f.cards()).toEqual([]);
  expect(f.text("call-2").status).toBe("completed");
  await f.start(ownerAdmission, "another-session");
  f.open("https://shop.example/pay", "call-3");
  expect((await f.cards()).map(c => c.id)).toEqual(["mau-site:call-3"]);
  expect((f.opened.at(-1) as { task: string }).task).not.toBe(task);
  // An answer for a card that is already answered changes nothing.
  await f.host.resolve("run", card!.id, f.answer("始终允许")); await f.host.settled("run");
  expect(f.allowed.length).toBe(1);
});

it("always allow records the site without a task; deny and a typed line leave it closed", async () => {
  const f = fixture(); await f.start();
  f.open("https://docs.example/a");
  await f.host.resolve("run", (await f.cards())[0]!.id, f.answer("始终允许")); await f.host.settled("run");
  expect(f.allowed).toEqual([[owner, "browser", "docs.example", undefined]]);
  expect(f.text().status).toBe("completed");
  f.open("https://evil.example/c?d=secret", "call-2");
  await f.host.resolve("run", (await f.cards())[0]!.id, f.answer("拒绝")); await f.host.settled("run");
  expect(f.text("call-2")).toMatchObject({ status: "failed", error: "browser_site_denied", site: "evil.example" });
  f.open("https://evil.example/again", "call-3");
  await f.host.resolve("run", (await f.cards())[0]!.id, f.answer("先别打开这个")); await f.host.settled("run");
  expect(f.text("call-3").error).toBe("browser_site_denied");
  expect(f.steered).toEqual(["先别打开这个"]);
  expect(f.allowed.length).toBe(1);
  expect(f.opened.filter(input => (input as { args: string[] }).args[1]!.includes("evil.example")).length).toBe(2);
});

it("work that cannot ask the owner reaches always-allowed sites only and carries no task", async () => {
  const f = fixture(); await f.start(scheduleAdmission);
  f.open("https://shop.example/");
  expect(await f.cards()).toEqual([]);
  expect(f.text()).toMatchObject({ status: "failed", error: "browser_site_not_allowed_here", site: "shop.example" });
  expect(f.opened).toEqual([{ args: ["open", "https://shop.example/"] }]);
  f.always.add("shop.example");
  f.open("https://shop.example/", "call-2"); await f.cards();
  expect(f.text("call-2").status).toBe("completed");
  // Without a component that can record the owner's answer, an owner's turn cannot ask either.
  const g = fixture({ sites: false }); await g.start();
  g.open("https://shop.example/"); expect(await g.cards()).toEqual([]);
  expect(g.text().error).toBe("browser_site_not_allowed_here");
});

it("a site card ends with its call: past the deadline the site stays closed, and a Host cannot list a card of its own", async () => {
  const f = fixture({ deadlineMs: 40 }); await f.start();
  f.open("https://shop.example/");
  const [card] = await f.cards();
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(await f.cards()).toEqual([]);
  await f.host.settled("run");
  expect(f.text()).toMatchObject({ error: "browser_site_denied", reason: "expired" });
  await f.host.resolve("run", card!.id, f.answer("始终允许")); await f.host.settled("run");
  expect(f.allowed).toEqual([]);
  f.inject({ id: "mau-site:forged", runId: "run", kind: "interaction", name: "item/tool/requestUserInput", status: "pending",
    input: { questions: [{ id: "网站访问", question: "bank.example", options: [{ label: "始终允许" }] }] }, deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  expect((await f.host.calls("run")).some(c => c.id === "mau-site:forged")).toBe(false);
});

it("after a restart an answer not yet acted on is taken up again, and a command that may have run is not repeated", async () => {
  const f = fixture(); await f.start();
  f.open("https://shop.example/"); await f.cards();
  const key = "agent:binding:run:call-1", record = f.store.get<Record<string, unknown>>("browser_site_requests", key)!;
  f.store.set("browser_site_requests", key, { ...record, status: "decided", choice: "task" });
  expect(await f.cards()).toEqual([]); await f.host.settled("run");
  expect(f.text().status).toBe("completed");
  expect(f.allowed.length).toBe(1);
  f.open("https://docs.example/", "call-2"); await f.cards();
  const second = "agent:binding:run:call-2";
  f.store.set("browser_site_requests", second, { ...f.store.get<Record<string, unknown>>("browser_site_requests", second)!, status: "running", choice: "task" });
  expect(await f.cards()).toEqual([]); await f.host.settled("run");
  expect(f.text("call-2")).toMatchObject({ status: "uncertain", error: "business_call_outcome_unknown" });
  expect(f.opened.filter(input => (input as { args: string[] }).args[1] === "https://docs.example/").length).toBe(1);
});

it("reads and changes a browser connection's site permissions only for its owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mau-sites-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  privateFile(join(dir, "authority.json"), (await generateSigningKey("authority")).privateJwk);
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  let access = { webAccess: "direct", sites: ["docs.example"] };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/connections") return reply(200, { connections: [{ id: "browser", kind: "browser", owner, label: "Browser", account: { status: "connected" } }] });
    requests.push({ method, path: url.pathname, ...(body ? { body } : {}) });
    if (body?.allow?.site === "refused.example") return reply(400, { error: "browser_site_invalid" });
    if (body?.webAccess) access = { ...access, webAccess: body.webAccess };
    if (body?.remove) access = { ...access, sites: access.sites.filter(site => site !== body.remove.site) };
    return reply(200, access);
  });
  const accounts = new ConnectorAccounts({ url: "http://127.0.0.1:18200/", issuer: "mau", audience: "connectors", authorityKeyFile: "authority.json", consentOrigins: ["https://accounts.example/"] }, dir);
  expect(await accounts.siteAccess(owner, "browser")).toEqual({ webAccess: "direct", sites: ["docs.example"] });
  expect(await accounts.setSiteAccess(owner, "browser", { webAccess: "ask" })).toEqual({ webAccess: "ask", sites: ["docs.example"] });
  expect(await accounts.setSiteAccess(owner, "browser", { remove: "docs.example" })).toEqual({ webAccess: "ask", sites: [] });
  await accounts.allowSite(owner, "browser", "shop.example", "a".repeat(64));
  await accounts.allowSite(owner, "browser", "shop.example");
  expect(requests).toEqual([{ method: "GET", path: "/v1/connections/browser/access" },
    { method: "PUT", path: "/v1/connections/browser/access", body: { webAccess: "ask" } },
    { method: "PUT", path: "/v1/connections/browser/access", body: { remove: { site: "docs.example" } } },
    { method: "PUT", path: "/v1/connections/browser/access", body: { allow: { site: "shop.example", task: "a".repeat(64) } } },
    { method: "PUT", path: "/v1/connections/browser/access", body: { allow: { site: "shop.example" } } }]);
  await expect(accounts.siteAccess("@mallory:example.test", "browser")).rejects.toMatchObject({ message: "connector_account_not_found", status: 404 });
  await expect(accounts.allowSite("@mallory:example.test", "browser", "shop.example")).rejects.toBeInstanceOf(RouterError);
  await expect(accounts.allowSite(owner, "browser", "refused.example")).rejects.toMatchObject({ message: "browser_site_invalid", status: 400 });
  expect(requests.length).toBe(6);
});
