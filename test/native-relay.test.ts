import { afterEach, expect, it, vi } from "vitest";
import type { WorkSessions } from "@agent-router/server";
import { DurableStore } from "../src/store.js";
import { NativeRelay, type NativeRelayPartner, type NativeRelayHost } from "../src/native-relay.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const partner: NativeRelayPartner = { agentId: "agent", owner: "alice", operationId: "op", runtimeId: "personal" };
const turn = (threadId: string, id: string, text: string, status = "completed") => ({ type: "notification", method: "turn/completed",
  params: { threadId, turn: { id, status, items: [{ type: "agentMessage", text: "working", phase: "commentary" }, { type: "agentMessage", text, phase: "final_answer" }] } } });
const status = (threadId: string, type: string) => ({ type: "notification", method: "thread/status/changed", params: { threadId, status: { type } } });

function fixture(options: { keepAliveMs?: number } = {}) {
  const store = new DurableStore(":memory:", "relay"); cleanup.push(() => store.close());
  let now = 1_000_000, epoch = "e1";
  const log: Array<{ sequence: number; event: Record<string, unknown> }> = [];
  const runEvents = new Map<string, Array<Record<string, unknown>>>();
  const runs: Array<{ taskId: string; runId: string | null; phase: string; error: null }> = [];
  const state = { ready: true };
  const push = (...events: Array<Record<string, unknown>>) => { for (const event of events) log.push({ sequence: log.length + 1, event }); };
  const host: NativeRelayHost = {
    nativeEvents: vi.fn(async (_runtime: string, after = 0, limit = 200, requested?: string) => {
      if (!state.ready) throw new Error("environment_not_ready");
      if (requested && requested !== epoch) throw new Error("native_event_epoch_changed");
      const events = log.filter(e => e.sequence > after).slice(0, limit);
      const cursor = events.at(-1)?.sequence ?? after;
      return { epoch, events, cursor, hasMore: cursor < log.length, historyTruncated: false };
    }),
    nativeSessions: vi.fn(async () => ({ bindings: [{ sessionId: "h-main", nativeSessionId: "thread-main" }, { sessionId: "h-group", nativeSessionId: "thread-group" }] })),
    events: vi.fn(async (runId: string) => ({ events: (runEvents.get(runId) ?? []).map(event => ({ event })), cursor: 1, hasMore: false })),
  };
  const deliver = vi.fn((input: { eventId: string; targetSessionId: string; text: string }) => ({ ...input, state: "queued" }));
  const work = {
    validateTarget: (sessionId: string) => { if (sessionId !== "c-main") throw new Error("notification_requires_owner_conversation"); return { sessionId, ownerConversation: true }; },
    getSession: () => ({ sessionId: "c-main", runs }), deliver,
  } as unknown as WorkSessions;
  const touch = vi.fn(), record = vi.fn();
  const relay = new NativeRelay(store, {
    partners: () => [partner], host: () => host, sessions: async () => work, touch, record,
    publicSession: (_owner, _agent, hostSessionId) => ({ "h-main": "c-main", "h-group": "c-group" } as Record<string, string>)[hostSessionId],
  }, { clock: () => now, ...options });
  cleanup.push(() => relay.close());
  const managed = (runId: string, turnId: string) => {
    runs.push({ taskId: "task-" + runId, runId, phase: "finished", error: null });
    runEvents.set(runId, [{ type: "native.notification", notification: { method: "turn/started", params: { threadId: "thread-main", turn: { id: turnId } } } }]);
  };
  return { store, relay, host, push, deliver, touch, record, managed, state, advance: (ms: number) => { now += ms; },
    restart: () => { epoch = "e2"; log.splice(0); } };
}

