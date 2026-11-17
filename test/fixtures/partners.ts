// Fixture for partners working together: Mau with the partner tools on, Router's ledger web channel for the owner's
// messages, and a Host whose runs follow a script, so a turn can call tools and end when the test says so.
import { join } from "node:path";
import { expect } from "vitest";
import { ledgerApi, newIdempotencyKey, type ChatEvent } from "../../web/src/api/ledger";
import { DurableStore } from "../../src/store.js";
import type { PartnerMessage } from "../../src/partners.js";
import { mauFixture } from "./mau.js";

/** One run as the fixture's Host sees it. */
export interface Turn {
  runId: string; agentId: string;
  /** The Host request as Mau sent it. */
  body: any;
  /** What the turn was given: the owner's text, or the message of a delivery (tool output or text). */
  text: string;
  /** What Mau told the turn beside its input. */
  told: Record<string, unknown>;
  /** Call a tool of the run and wait for Mau's answer. */
  call(name: string, input: unknown): Promise<any>;
}
type Script = (turn: Turn) => Promise<string> | string;
interface Run { record: Record<string, unknown>; calls: Array<Record<string, unknown>>; answers: Map<string, (value: unknown) => void>; requestKey?: string;
  /** What the run did, as a Host reports it: a tool call when it starts and when its answer has arrived. */
  events: Array<Record<string, unknown>> }

