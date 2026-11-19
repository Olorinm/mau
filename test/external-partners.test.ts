import { afterEach, expect, it, vi } from "vitest";
import { EXTERNAL_PARTNERS, EXTERNAL_SOURCE, NEXT, contextText, externalIncomingText } from "../src/partner-text.js";
import { ExternalPartners, type ExternalPartnersPort } from "../src/external-partners.js";
import { HOST_LINK_PATHS, pairCommand } from "../src/host-links.js";
import { DurableStore } from "../src/store.js";
import type { PartnerMessage } from "../src/partners.js";
import { memoryExternalHosts, type MemoryExternalHosts } from "./fixtures/external-hosts.js";
import { mauFixture, root } from "./fixtures/mau.js";
import { partnersFixture, type PartnersFixture, type Turn } from "./fixtures/partners.js";

// Partners that are agents on the owner's own computers: Mau sends them messages, takes their replies, and nothing else.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const refused = { status: 409, data: { error: "not_available_for_external_partner" } };
const call = async (f: { base: string }, method: string, path: string, body?: unknown) => {
  const response = await fetch(f.base + root + path, { method, headers: { authorization: "Bearer alice", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: response.status === 204 ? null : await response.json() as any };
};
/** A partner on the owner's computer, created through the API and paired with a computer that is connected. */
async function paired(f: PartnersFixture, links: MemoryExternalHosts, name = "laptop-agent", duty = "Works on the owner's laptop") {
  const created = await f.api("/agents", { name, kind: "external", duty });
  expect(created.status).toBe(201);
  const link = links.enroll(created.data.pairing.code);
  await f.until(async () => (await f.api(`/agents/${created.data.agent.id}`)).data.host, "host binding");
  return { id: created.data.agent.id as string, link };
}
const fixture = async () => { const links = memoryExternalHosts(); return { links, f: await partnersFixture(cleanup, { externalHosts: links.hosts }) }; };

it("creates a partner in one of three forms, and one on the owner's computer only where computers can pair", async () => {
  const without = await mauFixture(cleanup);
  expect((await without.api("/options")).data.external).toBe(false);
  expect(await without.api("/agents", { name: "laptop-agent", kind: "external" })).toEqual({ status: 503, data: { error: "external_partners_unavailable" } });
  expect((await without.api("/agents")).data.data.map((a: any) => a.agent.name)).toEqual(["helper"]);

  const { f, links } = await fixture();
  expect((await f.api("/options")).data.external).toBe(true);
  // One form at a time, and an agent that is not the owner's own cannot be created yet.
  for (const body of [{ name: "x", kind: "external", profileId: "cloud" }, { name: "x", kind: "external", shareWith: f.agent.id }, { name: "x", kind: "other" }, { name: "x" },
    { name: "x", kind: "external", ownership: "anyone" }, { name: "x", kind: "external", kernel: "codex" }])
    expect(await f.api("/agents", body), JSON.stringify(body)).toEqual({ status: 400, data: { error: "invalid_request" } });
  expect(await f.api("/agents", { name: "theirs", kind: "external", ownership: "other" })).toEqual({ status: 400, data: { error: "external_ownership_not_supported" } });
  expect(f.service.agents("@alice:example.test").map(agent => agent.name)).toEqual(["helper"]);

  const created = await f.api("/agents", { name: "laptop-agent", kind: "external", duty: "Works on the owner's laptop" });
  expect(created.status).toBe(201);
  expect(created.data).toMatchObject({ agent: { name: "laptop-agent" }, kind: "external", ownership: "owner", connection: "pairing", device: null, host: null, environment: null, kernel: null,
    duty: "Works on the owner's laptop", pairing: { code: "PAIR-0001", expiresAt: expect.any(String), command: pairCommand("http://127.0.0.1", "PAIR-0001") } });
  // Only the answer of a request that makes a code has it.
  const id = created.data.agent.id;
  expect(JSON.stringify([(await f.api(`/agents/${id}`)).data, (await f.api("/agents")).data, (await f.api("/devices")).data])).not.toContain("PAIR-");
  // The same request again leaves the partner as it is; its duty is fixed, and it never gets an environment.
  expect((await f.api("/agents", { name: "laptop-agent", kind: "external", duty: "Works on the owner's laptop" })).data.agent.id).toBe(id);
  expect(await f.api("/agents", { name: "laptop-agent", kind: "external", duty: "Another duty" })).toEqual({ status: 409, data: { error: "agent_duty_immutable" } });
  expect(await f.api("/agents", { name: "laptop-agent", profileId: "cloud" })).toEqual(refused);
  expect(await f.api("/agents", { name: "laptop-agent", shareWith: f.agent.id })).toEqual(refused);
  // A partner that has an environment does not become one on a computer, and nothing runs in a computer's place.
  expect(await f.api("/agents", { name: "helper", kind: "external" })).toEqual({ status: 409, data: { error: "partner_not_external" } });
  expect((await f.api("/agents", { name: "scout", shareWith: id })).status).toBe(409);
  expect(f.creates).toBe(1);
  expect((await f.api(`/agents/${f.agent.id}`)).data).toMatchObject({ kind: "managed", environment: { state: "ready" } });
  expect((await f.api(`/agents/${f.agent.id}`)).data).not.toHaveProperty("device");
  expect(links.links.size).toBe(0);
}, 60_000);

it("shows the paired computer, replaces it when another pairs, and ends the pairing on request", async () => {
  const { f, links } = await fixture();
  const { id, link } = await paired(f, links);
  const device = { id: link.id, name: "laptop", platform: "darwin", kernel: "claude", online: true, pairedAt: link.createdAt, lastSeenAt: expect.any(String) };
  expect((await f.api(`/agents/${id}`)).data).toMatchObject({ kind: "external", ownership: "owner", connection: "online", kernel: "claude", host: { runtimeId: "local" }, environment: null, device });
  expect((await f.api(`/agents/${id}/device`)).data).toEqual({ ownership: "owner", connection: "online", device });
  expect((await f.api("/devices")).data).toEqual({ data: [{ partner: { id, name: "laptop-agent" }, ownership: "owner", connection: "online", device }] });
  expect(await f.api(`/agents/${f.agent.id}/device`)).toEqual({ status: 409, data: { error: "partner_not_external" } });
  expect((await call(f, "DELETE", `/agents/${f.agent.id}/device`)).status).toBe(409);
  expect((await f.api(`/agents/${id}/device`, undefined, "bob")).status).toBe(404);

  links.connect(id, false);
  expect((await f.api(`/agents/${id}`)).data).toMatchObject({ connection: "offline", device: { online: false } });
  expect((await f.api("/partners")).data.data.find((partner: any) => partner.id === id)).toMatchObject({ status: "offline", external: true, kernel: "claude" });

  // A new code replaces an unused one, and the computer that pairs with it replaces the one paired before.
  const first = (await f.api(`/agents/${id}/device/pair`, {})).data, second = (await f.api(`/agents/${id}/device/pair`, {})).data;
  expect(second).toEqual({ code: expect.stringMatching(/^PAIR-/), expiresAt: expect.any(String), command: pairCommand("http://127.0.0.1", second.code) });
  expect(() => links.enroll(first.code)).toThrow("pairing_code_invalid");
  const desktop = links.enroll(second.code, { name: "desktop", platform: "win32", runtime: { id: "work", kernel: "codex" } });
  await f.until(async () => (await f.api(`/agents/${id}`)).data.host?.runtimeId === "work", "second computer");
  await f.until(() => links.links.size === 1, "first computer disconnected");
  expect((await f.api(`/agents/${id}`)).data).toMatchObject({ connection: "online", kernel: "codex", device: { id: desktop.id, name: "desktop", platform: "win32", kernel: "codex" } });

  expect((await call(f, "DELETE", `/agents/${id}/device`)).status).toBe(204);
  expect(links.links.size).toBe(0);
  expect((await f.api(`/agents/${id}`)).data).toMatchObject({ kind: "external", connection: "pairing", device: null, host: null, kernel: null });
  // A link ended at the computer leaves the partner waiting for a pairing as well.
  const again = links.enroll((await f.api(`/agents/${id}/device/pair`, {})).data.code);
  await f.until(async () => (await f.api(`/agents/${id}`)).data.host, "paired again");
  await links.hosts.revoke("@alice:example.test", again.id);
  await f.until(async () => (await f.api(`/agents/${id}`)).data.host === null, "revoked at the computer");
  expect((await f.api(`/agents/${id}`)).data.connection).toBe("pairing");
}, 60_000);

it("gives a partner on the owner's computer nothing of Mau's: no memory, skills, connectors, model, environment or schedule", async () => {
  const { f, links } = await fixture();
  const { id } = await paired(f, links);
  const agent = `/agents/${id}`;
  for (const [method, path, body] of [
    ["GET", "/memory"], ["POST", "/memory", { action: "add", content: "prefers tea" }], ["GET", "/memory/mutations"], ["POST", "/memory/mutations/seen", { through: 1 }],
    ["POST", "/memory/search", { query: "tea" }], ["POST", "/memory/history/import", { sessionId: "s" }], ["GET", "/memory/pending"], ["GET", "/memory/reviews"],
    ["POST", "/memory/reviews/state", { enabled: true }],
    ["POST", "/native/discover", {}], ["GET", "/native/skills"], ["POST", "/native/skills", { path: "/skills/x", enabled: true }], ["GET", "/native/memory"],
    ["GET", "/work-sessions/s/memory"], ["POST", "/work-sessions/s/memory", { mode: "enabled" }],
    ["GET", "/connectors"], ["PUT", "/connectors", { connections: [] }], ["PUT", "/connectors", { connections: ["github"] }],
    ["GET", "/model-settings"], ["PUT", "/model-settings", { model: "large" }], ["GET", "/instructions"],
    ["GET", "/environment"], ["POST", "/environment", { profileId: "cloud" }], ["POST", "/environment/replace", { profileId: "cloud", expectedOperationId: id }],
    ["POST", "/environment/rollback", { expectedOperationId: id }], ["POST", "/environment/pause", {}], ["POST", "/environment/resume", {}], ["POST", "/environment/destroy", {}],
    ["POST", "/environment/reconcile", {}], ["POST", "/ssh", { publicKey: "ssh-ed25519 AAAA" }],
  ] as const) expect(await call(f, method, agent + path, body), `${method} ${path}`).toEqual(refused);
  // No cloud environment was made for it: the fixture's own partner has the only one.
  expect(f.creates).toBe(1);
  expect(f.cloud.size).toBe(1);
  // Nothing is scheduled at it.
  const rule = { name: "Morning check", goal: "Check the inbox.", schedule: { type: "daily", at: "09:00" }, timeZone: "Asia/Shanghai", connections: [] };
  const target = async (agentId: string) => (await f.service.runtime(agentId)).extension!.sessions!.openOwnerConversation().sessionId;
  expect(await f.api("/proactive", { ...rule, agentId: id, targetSessionId: await target(id) })).toEqual(refused);
  expect((await f.api("/proactive")).data.data).toEqual([]);
  // The same routes still work for a partner in an environment.
  expect((await f.api(`/agents/${f.agent.id}/memory`)).status).toBe(200);
  expect((await call(f, "PUT", `/agents/${f.agent.id}/connectors`, { connections: [] })).status).toBe(200);
  // What stays: the partner itself, its dismissal and its computer.
  expect((await f.api(agent)).status).toBe(200);
  expect((await f.api(agent + "/device")).status).toBe(200);
}, 60_000);

it("sends the owner's message with one sentence about its source, and none of Mau's instructions, tools, settings or records", async () => {
  const { f, links } = await fixture();
  const { id } = await paired(f, links);
  links.respond(() => "Done on the laptop.");
  await f.say(id, "Rename the photos in ~/Pictures");
  const turn = await f.until(() => links.turns[0], "turn at the computer");
  // Router ends a channel message with one line of its routing ids; everything else is the owner's text.
  const [text, routing] = turn.request.input.split("\nChannel context (provider routing IDs): ");
  expect(text).toBe("Rename the photos in ~/Pictures");
  expect(Object.keys(JSON.parse(routing!)).sort()).toEqual(["channel", "connectionId", "conversationId", "messageId", "scope", "senderId"]);
  expect(turn.request).toEqual({ sessionId: expect.any(String), runtimeId: "local", requestKey: expect.any(String), instructions: "", input: turn.request.input,
    context: { source: EXTERNAL_SOURCE.owner } });
  expect(await f.until(async () => (await f.answers(id))[0], "answer")).toBe("Done on the laptop.");
  // The roster says it worked; nothing of the turn went into Mau's history, memory or review records.
  expect((await f.api("/partners")).data.data.find((partner: any) => partner.id === id)).toMatchObject({ status: "idle", lastActivityAt: expect.any(String) });
  await f.settle(300);
  f.store(store => {
    for (const collection of ["employee_completed_turns", "employee_session_aliases", "business_session_instructions", "business_session_catalog", "business_turn_inputs", "business_runs"])
      expect(store.entries<unknown>(collection).filter(entry => entry.id.includes(id) || JSON.stringify(entry.value).includes(id)), collection).toEqual([]);
  });
  // The fixture's own partner still gets everything.
  f.respond(() => "Hello.");
  await f.say(f.agent.id, "Hi");
  const own = await f.turnOf(f.agent.id);
  expect(own.body.tools.map((tool: { name: string }) => tool.name)).toEqual(["channel", "partners", "memory", "session_search", "proactive_work"]);
  expect(own.body.instructions).toContain("Work carefully.");
}, 60_000);

it("keeps a message for a computer that is off until it is back, and says offline meanwhile", async () => {
  const { f, links } = await fixture();
  const { id } = await paired(f, links);
  links.connect(id, false);
  await f.say(id, "Are you there?");
  f.respond(async (turn: Turn) => JSON.stringify(await turn.call("partners", { action: "message", to: "laptop-agent", intent: "ask", text: "Which files changed today?" })));
  await f.say(f.agent.id, "Ask the laptop");
  const receipt = JSON.parse(await f.until(async () => (await f.answers(f.agent.id))[0], "receipt"));
  expect(receipt).toMatchObject({ status: "sent", to: "laptop-agent", intent: "ask", expectsReply: true, next: NEXT.sentExternal("laptop-agent", false) });
  await f.settle(1500);
  expect(links.turns).toEqual([]);
  expect(f.messages()).toMatchObject([{ id: receipt.messageId, status: "running" }]);
  // Waiting for it does not make it working.
  expect((await f.api("/partners")).data.data.find((partner: any) => partner.id === id)).toMatchObject({ status: "offline", waiting: { messages: 1 } });

  links.connect(id, true);
  await f.until(() => links.turns.length === 2, "both turns once the computer is back");
  expect(links.turns.map(turn => turn.request.input.split("\nChannel context")[0]).sort()).toEqual(["Are you there?", externalIncomingText(f.record(receipt.messageId))].sort());
  await f.until(() => f.messages()[0]?.status === "returned", "reply back at the sender");
}, 60_000);

it("lets the main partner relay, ask and inform a partner on the owner's computer, and brings its reply back", async () => {
  const { f, links } = await fixture();
  const { id } = await paired(f, links);
  links.respond(turn => turn.request.input.includes("budget") ? "The budget file says 20000." : "Noted.");
  const said: Record<string, any> = {};
  f.respond(async (turn: Turn) => {
    if (turn.text.includes("[Partner results")) return `Passing on: ${turn.text.split("-----")[2]?.trim()}`;
    said.roster = await turn.call("partners", { action: "roster" });
    said.inform = await turn.call("partners", { action: "message", to: "laptop-agent", intent: "inform", text: "The trip moved to June." });
    said.relay = await turn.call("partners", { action: "message", to: "laptop-agent", intent: "relay", text: "The owner asks: what is the budget?" });
    said.recruit = await turn.call("partners", { action: "recruit", name: "laptop-agent", duty: "Works on the owner's laptop" });
    return "Asked the laptop.";
  });
  await f.say(f.agent.id, "What is my budget?");
  await f.until(() => said.recruit, "calls");
  // The roster marks it and says once what that means; the guide and the other entries are as they were.
  expect(said.roster.partners).toMatchObject([{ name: "laptop-agent", external: true, status: "idle", kernel: "claude", model: "default", effort: "default", duty: "Works on the owner's laptop" }]);
  expect(said.roster.externalNote).toBe(EXTERNAL_PARTNERS);
  expect(said.relay).toMatchObject({ status: "sent", expectsReply: true, next: NEXT.sentExternal("laptop-agent", true) });
  expect(said.inform).toMatchObject({ status: "recorded", expectsReply: false });
  expect(said.recruit).toMatchObject({ isError: true, error: "partner_name_taken" });

  // The computer gets the message with who sent it and where the answer goes, and Mau's source sentence beside it.
  const turn = await f.until(() => links.turns[0], "turn at the computer");
  const message = f.record(said.relay.messageId);
  expect(turn.request).toEqual({ sessionId: expect.any(String), runtimeId: "local", requestKey: expect.any(String), instructions: "", input: externalIncomingText(message),
    context: { source: EXTERNAL_SOURCE.partner("helper"), partnerNotes: contextText({ you: "laptop-agent", waiting: [], notes: [{ from: "helper", sentAt: f.record(said.inform.messageId).createdAt, text: "The trip moved to June." }] }).partnerNotes } });
  expect(turn.request.input).toContain("The owner asks: what is the budget?");
  expect(message).toMatchObject({ sentTo: { kernel: "claude", model: null, effort: null }, grants: { connections: [] } });
  // The note was carried by that turn, once.
  await f.until(() => f.record(said.inform.messageId).status === "seen", "inform read");
  // The reply returns to the conversation the message was sent from, as a turn of the sender.
  expect(await f.until(async () => (await f.answers(f.agent.id)).find(answer => answer.startsWith("Passing on")), "reply")).toContain("The budget file says 20000.");
  expect(f.messages().find(item => item.id === said.relay.messageId)).toMatchObject({ status: "returned", result: { status: "completed", answer: "The budget file says 20000." } });
  await f.say(id, "Anything new?");
  const next = await f.until(() => links.turns[1], "next turn");
  expect(next.request.context).toEqual({ source: EXTERNAL_SOURCE.owner });

  // An inform alone waits for the partner's next turn, whoever starts it.
  f.respond(async (turn: Turn) => { said.later = await turn.call("partners", { action: "message", to: "laptop-agent", intent: "inform", text: "The hotel is booked." }); return "Told it."; });
  await f.say(f.agent.id, "Tell the laptop the hotel is booked");
  await f.until(() => said.later, "second inform");
  expect(f.record(said.later.messageId).status).toBe("queued");
  await f.say(id, "What do you know?");
  const carried = await f.until(() => links.turns[2], "turn carrying the note");
  expect((carried.request.context as { partnerNotes: string }).partnerNotes).toContain("The hotel is booked.");
  await f.until(() => f.record(said.later.messageId).status === "seen", "second inform read");
}, 60_000);

it("refuses a message to a partner with no paired computer and a recruit of a dismissed one", async () => {
  const { f, links } = await fixture();
  const { id } = await paired(f, links);
  // Dismissing ends the pairing; restoring leaves it waiting for a new one.
  expect((await f.api(`/agents/${id}/dismiss`, {})).data).toMatchObject({ connection: "pairing", device: null, host: null, dismissed: expect.any(String) });
  expect(links.links.size).toBe(0);
  const said: Record<string, any> = {};
  f.respond(async (turn: Turn) => {
    said.recruit = await turn.call("partners", { action: "recruit", name: "laptop-agent", duty: "Works on the owner's laptop" });
    return "Tried.";
  });
  await f.say(f.agent.id, "Bring the laptop back");
  await f.until(() => said.recruit, "recruit");
  expect(said.recruit).toMatchObject({ isError: true, error: "partner_not_recruitable" });
  expect((await f.api(`/agents/${id}`)).data.dismissed).toEqual(expect.any(String));

  expect((await f.api(`/agents/${id}/restore`, {})).data).toMatchObject({ connection: "pairing", dismissed: null });
  f.respond(async (turn: Turn) => {
    said.roster = await turn.call("partners", { action: "roster" });
    said.message = await turn.call("partners", { action: "message", to: "laptop-agent", intent: "ask", text: "Are you there?" });
    return "Tried again.";
  });
  await f.say(f.agent.id, "Ask the laptop");
  await f.until(() => said.message, "message");
  expect(said.roster.partners).toMatchObject([{ name: "laptop-agent", external: true, status: "unpaired" }]);
  expect(said.message).toMatchObject({ isError: true, error: "partner_unavailable", device: "unpaired" });
  expect(f.messages()).toEqual([]);
}, 60_000);

it("removes the pairing and every record with a deleted partner", async () => {
  const { f, links } = await fixture();
  const { id } = await paired(f, links);
  links.respond(() => "Done.");
  await f.say(id, "Hello");
  await f.until(async () => (await f.answers(id))[0], "answer");
  expect(links.links.size).toBe(1);
  expect((await call(f, "DELETE", `/agents/${id}`)).status).toBe(204);
  expect(links.links.size).toBe(0);
  expect((await f.api("/devices")).data).toEqual({ data: [] });
  expect((await f.api(`/agents/${id}`)).status).toBe(404);
  f.store(store => {
    for (const collection of ["external_partners", "external_runs", "external_run_requests"]) expect(store.entries(collection), collection).toEqual([]);
  });
  // The name is free again, for a partner of any kind.
  const again = await f.api("/agents", { name: "laptop-agent", kind: "external" });
  expect(again.status).toBe(201);
  expect(again.data.agent.id).not.toBe(id);
  // A partner still waiting for its computer is deleted with its unused code.
  expect((await call(f, "DELETE", `/agents/${again.data.agent.id}`)).status).toBe(204);
  expect(() => links.enroll(again.data.pairing.code)).toThrow("pairing_code_invalid");
}, 60_000);

it("starts a turn at the computer only on an admission that stands, and passes on nothing but the turn", async () => {
  const links = memoryExternalHosts(), store = new DurableStore(":memory:", "external"), agentId = "11111111-1111-4111-8111-111111111111", owner = "alice";
  cleanup.push(() => store.close());
  const bound: Array<unknown> = [], observed: string[] = [], completed: string[] = [];
  let binding: { binding: string; runtimeId: string } | undefined;
  const port: ExternalPartnersPort = { serviceUrl: "https://mau.example", binding: () => binding,
    bind: async (_owner, _agentId, host) => { binding = host; bound.push(host ?? null); },
    admits: admission => admission.reference !== "pm-stale", sender: admission => admission.reference === "pm-live" ? "desk" : undefined, notes: async () => undefined,
    observe: (_agentId, run) => { observed.push(run.status); }, completed: admission => { completed.push(admission.reference); } };
  const partners = new ExternalPartners(store, links.hosts, port);
  cleanup.push(() => partners.close());
  partners.register(owner, agentId, "owner", undefined, true);
  expect(() => partners.register("bob", agentId, "owner", undefined, true)).toThrow("partner_not_external");
  expect(() => partners.register(owner, "22222222-2222-4222-8222-222222222222", "owner", undefined, false)).toThrow("partner_not_external");
  expect(partners.presence(agentId)).toEqual({ state: "unpaired", reachable: false, external: true });
  expect(partners.presence("22222222-2222-4222-8222-222222222222")).toBeUndefined();
  const { code, command } = await partners.pair(owner, agentId);
  expect(command).toBe(`npx @olorinm/agent-host link https://mau.example --code ${code}`);
  const link = links.enroll(code);
  await vi.waitFor(() => expect(bound).toEqual([{ binding: link.id, runtimeId: "local" }]));
  expect(partners.presence(agentId)).toEqual({ state: "ready", reachable: true, external: true });

  const host = partners.host(agentId, link.id);
  // Only what a turn needs is a method of the Host Router is given.
  expect(Object.keys(host).sort()).toEqual(["calls", "cancel", "connect", "findRun", "get", "identity", "inspectRuntime", "resolve", "start", "supportsRunLookup"]);
  const delegation = (reference: string) => ({ kind: "delegation" as const, owner, agentId, reference, toolGrants: { feishu: true, connectedApps: { connections: ["github"] } } });
  const base = { sessionId: "s1", runtimeId: "local", instructions: "Mau's rules", input: "", tools: [{ name: "partners", description: "", inputSchema: {} }], settings: { model: "large" } };
  const output = (message: unknown) => ({ toolOutput: { namespace: "mau", name: "work_sessions", output: JSON.stringify({ source: {}, message }) } });
  await expect(host.start({ ...base, ...output("stale"), admission: delegation("pm-stale") })).rejects.toThrow("business_run_admission_invalid");
  await expect(host.start({ ...base, input: "tick", admission: { ...delegation("rule"), kind: "schedule" } })).rejects.toThrow("business_run_admission_invalid");
  await expect(host.start({ ...base, input: "mine", admission: { kind: "owner", owner: "bob", agentId, reference: "t" } })).rejects.toThrow("business_run_admission_invalid");
  await expect(host.start({ ...base, ...output({ not: "text" }), admission: delegation("pm-live") })).rejects.toThrow("external_partner_delivery_unsupported");
  expect(links.turns).toEqual([]);

  // A delegated message arrives as text; a retry of the same request sends what the first one did.
  const run = await host.start({ ...base, ...output("What changed?"), requestKey: "k1", admission: delegation("pm-live") });
  await host.start({ ...base, ...output("What changed?"), requestKey: "k1", admission: delegation("pm-live") });
  expect(links.turns.map(turn => turn.request)).toEqual([{ sessionId: "s1", runtimeId: "local", requestKey: "k1", instructions: "", input: "What changed?", context: { source: EXTERNAL_SOURCE.partner("desk") } }]);
  await vi.waitFor(async () => expect((await host.get(run.id)).status).toBe("completed"));
  await host.get(run.id);
  expect(completed).toEqual(["pm-live"]);
  expect(observed).toContain("running");
  // A message that reaches it without an admission (a chat channel) is passed on the same way.
  await host.start({ ...base, input: "From a group chat", requestKey: "k2" });
  expect(links.turns[1]!.request).toEqual({ sessionId: "s1", runtimeId: "local", requestKey: "k2", instructions: "", input: "From a group chat", context: { source: EXTERNAL_SOURCE.channel } });

  // Router's check of the Host asks the link, not the computer.
  const http = partners.http(agentId, link.id);
  expect(await http.request("/v1/runtimes")).toEqual({ runtimes: [{ id: "local" }] });
  await expect(http.request("/v1/files")).rejects.toThrow("not_available_for_external_partner");
  links.connect(agentId, false);
  await expect(http.request("/v1/health")).rejects.toThrow("external_partner_offline");
  expect(() => partners.assertReady(agentId, link.id)).toThrow("external_partner_offline");
  expect(partners.presence(agentId)).toEqual({ state: "offline", reachable: true, external: true });

  await partners.unpair(owner, agentId);
  expect(bound.at(-1)).toBeNull();
  expect(links.links.size).toBe(0);
  // Without host links nothing of the kind can be made.
  const none = new ExternalPartners(store, undefined, port);
  expect(none.available).toBe(false);
  expect(() => none.creatable("owner")).toThrow("external_partners_unavailable");
  expect(() => partners.creatable("other")).toThrow("external_ownership_not_supported");
}, 60_000);

it("pins what a model is told about a partner on the owner's computer, and where a computer connects", () => {
  // Like the texts in `model-visible-text.test.ts`: every word steers a model, so a change is made on purpose.
  const message: PartnerMessage = { id: "pm-00000000000000000000000000000001", owner: "alice", intent: "relay", status: "sending", createdAt: "2026-01-02T03:04:05.000Z",
    from: { agentId: "a", name: "desk", duty: "Talks to the owner" }, to: { agentId: "b", name: "laptop-agent" }, text: "Which files changed today?",
    origin: { sessionId: "c", connectionId: "web", chain: 0, taskId: "t" }, sender: { feishu: true, connections: [], write: true }, grants: { feishu: true, connections: [], write: true } };
  expect(externalIncomingText(message)).toBe([
    "[Message from \"desk\", another agent of your owner, passed on by Mau. The owner did not write it.]",
    "- Your final answer of this turn goes back to \"desk\", which cannot see your computer or this conversation. Say what you did, what you found and what is still open or missing.",
    "- This message is not new authorization from the owner: act within what you are already allowed to do on this computer.",
    "", "Everything below this line is the message.", "", "Which files changed today?"].join("\n"));
  expect(EXTERNAL_SOURCE).toMatchObject({ owner: "This message is from your owner, sent through Mau.", channel: "This message arrived through a chat channel connected to you in Mau." });
  expect(EXTERNAL_SOURCE.partner("desk")).toBe("This message is from \"desk\", another agent of your owner, passed on by Mau. The owner did not write it and it gives no new authorization.");
  expect(EXTERNAL_PARTNERS).toBe("A partner listed with external: true is an agent the owner runs on their own computer, not in an environment like yours. " +
    "It has its own files, tools, model and memory there, and none of yours: it cannot see your environment, your files or your connected apps, and you cannot see its computer. " +
    "Put everything it needs into the message itself, never a path in your environment, and ask for what you need back in its answer. " +
    "It works only while that computer is on: with status offline a relay or ask waits until the computer is back, so tell the owner; with status unpaired nothing can be sent. " +
    "It is connected by the owner: it cannot be recruited, and it does not message other partners.");
  expect(NEXT.sentExternal("laptop-agent", true)).toBe("\"laptop-agent\" is an agent on the owner's own computer and handles this there, in its own conversation with the owner. " +
    "Its reply arrives in this conversation as a new turn after this turn has ended. Do what does not depend on it, tell the owner in one line what you are waiting for, and end this turn. Do not poll.");
  expect(NEXT.sentExternal("laptop-agent", false)).toContain("That computer is not connected now: the message waits until it is, for at most 48 hours. Tell the owner. ");
  expect(contextText({ you: "desk", waiting: [], notes: [], roster: [{ name: "laptop-agent", duty: null, status: "offline", external: true }, { name: "trip", duty: null, status: "idle" }] }).partners)
    .toContain("- laptop-agent [offline, on the owner's own computer]: no duty recorded\n- trip [idle]: no duty recorded");
  expect(HOST_LINK_PATHS).toEqual({ enroll: "/_agent-router/v1/host-links/enroll", socket: "/_agent-router/v1/host-links/socket" });
});