it("delivers only turns Router did not start on the owner's private conversation", async () => {
  const f = fixture();
  f.push(turn("thread-main", "old-woken", "Result produced before the relay started"));
  await f.relay.tick();
  expect(f.deliver).not.toHaveBeenCalled();

  f.managed("run-1", "managed-turn");
  f.push(turn("thread-main", "managed-turn", "Router already replied"),
    turn("thread-child", "child-turn", "Subagent final answer"),
    turn("thread-group", "group-turn", "Group conversation is not an owner chat"),
    turn("thread-main", "woken-empty", "  "),
    turn("thread-main", "woken-interrupted", "Partial", "interrupted"),
    turn("thread-main", "woken-turn", "攻略已完成：三天行程见上。"));
  await f.relay.tick();
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(f.deliver).toHaveBeenCalledWith({ eventId: "wake-woken-turn", targetSessionId: "c-main", text: "攻略已完成：三天行程见上。" });
  expect(f.record).toHaveBeenCalledWith("alice", "agent", "c-main", "woken-turn:assistant", "攻略已完成：三天行程见上。");
  expect(f.store.get<any>("native_relay_turns", "managed-turn").status).toBe("managed");
  expect(f.store.get<any>("native_relay_turns", "woken-empty").status).toBe("empty");
  expect(f.store.get<any>("native_relay_turns", "woken-interrupted").status).toBe("empty");
  expect(f.store.get("native_relay_turns", "child-turn")).toBeUndefined();

  // Seeing the same native event again never delivers twice.
  f.store.set("native_relay_cursors", "agent", { epoch: "e1", cursor: 1 });
  await f.relay.tick();
  expect(f.deliver).toHaveBeenCalledTimes(1);
});

it("a restarted Host log is not replayed and failed deliveries are retried", async () => {
  const f = fixture();
  await f.relay.tick();
  f.restart();
  f.push(turn("thread-main", "before-reset", "From the new process before the relay caught up"));
  await f.relay.tick();
  await f.relay.tick();
  expect(f.deliver).not.toHaveBeenCalled();

  f.deliver.mockImplementationOnce(() => { throw new Error("transient"); });
  f.push(turn("thread-main", "retry-turn", "Done"));
  await f.relay.tick();
  expect(f.store.get<any>("native_relay_turns", "retry-turn")).toMatchObject({ status: "queued", attempts: 1 });
  await f.relay.tick();
  expect(f.store.get<any>("native_relay_turns", "retry-turn").status).toBe("delivered");
  expect(f.deliver).toHaveBeenLastCalledWith({ eventId: "wake-retry-turn", targetSessionId: "c-main", text: "Done" });
});

it("running native threads keep the environment awake up to a bounded window; unready environments are skipped", async () => {
  const f = fixture({ keepAliveMs: 60_000 });
  await f.relay.tick();
  f.push(status("thread-child", "active"));
  await f.relay.tick();
  expect(f.touch).toHaveBeenCalledTimes(1);
  f.advance(30_000); await f.relay.tick();
  expect(f.touch).toHaveBeenCalledTimes(2);
  f.advance(31_000); await f.relay.tick();
  expect(f.touch).toHaveBeenCalledTimes(2);
  f.push(status("thread-child", "idle"));
  await f.relay.tick();
  f.push(status("thread-child", "active"));
  await f.relay.tick();
  expect(f.touch).toHaveBeenCalledTimes(3);

  f.state.ready = false;
  const calls = f.touch.mock.calls.length;
  await expect(f.relay.tick()).resolves.toBeUndefined();
  // Activity known before the environment stopped answering is not extended by guesswork.
  expect(f.touch.mock.calls.length).toBe(calls);
});

