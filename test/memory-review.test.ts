import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStore } from "../src/store.js";
import { MEMORY_REVIEW_DEFAULTS, MemoryReviewCoordinator, type MemoryReviewCompletion,
  type MemoryReviewConfig, type MemoryReviewSourceSessions, type MemoryReviewSubmission,
  type RestrictedMemoryReviewer, type ReviewCapabilities, type ReviewWork } from "../src/memory-review.js";

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
const scope = { owner: "alice", agentId: "employee" };
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function proof(): ReviewCapabilities {
  return { ...scope, status: "available", runtimeId: "review-runtime", policyId: "server-enforced-v1",
    isolation: "dedicated-runtime", enforcement: "runtime-tool-allowlist", otherTools: "denied",
    contextAccess: "copied-session-and-managed-memory-skills", sideEffects: "managed-memory-skills-only",
    unattendedDestructiveWrites: "stage-for-owner-approval", delivery: "disabled", recursion: "disabled", memory: true, skills: true };
}
function fixture(options: { config?: MemoryReviewConfig; reviewer?: boolean; path?: string } = {}) {
  const store = new DurableStore(options.path ?? ":memory:", "review-test"); closers.push(() => store.close());
  const works = new Map<string, ReviewWork>(), submitted: MemoryReviewSubmission[] = [];
  const metadata = { sessionId: "router-main", runtimeId: "main-runtime", ownerConversation: true,
    runs: [] as Array<{ taskId: string; runId: string; phase: string; error: null }> };
  const items = [{ id: "native-turn-1", status: "completed", items: [{ type: "userMessage", text: "Use concise replies", details: { provenance: "owner" } }] }];
  const history = vi.fn(async () => ({ source: "native", items }));
  const source = { ...scope, getSession: vi.fn(() => structuredClone(metadata)), history } as unknown as MemoryReviewSourceSessions;
  const sources = vi.fn(async () => source);
  const reviewer: RestrictedMemoryReviewer = {
    capabilities: vi.fn(async () => proof()),
    submit: vi.fn(async input => {
      submitted.push(input);
      const work = { eventId: input.eventId, sessionId: input.sessionId, status: "completed" };
      works.set(input.eventId, work); return work;
    }),
    lookup: vi.fn(async (_scope, id) => works.get(id) ?? null),
    cancel: vi.fn(async (_scope, id) => { const work = works.get(id); if (work) works.set(id, { ...work, status: "cancelled" }); }),
  };
  const deps = { sourceSessions: sources, ...(options.reviewer === false ? {} : { reviewer }), config: options.config ?? { memoryInterval: 1 } };
  const service = new MemoryReviewCoordinator(store, deps); closers.push(() => service.close());
  const complete = (runId = "run-1", overrides: Partial<MemoryReviewCompletion> = {}) => {
    if (!metadata.runs.some(run => run.runId === runId)) metadata.runs.push({ taskId: `task-${runId}`, runId, phase: "finished", error: null });
    return service.completed({ ...scope, sessionId: "host-main", runId, origin: "owner", status: "completed", ...overrides });
  };
  return { store, deps, service, reviewer, sources, source, metadata, items, history, works, submitted, complete };
}

it("uses 10 completed owner turns and 15 trusted tool iterations, without treating calls or missing counts as iterations", async () => {
  expect(MEMORY_REVIEW_DEFAULTS).toEqual({ enabled: true, memoryInterval: 10, skillInterval: 15 });
  const f = fixture({ config: {}, reviewer: false });
  for (let n = 1; n < 10; n++) f.complete(`run-${n}`, { skillsAvailable: true });
  expect(f.service.list(scope)).toEqual([]);
  f.complete("run-10", { skillsAvailable: true });
  expect(f.service.nudges({ ...scope, sessionId: "host-main" })).toMatchObject({ memory: true, skills: false });
  expect(f.service.list(scope)).toMatchObject([{ status: "unsupported", reviewMemory: true, reviewSkills: false }]);
  f.complete("run-11", { toolIterations: 14, skillsAvailable: true });
  expect(f.service.nudges({ ...scope, sessionId: "host-main" })).toMatchObject({ memory: false, skills: false });
  f.complete("run-12", { toolIterations: 1, skillsAvailable: true });
  expect(f.service.nudges({ ...scope, sessionId: "host-main" })).toMatchObject({ memory: false, skills: true });
  expect(f.service.list(scope)).toHaveLength(2);
  expect(f.sources).not.toHaveBeenCalled();
});