export function scriptedHost() {
  const runs = new Map<string, Run>(), turns: Turn[] = [], discoveries: Record<string, unknown> = {};
  let script: Script = turn => `answer to ${turn.text}`, deadlineMs = 90_000, expired: (call: { name: string; input: any }) => boolean = () => false;
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const host = (url: URL, init?: RequestInit): Response => {
    const method = init?.method ?? "GET", path = url.pathname.replace(/^\/[^/]+/, "");
    if (path === "/v1/runs" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      const prior = [...runs.values()].find(run => body.requestKey && run.requestKey === body.requestKey);
      if (prior) return json(prior.record);
      const id = `run-${runs.size + 1}`, run: Run = { record: { id, sessionId: body.sessionId, runtimeId: body.runtimeId, status: "running", answer: "" },
        calls: [], answers: new Map(), events: [], ...(body.requestKey ? { requestKey: body.requestKey } : {}) };
      runs.set(id, run);
      const context = typeof body.context === "object" && body.context ? body.context : {}, request = context.requestContext ?? context;
      const delivered = body.toolOutput ? JSON.parse(body.toolOutput.output).message : undefined;
      const turn: Turn = { runId: id, agentId: request.agentId, body, text: delivered ?? body.input, told: context.requestContext ? context : {},
        call: (name, input) => new Promise(resolve => {
          const callId = `${id}-call-${run.calls.length + 1}`;
          run.events.push({ type: "tool.started", runId: id, callId, tool: name, input });
          run.answers.set(callId, value => { run.events.push({ type: "tool.finished", runId: id, callId, tool: name, result: value }); resolve(JSON.parse((value as any).contentItems[0].text)); });
          run.calls.push({ id: callId, runId: id, kind: "tool", name, input, status: "pending", deadlineAt: new Date(Date.now() + deadlineMs).toISOString() });
        }) };
      turns.push(turn);
      void Promise.resolve().then(() => script(turn)).then(
        answer => { if (run.record.status === "running") Object.assign(run.record, { status: "completed", answer }); },
        // A script that throws fails its run; an error marked `outcomeUnknown` leaves the run's outcome unknown.
        (error: unknown) => { if (run.record.status === "running") Object.assign(run.record, { status: "failed", outcome: { status: "failed", error: error instanceof Error ? error.message : "failed",
          ...((error as { outcomeUnknown?: boolean }).outcomeUnknown ? { outcomeUnknown: true } : {}) } }); });
      return json(run.record);
    }
    if (path === "/v1/runs/by-request") return json({ run: [...runs.values()].find(run => run.requestKey === url.searchParams.get("requestKey"))?.record ?? null });
    if (path === "/v1/runtimes/discover" && discoveries[String(JSON.parse(String(init?.body)).runtimeId)]) return json(discoveries[String(JSON.parse(String(init?.body)).runtimeId)]);
    // The fixture's own runtime; a Host does not know any other that was not described to it.
    if (path === "/v1/runtimes/discover" && JSON.parse(String(init?.body)).runtimeId !== "personal") return json({ error: "runtime_not_found" }, 404);
    if (path === "/v1/runtimes/discover") return json({ id: "personal", kernel: "codex", model: "large",
      allowedSettings: { model: { values: ["large", "small"] }, effort: { values: ["low", "high"] } },
      native: { models: { data: [{ model: "large", displayName: "Large", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
        { model: "small", displayName: "Small", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] } } });
    const match = /^\/v1\/runs\/(run-\d+)(?:\/(events|calls|cancel)|\/calls\/([^/]+)\/result)?$/.exec(path), run = match && runs.get(match[1]!);
    if (!match || !run) return json({ error: "fixture_unknown_path" }, 404);
    if (match[2] === "events") {
      const after = Number(url.searchParams.get("after") ?? 0);
      return json({ events: run.events.map((event, index) => ({ sequence: index + 1, event })).filter(item => item.sequence > after), cursor: run.events.length, hasMore: false, historyTruncated: false });
    }
    if (match[2] === "calls") return json({ calls: run.calls });
    if (match[2] === "cancel") { if (run.record.status === "running") Object.assign(run.record, { status: "cancelled" }); return json({}); }
    if (match[3]) {
      const call = run.calls.find(item => item.id === decodeURIComponent(match[3]!));
      if (!call || call.status !== "pending") return json({ error: "call_not_pending" }, 409);
      // The call's deadline passed at the Host while its tool ran: the run got a timeout, and the answer is refused.
      if (expired(call as { name: string; input: any })) { call.status = "expired"; run.answers.get(String(call.id))!({ contentItems: [{ text: JSON.stringify({ isError: true, error: "tool_call_timed_out" }) }] }); return json({ error: "call_not_pending" }, 409); }
      call.status = "completed"; run.answers.get(String(call.id))!(JSON.parse(String(init?.body)).result); return json({});
    }
    return json(run.record);
  };
  return { host, turns, runs,
    /** What the Host's discovery of another runtime than the fixture's own returns. */
    discovery(runtimeId: string, value: unknown) { discoveries[runtimeId] = value; },
    /** What every following run does. Throwing fails the run. */
    respond(next: Script) { script = next; },
    /** How long a tool call of a following run may wait for its answer. */
    callDeadline(ms: number) { deadlineMs = ms; },
    /** Calls whose answer arrives after their deadline at the Host. */
    expire(which: (call: { name: string; input: any }) => boolean) { expired = which; } };
}

/** Mau with the partner tools on and the fixture's partner ("helper") in a ready environment of its own. */
export async function partnersFixture(cleanup: Array<() => unknown>, options: { runtime?: Record<string, unknown>; mau?: Record<string, unknown>;
  /** Other runtimes of the Host and what the environment profile says about them (`mauFixture`). */
  runtimes?: Record<string, Record<string, unknown>>; profile?: Record<string, unknown>; hostConfigRuntimes?: unknown[];
  /** The built console, served by the fixture's Mau for browser tests. */
  webRoot?: string } = {}) {
  const scripted = scriptedHost();
  const f = await mauFixture(cleanup, { host: scripted.host, hostCapabilities: { runIdempotency: true }, ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.runtimes ? { runtimes: options.runtimes } : {}), ...(options.profile ? { profile: options.profile } : {}),
    ...(options.hostConfigRuntimes ? { hostConfigRuntimes: options.hostConfigRuntimes } : {}),
    ...(options.webRoot ? { webRoot: options.webRoot } : {}) },
    { nativeWork: { partnerTools: true }, ...options.mau });
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");
  const web = () => ledgerApi("alice", f.base + "/_agent-router/v1/web");
  const chat = (agentId: string) => `dm:${agentId}`;
  /** Wait for something while partner deliveries are driven; the delivery timer of a started Mau is not running here. */
  const until = async <T>(read: () => T | undefined | false | null | Promise<T | undefined | false | null>, label: string, attempts = 800): Promise<T> => {
    for (let n = 0; n < attempts; n++) {
      await f.mau.partners.tick();
      const value = await read();
      if (value) return value;
      await new Promise(r => setTimeout(r, 15));
    }
    throw new Error("timeout_" + label);
  };
  const events = async (agentId: string) => (await web().events(chat(agentId), { limit: 200 })).events;
  return { ...f, get mau() { return f.mau; }, get service() { return f.service; }, get base() { return f.base; }, ...scripted, until, events, web, chat,
    /** The owner writes to a partner in the web chat. */
    say: async (agentId: string, text: string) => { await web().openDm(agentId); return web().send(chat(agentId), { idempotencyKey: newIdempotencyKey(), text }); },
    name: (agentId: string) => f.service.agent(agentId).name,
    partner: (name: string) => f.service.agents("@alice:example.test").find(agent => agent.name === name)!,
    /** The turn number `index` (from 0) of a partner, once the Host has it. */
    turnOf: (agentId: string, index = 0) => until(() => scripted.turns.filter(turn => turn.agentId === agentId)[index], `turn ${index} of ${agentId}`),
    /** A partner's final answers in its conversation with the owner, oldest first. */
    answers: async (agentId: string) => (await events(agentId)).filter((event): event is Extract<ChatEvent, { kind: "message" }> => event.kind === "message" && event.role === "assistant").map(event => event.text),
    /** Mau's own records, read through a second handle on its store. */
    store: <T>(read: (store: DurableStore) => T): T => {
      const store = new DurableStore(join(f.directory, "business-tools.sqlite"), "example.test");
      try { return read(store); } finally { store.close(); }
    },
    messages: () => f.mau.partners.messages("@alice:example.test"),
    /** The lines that enclose an answer in the turn that handed a message's result over. */
    answer: (messageId: string, text: string) => {
      const store = new DurableStore(join(f.directory, "business-tools.sqlite"), "example.test");
      try {
        const batch = store.entries<{ messageIds: string[]; boundary: string }>("partner_returns").map(entry => entry.value).reverse().find(value => value.messageIds.includes(messageId))!;
        return `----- answer ${batch.boundary} -----\n${text}\n----- end of answer ${batch.boundary} -----`;
      } finally { store.close(); }
    },
    boundary: (messageId: string) => {
      const store = new DurableStore(join(f.directory, "business-tools.sqlite"), "example.test");
      try { return store.entries<{ messageIds: string[]; boundary: string }>("partner_returns").map(entry => entry.value).reverse().find(value => value.messageIds.includes(messageId))!.boundary; }
      finally { store.close(); }
    },
    /** The admission Router gave the owner's turn the Host is running, for calling the partners tool as that turn. */
    admission: async (turn: Turn) => {
      const sessions = (await f.service.runtime(turn.agentId)).extension!.sessions!;
      const run = sessions.list().flatMap(session => session.runs).find(item => item.runId === turn.runId)!;
      return { kind: "owner" as const, owner: "@alice:example.test", agentId: turn.agentId, reference: run.taskId };
    },
    /** Let partner deliveries run for a while, for asserting that something did not happen. */
    settle: async (ms = 1500) => { for (const end = Date.now() + ms; Date.now() < end;) { await f.mau.partners.tick(); await new Promise(r => setTimeout(r, 25)); } },
    /** Following runs stay open until the test ends them. */
    hold: () => {
      const open = new Map<string, (answer: string) => void>();
      scripted.respond(turn => new Promise<string>(resolve => { open.set(turn.runId, resolve); }));
      return (turn: Turn, answer = "done") => open.get(turn.runId)!(answer);
    },
    /**
     * A connected-app write of the partner that handles `message` waits for the owner: the approval's record, and its
     * card where the message was sent from, opened through the partner's own desk as the connector approval does.
     * The connector service that would make the request is not part of this fixture.
     */
    approval: async (message: PartnerMessage, card: { id: string; summary: string; connection: string; arguments: unknown; deadlineAt?: string }) => {
      const turn = { kind: "delegation" as const, owner: "@alice:example.test", agentId: message.to.agentId, reference: message.id, toolGrants: { connectedApps: { connections: [] } } };
      const desk = f.mau.partners.authority(turn)!.approvals!, id = `partner-approval-${card.id}`;
      const write = (status: string) => { const store = new DurableStore(join(f.directory, "business-tools.sqlite"), "example.test");
        try { store.set("connector_approvals", `fixture:${id}`, { status, agentId: message.to.agentId, desk: id, summary: card.summary }); } finally { store.close(); } };
      write("pending");
      await desk.open({ id, summary: card.summary, connection: card.connection, arguments: card.arguments, deadlineAt: card.deadlineAt ?? new Date(Date.now() + 120_000).toISOString() });
      return { id, status: () => desk.status(id), withdraw: () => desk.withdraw(id),
        /** The approval is decided, as it is once the answer on the card has been read. */
        settle: () => write("settled") };
    },
    record: (id: string) => { const store = new DurableStore(join(f.directory, "business-tools.sqlite"), "example.test"); try { return store.get<PartnerMessage>("partner_messages", id)!; } finally { store.close(); } },
  };
}
export type PartnersFixture = Awaited<ReturnType<typeof partnersFixture>>;