it("partners sharing one Host runtime each receive only the woken turns of their own conversations, once", async () => {
  // Both partners read the same native event stream and the same session bindings of the runtime.
  const store = new DurableStore(":memory:", "relay"); cleanup.push(() => store.close());
  const helper: NativeRelayPartner = { agentId: "helper", owner: "alice", operationId: "op", runtimeId: "personal" };
  const scout: NativeRelayPartner = { ...helper, agentId: "scout" };
  const log: Array<{ sequence: number; event: Record<string, unknown> }> = [];
  const push = (...events: Array<Record<string, unknown>>) => { for (const event of events) log.push({ sequence: log.length + 1, event }); };
  const runEvents = new Map<string, Array<Record<string, unknown>>>();
  const host: NativeRelayHost = {
    nativeEvents: vi.fn(async (_runtime: string, after = 0, limit = 200) => {
      const events = log.filter(e => e.sequence > after).slice(0, limit), cursor = events.at(-1)?.sequence ?? after;
      return { epoch: "e1", events, cursor, hasMore: cursor < log.length, historyTruncated: false };
    }),
    nativeSessions: vi.fn(async () => ({ bindings: [{ sessionId: "h-helper", nativeSessionId: "thread-helper" },
      { sessionId: "h-scout", nativeSessionId: "thread-scout" }, { sessionId: "h-scout-group", nativeSessionId: "thread-scout-group" }] })),
    events: vi.fn(async (runId: string) => ({ events: (runEvents.get(runId) ?? []).map(event => ({ event })), cursor: 1, hasMore: false })),
  };
  // Each partner's Router knows only its own sessions; a Host session maps to a conversation for the partner that ran it.
  const aliases: Record<string, Record<string, string>> = { helper: { "h-helper": "c-helper" }, scout: { "h-scout": "c-scout", "h-scout-group": "c-scout-group" } };
  const conversations: Record<string, string> = { helper: "c-helper", scout: "c-scout" };
  const runs: Record<string, Array<{ taskId: string; runId: string | null; phase: string; error: null }>> = { helper: [], scout: [] };
  const deliver = { helper: vi.fn((input: { eventId: string }) => ({ ...input, state: "queued" })), scout: vi.fn((input: { eventId: string }) => ({ ...input, state: "queued" })) };
  const work = (agentId: "helper" | "scout") => ({
    validateTarget: (sessionId: string) => { if (sessionId !== conversations[agentId]) throw new Error("notification_requires_owner_conversation"); return { sessionId, ownerConversation: true }; },
    getSession: (sessionId: string) => ({ sessionId, runs: runs[agentId]! }), deliver: deliver[agentId],
  }) as unknown as WorkSessions;
  const touch = vi.fn(), record = vi.fn();
  const relay = new NativeRelay(store, {
    partners: () => [helper, scout], host: () => host, sessions: async (_owner, agentId) => work(agentId as "helper" | "scout"), touch, record,
    publicSession: (_owner, agentId, hostSessionId) => aliases[agentId]?.[hostSessionId],
  }, { clock: () => 1_000_000 });
  cleanup.push(() => relay.close());
  await relay.tick();

  runs.scout.push({ taskId: "task-run-9", runId: "run-9", phase: "finished", error: null });
  runEvents.set("run-9", [{ type: "native.notification", notification: { method: "turn/started", params: { threadId: "thread-scout", turn: { id: "scout-managed" } } } }]);
  push(turn("thread-scout", "scout-woken", "Invoices are filed."),
    turn("thread-helper", "helper-woken", "The week is planned."),
    turn("thread-scout", "scout-managed", "Router already replied"),
    turn("thread-scout-group", "scout-group", "A group conversation is not an owner chat"),
    turn("thread-child", "child-turn", "Subagent final answer"),
    status("thread-scout", "active"));
  await relay.tick();
  expect(deliver.scout.mock.calls).toEqual([[{ eventId: "wake-scout-woken", targetSessionId: "c-scout", text: "Invoices are filed." }]]);
  expect(deliver.helper.mock.calls).toEqual([[{ eventId: "wake-helper-woken", targetSessionId: "c-helper", text: "The week is planned." }]]);
  expect(record.mock.calls).toEqual(expect.arrayContaining([["alice", "scout", "c-scout", "scout-woken:assistant", "Invoices are filed."],
    ["alice", "helper", "c-helper", "helper-woken:assistant", "The week is planned."]]));
  expect(record).toHaveBeenCalledTimes(2);
  // One record per turn, under the partner the conversation belongs to.
  expect(store.entries<any>("native_relay_turns").map(({ id, value }) => [id, value.agentId, value.status]).sort()).toEqual([
    ["helper-woken", "helper", "delivered"], ["scout-managed", "scout", "managed"], ["scout-woken", "scout", "delivered"]]);
  // Each partner keeps its own position in the shared stream; reading it again, by either, delivers nothing twice.
  expect(store.get("native_relay_cursors", "helper")).toEqual({ epoch: "e1", cursor: 6 });
  expect(store.get("native_relay_cursors", "scout")).toEqual({ epoch: "e1", cursor: 6 });
  store.set("native_relay_cursors", "helper", { epoch: "e1", cursor: 0 });
  store.set("native_relay_cursors", "scout", { epoch: "e1", cursor: 0 });
  await relay.tick(); await relay.tick();
  expect(deliver.scout).toHaveBeenCalledTimes(1);
  expect(deliver.helper).toHaveBeenCalledTimes(1);
  // A native thread still running keeps the environment awake, whichever partner it belongs to.
  expect(touch.mock.calls.map(([agentId]) => agentId)).toEqual(expect.arrayContaining(["helper", "scout"]));
});