it("never counts scheduled, delegated, recursive or failed work and honors disabled or absent capabilities", async () => {
  const f = fixture({ reviewer: false });
  for (const origin of ["schedule", "delegation", "review"] as const) expect(f.complete(origin, { origin })).toEqual({ status: "ignored" });
  expect(f.complete("failed", { status: "failed" })).toEqual({ status: "ignored" });
  expect(f.complete("cancelled", { status: "cancelled" })).toEqual({ status: "ignored" });
  f.complete("no-memory", { memoryAvailable: false, skillsAvailable: false, toolIterations: 100 });
  expect(f.service.list(scope)).toEqual([]);
  const off = fixture({ config: { enabled: false } }); off.complete(); await off.service.tick();
  expect(off.service.list(scope)).toEqual([]); expect(off.sources).not.toHaveBeenCalled();
  const zero = fixture({ config: { memoryInterval: 0, skillInterval: 0 } });
  zero.complete("zero", { skillsAvailable: true, toolIterations: 100 }); await zero.service.tick();
  expect(zero.service.list(scope)).toEqual([]);
});

it("persists unsupported without reading a source session and never accepts prompt-only or wrong-owner isolation", async () => {
  const noRuntime = fixture({ reviewer: false });
  expect(noRuntime.complete()).toMatchObject({ status: "unsupported" }); await noRuntime.service.tick();
  expect(noRuntime.sources).not.toHaveBeenCalled();
  expect(noRuntime.service.status(scope)).toMatchObject({ enabled: true, runtimeConfigured: false, status: "unsupported", reason: "restricted_review_runtime_required" });
  for (const invalid of [{ ...proof(), enforcement: "prompt" }, { ...proof(), owner: "bob" }, { ...proof(), otherTools: "allowed" }, { ...proof(), memory: false }]) {
    const f = fixture(); vi.mocked(f.reviewer.capabilities).mockResolvedValue(invalid as ReviewCapabilities);
    f.complete(); await f.service.tick();
    expect(f.service.list(scope)[0]).toMatchObject({ status: "unsupported", reason: "restricted_review_policy_unverified" });
    expect(f.sources).not.toHaveBeenCalled(); expect(f.reviewer.submit).not.toHaveBeenCalled();
  }
});

it("deep-copies native history through public WorkSessions, into a separate session with review origin and no delivery surface", async () => {
  const f = fixture(); f.complete();
  expect(f.sources).not.toHaveBeenCalled(); // Recording a completed foreground turn is synchronous, with no I/O.
  await f.service.tick();
  expect(f.history).toHaveBeenCalledWith("host-main", { limit: 100, itemsView: "full", sortDirection: "asc" });
  expect(f.submitted).toHaveLength(1);
  const request = f.submitted[0]!;
  expect(request).toMatchObject({ ...scope, sourceSessionId: "host-main", sourceRunId: "run-1", origin: "review", reviewMemory: true,
    policyId: "server-enforced-v1", runtimeId: "review-runtime", snapshot: { source: "native_history", items: f.items } });
  expect(request.sessionId).not.toBe("host-main"); expect(request.sessionId).not.toBe("router-main");
  f.items[0]!.items[0]!.details.provenance = "changed-after-copy";
  expect((request.snapshot.items[0] as any).items[0].details.provenance).toBe("owner");
  expect(f.service.list(scope)[0]?.status).toBe("completed");
  expect(f.service.list({ owner: "bob", agentId: scope.agentId })).toEqual([]);
  expect(f.service.nudges({ owner: "bob", agentId: scope.agentId, sessionId: "host-main" }).prompt).toBe("");
  expect(f.reviewer).not.toHaveProperty("deliver");
});

