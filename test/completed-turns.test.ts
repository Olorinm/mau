import { expect, it, vi } from "vitest";
import type { WorkSessions } from "@agent-router/server";
import { DurableStore } from "../src/store.js";
import { SessionHistory } from "../src/session-history.js";
import { MemoryReviewCoordinator } from "../src/memory-review.js";
import { CompletedTurns } from "../src/completed-turns.js";

it("durably maps observed Host turns to public session IDs and preserves original delegated input", async () => {
  const store = new DurableStore(":memory:", "queue");
  const history = new SessionHistory(store, () => {});
  const source = vi.fn().mockRejectedValueOnce(new Error("temporarily_unavailable")).mockResolvedValue({
    list: () => [{ sessionId: "public-conversation", runs: [{ runId: "run" }] }],
  } as unknown as WorkSessions);
  const reviews = new MemoryReviewCoordinator(store, { sourceSessions: source, config: { memoryInterval: 1 } });
  let queue = new CompletedTurns(store, history, reviews, source, true);
  const turn = { admission: { kind: "owner" as const, owner: "alice", agentId: "agent", reference: "input" },
    sessionId: "h-internal", sessionKey: "scope:h-internal", runId: "run", input: "王总邮件内容", answer: "原文答复" };
  try {
    queue.enqueue(turn); await queue.tick();
    expect(history.search("alice", "agent", { query: "王总" }).data).toHaveLength(0);
    await queue.close(); queue = new CompletedTurns(store, history, reviews, source, true);
    await queue.tick(); queue.enqueue(turn); await queue.tick();
    expect(history.search("alice", "agent", { query: "王总", sessionId: "public-conversation" }).data).toHaveLength(1);
    expect(queue.publicSession("alice", "agent", "h-internal")).toBe("public-conversation");
    expect(reviews.list({ owner: "alice", agentId: "agent" })).toHaveLength(1);
    expect(reviews.nudges({ owner: "alice", agentId: "agent", sessionId: "public-conversation" }).memory).toBe(true);
    queue.enqueue({ ...turn, admission: { ...turn.admission, kind: "schedule" } }); await queue.tick();
    expect(reviews.list({ owner: "alice", agentId: "agent" })).toHaveLength(1);
  } finally { await queue.close(); await reviews.close(); store.close(); }
});