it("deduplicates repeated completion observations and survives restart without repeating an accepted but lost submission", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mau-memory-review-")); closers.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite"), f = fixture({ path });
  vi.mocked(f.reviewer.submit).mockImplementation(async input => {
    f.submitted.push(input); f.works.set(input.eventId, { eventId: input.eventId, sessionId: input.sessionId, status: "completed" });
    throw new Error("response_lost");
  });
  const first = f.complete(); expect(f.complete()).toEqual(first); await f.service.tick();
  expect(f.service.list(scope)[0]?.status).toBe("uncertain"); expect(f.submitted).toHaveLength(1);
  await f.service.close();
  const reopenedStore = new DurableStore(path, "review-test"); closers.push(() => reopenedStore.close());
  const reopened = new MemoryReviewCoordinator(reopenedStore, f.deps); closers.push(() => reopened.close());
  await reopened.tick();
  expect(reopened.list(scope)[0]?.status).toBe("completed"); expect(f.submitted).toHaveLength(1);
  expect(reopened.completed({ ...scope, sessionId: "host-main", runId: "run-1", origin: "owner", status: "completed" })).toEqual(first);
  expect(() => reopened.completed({ ...scope, sessionId: "host-main", runId: "run-1", origin: "owner", status: "completed", toolIterations: 2 })).toThrow("completion_conflict");
});

it("holds uncertain submissions when lookup finds nothing, and prevents overlap across one employee's sessions", async () => {
  const f = fixture(); vi.mocked(f.reviewer.submit).mockRejectedValue(new Error("connection_lost"));
  f.complete(); await f.service.tick();
  f.complete("run-2", { sessionId: "other-host-session" });
  await f.service.tick(); await f.service.tick();
  expect(f.reviewer.submit).toHaveBeenCalledTimes(1);
  expect(f.service.list(scope).map(job => job.status)).toEqual(["uncertain", "queued"]);
});

it("defers an active or changing owner session without pausing it, and requires a verified owner run", async () => {
  const f = fixture(); f.complete(); f.metadata.runs[0]!.phase = "running";
  await f.service.tick(); expect(f.history).not.toHaveBeenCalled(); expect(f.service.list(scope)[0]?.status).toBe("queued");
  f.metadata.runs[0]!.phase = "finished";
  f.history.mockImplementationOnce(async () => { f.metadata.runs.push({ taskId: "next", runId: "next", phase: "running", error: null }); return { source: "native", items: f.items }; });
  await f.service.tick(); expect(f.reviewer.submit).not.toHaveBeenCalled(); expect(f.service.list(scope)[0]?.status).toBe("queued");
  f.metadata.runs[1]!.phase = "finished"; await f.service.tick(); expect(f.reviewer.submit).toHaveBeenCalledTimes(1);
  const foreign = fixture(); foreign.complete(); foreign.metadata.ownerConversation = false;
  await foreign.service.tick(); expect(foreign.service.list(scope)[0]).toMatchObject({ status: "failed", reason: "memory_review_owner_turn_unverified" });
  expect(foreign.history).not.toHaveBeenCalled();
});

it("fails closed if a reviewer shares the main runtime or source scope is different", async () => {
  const f = fixture(); vi.mocked(f.reviewer.capabilities).mockResolvedValue({ ...proof(), runtimeId: "main-runtime" });
  f.complete(); await f.service.tick(); expect(f.service.list(scope)[0]).toMatchObject({ status: "unsupported", reason: "review_runtime_must_be_separate" });
  expect(f.history).not.toHaveBeenCalled();
  const foreign = fixture(); foreign.sources.mockResolvedValue({ ...foreign.source, owner: "bob" });
  foreign.complete(); await foreign.service.tick(); expect(foreign.service.list(scope)[0]?.reason).toBe("memory_review_scope_mismatch");
  expect(foreign.history).not.toHaveBeenCalled();
});

it("copies bounded history pages and refuses cursor cycles, malformed history and oversized copies", async () => {
  const f = fixture(); f.history.mockResolvedValueOnce({ source: "native", items: [{ id: "one" }], cursor: "next" } as any)
    .mockResolvedValueOnce({ source: "native", items: [{ id: "two" }] } as any);
  f.complete(); await f.service.tick(); expect(f.submitted[0]!.snapshot.items).toEqual([{ id: "one" }, { id: "two" }]);
  expect(f.history).toHaveBeenLastCalledWith("host-main", { limit: 100, itemsView: "full", sortDirection: "asc", cursor: "next" });
  for (const [page, reason] of [
    [{ source: "native", items: [], cursor: "loop" }, "memory_review_history_cursor_invalid"],
    [{ items: [] }, "memory_review_native_history_required"],
    [{ source: "native", items: ["x".repeat(2000)] }, "memory_review_context_too_large"],
  ] as const) {
    const invalid = fixture({ config: { memoryInterval: 1, maxContextBytes: 1024 } });
    invalid.history.mockResolvedValue(page as any); invalid.complete(); await invalid.service.tick();
    expect(invalid.service.list(scope)[0]).toMatchObject({ status: "failed", reason }); expect(invalid.submitted).toHaveLength(0);
  }
});

it("stops before an in-flight preparation can submit, and only resuming allows future review work", async () => {
  const f = fixture(), entered = gate<void>(), release = gate<ReviewCapabilities>();
  vi.mocked(f.reviewer.capabilities).mockImplementation(async () => { entered.resolve(); return release.promise; });
  f.complete(); const running = f.service.tick(); await entered.promise;
  f.service.stop(scope); release.resolve(proof()); await running;
  expect(f.reviewer.submit).not.toHaveBeenCalled(); expect(f.service.list(scope)[0]?.status).toBe("cancelled");
  f.complete("stopped-turn"); expect(f.service.list(scope)).toHaveLength(1);
  f.service.resume(scope); vi.mocked(f.reviewer.capabilities).mockResolvedValue(proof());
  f.complete("resumed-turn"); await f.service.tick(); expect(f.reviewer.submit).toHaveBeenCalledTimes(1);
});

it("persists cancellation of known review work and waits for the Router receipt", async () => {
  const f = fixture(); vi.mocked(f.reviewer.submit).mockImplementation(async input => {
    const work = { eventId: input.eventId, sessionId: input.sessionId, status: "working" }; f.works.set(input.eventId, work); return work;
  });
  const result = f.complete(); await f.service.tick(); expect(f.service.list(scope)[0]?.status).toBe("running");
  f.service.stop(scope); await f.service.tick();
  expect(f.reviewer.cancel).toHaveBeenCalledWith(expect.objectContaining(scope), result.id, expect.any(AbortSignal));
  expect(f.service.list(scope)[0]).toMatchObject({ status: "uncertain", cancellationRequested: true });
  await f.service.tick(); expect(f.service.list(scope)[0]?.status).toBe("cancelled");
});

it("prevents reentrant and concurrent coordinators from dispatching one job twice, and close aborts pending preparation", async () => {
  const f = fixture(), entered = gate<void>(), release = gate<ReviewCapabilities>();
  vi.mocked(f.reviewer.capabilities).mockImplementation(async () => { entered.resolve(); return release.promise; });
  f.complete(); const first = f.service.tick(); expect(f.service.tick()).toBe(first); await entered.promise;
  const second = new MemoryReviewCoordinator(f.store, f.deps); closers.push(() => second.close());
  await second.tick(); expect(f.reviewer.capabilities).toHaveBeenCalledTimes(1);
  await f.service.close(); await first; expect(f.service.list(scope)[0]?.status).toBe("queued");
  release.resolve(proof()); vi.mocked(f.reviewer.capabilities).mockResolvedValue(proof());
  await second.tick(); expect(f.reviewer.submit).toHaveBeenCalledTimes(1);
});

it("refuses a foreign execution receipt without completing or replaying its review", async () => {
  const f = fixture(); vi.mocked(f.reviewer.submit).mockResolvedValue({ eventId: "foreign", sessionId: "another-session", status: "completed" });
  f.complete(); await f.service.tick();
  expect(f.service.list(scope)[0]).toMatchObject({ status: "uncertain", reason: "memory_review_receipt_scope_mismatch" });
  await f.service.tick(); expect(f.reviewer.submit).toHaveBeenCalledTimes(1);
});
