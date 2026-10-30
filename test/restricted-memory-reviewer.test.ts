import { expect, it, vi } from "vitest";
import { CodexRestrictedMemoryReviewer, CODEX_REVIEW_THREAD, codexReviewProfile, reviewProfileDigest,
  type ReviewRuntimeBinding } from "../src/restricted-memory-reviewer.js";
import type { MemoryReviewSubmission } from "../src/memory-review.js";

const scope = { owner: "alice", agentId: "original-employee" };
const signal = () => AbortSignal.timeout(1000);
function fixture() {
  const profile = codexReviewProfile({ id: "memory-review", cwd: "/srv/review/workspace", command: "/opt/codex-0.165.0/codex",
    home: "/srv/review/home", codexHome: "/srv/review/codex" });
  const effective = { config: { model_provider: "review-provider", model_providers: {
    "review-provider": { name: "Dedicated Responses provider", requires_openai_auth: false, wire_api: "responses" },
  }, features: { api_key_model_discovery: false }, mcp_servers: {} } };
  const sessions = { owner: "alice", agentId: "review-worker", runtimeId: "memory-review",
    submit: vi.fn(async input => ({ eventId: input.eventId, sessionId: input.sessionId, status: "submitted", taskId: "task", answer: "", outcomeUnknown: false })),
    lookup: vi.fn(async () => null), cancel: vi.fn(async () => ({ status: "cancelled" })),
    discover: vi.fn(async () => ({ native: { initialize: { userAgent: "fixture/0.165.0 (test)" } } })),
    host: { nativeRequest: vi.fn(async () => structuredClone(effective)) },
  };
  const binding: ReviewRuntimeBinding = { employee: scope, profile, sessions: sessions as unknown as ReviewRuntimeBinding["sessions"],
    installed: { profileDigest: reviewProfileDigest(profile), homeIsolation: "dedicated-private", modelCatalog: "bundled-0.165.0",
      toolBinding: { enforcement: "server-dispatch-allowlist", memory: { scope, tool: "employee_memory", origin: "review", destructiveWrites: "stage-for-owner-approval" },
        skills: { mode: "unavailable" }, allowedTools: ["employee_memory"], otherTools: "denied", delivery: "disabled", recursion: "disabled" } } };
  const resolve = vi.fn(async () => binding), adapter = new CodexRestrictedMemoryReviewer({ resolve });
  return { profile, effective, sessions, binding, resolve, adapter };
}
async function submission(f: ReturnType<typeof fixture>): Promise<MemoryReviewSubmission> {
  const proof = await f.adapter.capabilities(scope, signal()); if (proof.status !== "available") throw new Error(proof.reason);
  return { ...scope, sessionId: `review-${"a".repeat(64)}`, eventId: `memory-review-${"b".repeat(64)}`, sourceSessionId: "owner-session",
    sourceRunId: "owner-run", policyId: proof.policyId, runtimeId: proof.runtimeId, origin: "review", reviewMemory: true, reviewSkills: false,
    prompt: "Review durable facts only.", snapshot: { ...scope, source: "native_history", sessionId: "owner-session", sourceRunId: "owner-run",
      capturedAt: new Date().toISOString(), items: [{ id: "turn", text: "Original content" }] } };
}

it("generates a public Host CLI profile with frozen thread policy and no per-turn model permission", () => {
  const f = fixture(); expect(f.profile).toMatchObject({ command: "/opt/codex-0.165.0/codex", env: { HOME: "/srv/review/home" },
    nativeAccess: { methods: ["config/read"], notifications: [] }, thread: { sandbox: "read-only", approvalPolicy: "never", environments: [] } });
  expect(f.profile).not.toHaveProperty("options"); expect(f.profile).not.toHaveProperty("allowedSettings");
  expect(() => { (CODEX_REVIEW_THREAD.config as any)["features.shell_tool"] = true; }).toThrow();
  expect(() => codexReviewProfile({ id: "bad", cwd: "relative", command: "codex", home: "/tmp/home", codexHome: "/tmp/codex" })).toThrow("profile_invalid");
});

it("verifies installed policy/native version/effective MCP and submits through Router with original-employee provenance", async () => {
  const f = fixture(), input = await submission(f);
  const proof = await f.adapter.capabilities(scope, signal()); expect(proof).toMatchObject({ ...scope, status: "available", memory: true, skills: false });
  await f.adapter.submit(input, signal());
  expect(f.sessions.host.nativeRequest).toHaveBeenCalledWith("memory-review", "config/read", { includeLayers: false, cwd: "/srv/review/workspace" });
  const sent = f.sessions.submit.mock.calls[0]![0];
  expect(sent).toMatchObject({ eventId: input.eventId, sessionId: input.sessionId,
    admission: { kind: "delegation", owner: "alice", agentId: "review-worker", reference: input.eventId, toolGrants: {}, maxToolCalls: 20 },
    context: { origin: "review", employee: scope, reviewMemory: true, reviewSkills: false, copiedTranscript: input.snapshot } });
  expect(sent).not.toHaveProperty("settings"); expect(sent).not.toHaveProperty("instructions");
  input.snapshot.items.push("changed"); expect((sent.context as any).copiedTranscript.items).toHaveLength(1);
  expect(f.sessions).not.toHaveProperty("fork"); expect(f.sessions).not.toHaveProperty("deliver");
});

it("rejects changed model/tool profile, wrong version, unknown effective config and enabled MCP before submit", async () => {
  for (const alter of [
    (f: ReturnType<typeof fixture>) => { f.profile.thread.model = "other-model"; f.binding.installed.profileDigest = reviewProfileDigest(f.profile); },
    (f: ReturnType<typeof fixture>) => { f.profile.thread.config["features.shell_tool"] = true; f.binding.installed.profileDigest = reviewProfileDigest(f.profile); },
    (f: ReturnType<typeof fixture>) => { f.binding.installed.profileDigest = "unverified"; },
    (f: ReturnType<typeof fixture>) => { f.sessions.discover.mockResolvedValue({ native: { initialize: { userAgent: "fixture/0.166.0 (test)" } } }); },
    (f: ReturnType<typeof fixture>) => { f.sessions.host.nativeRequest.mockResolvedValue({} as any); },
    (f: ReturnType<typeof fixture>) => { f.effective.config.mcp_servers = { mail: { enabled: true } }; },
  ]) {
    const f = fixture(); alter(f); expect(await f.adapter.capabilities(scope, signal())).toMatchObject({ status: "unsupported" }); expect(f.sessions.submit).not.toHaveBeenCalled();
  }
});

it("refuses custom or changing catalogs and unaudited OAuth provider paths", async () => {
  for (const alter of [
    (f: ReturnType<typeof fixture>) => { (f.effective.config as any).model_catalog_json = "/other/catalog.json"; },
    (f: ReturnType<typeof fixture>) => { (f.effective.config.model_providers["review-provider"] as any).model_catalog_url = "https://catalog.invalid"; },
    (f: ReturnType<typeof fixture>) => { f.effective.config.features.api_key_model_discovery = true; },
    (f: ReturnType<typeof fixture>) => { f.effective.config.model_providers["review-provider"].requires_openai_auth = true; },
    (f: ReturnType<typeof fixture>) => { (f.binding.installed as any).modelCatalog = "remote"; },
  ]) {
    const f = fixture(); alter(f); expect(await f.adapter.capabilities(scope, signal())).toMatchObject({ status: "unsupported" }); expect(f.sessions.submit).not.toHaveBeenCalled();
  }
});

it("requires explicit original-employee scope even when the execution worker has a different agent ID", async () => {
  for (const alter of [
    (f: ReturnType<typeof fixture>) => { f.binding.installed.toolBinding.memory.scope = { owner: "alice", agentId: "review-worker" }; },
    (f: ReturnType<typeof fixture>) => { f.binding.employee = { ...scope, owner: "bob" }; },
    (f: ReturnType<typeof fixture>) => { f.sessions.owner = "bob"; },
    (f: ReturnType<typeof fixture>) => { f.binding.installed.toolBinding.allowedTools.push("work_sessions"); },
    (f: ReturnType<typeof fixture>) => { (f.binding.installed.toolBinding.memory as any).origin = "delegation"; },
  ]) {
    const f = fixture(); alter(f); expect(await f.adapter.capabilities(scope, signal())).toMatchObject({ status: "unsupported" });
  }
});

it("advertises skill support only with a scoped native-managed dispatcher and refuses unsupported skill jobs", async () => {
  const f = fixture(), input = await submission(f);
  await expect(f.adapter.submit({ ...input, reviewSkills: true }, signal())).rejects.toThrow("scope_invalid");
  f.binding.installed.toolBinding.skills = { mode: "native-managed", scope, tools: ["skill_view", "skill_manage"] };
  f.binding.installed.toolBinding.allowedTools.push("skill_view", "skill_manage");
  expect(await f.adapter.capabilities(scope, signal())).toMatchObject({ status: "available", skills: true });
  f.binding.installed.toolBinding.skills.scope = { ...scope, agentId: "worker" };
  expect(await f.adapter.capabilities(scope, signal())).toMatchObject({ status: "unsupported" });
});

it("revalidates before submit but keeps lookup/cancel available after policy revocation", async () => {
  const f = fixture(), input = await submission(f);
  f.binding.installed.profileDigest = "revoked";
  await expect(f.adapter.submit(input, signal())).rejects.toThrow("unverified");
  expect(await f.adapter.lookup(scope, input.eventId, signal())).toBeNull();
  await f.adapter.cancel(scope, input.eventId, signal());
  expect(f.sessions.lookup).toHaveBeenCalledWith(input.eventId); expect(f.sessions.cancel).toHaveBeenCalledWith(input.eventId);
});

it("rejects cross-session snapshots, stale review work and aborted operations", async () => {
  const f = fixture(), input = await submission(f);
  await expect(f.adapter.submit({ ...input, snapshot: { ...input.snapshot, sessionId: "foreign" } }, signal())).rejects.toThrow("scope_invalid");
  await expect(f.adapter.submit({ ...input, snapshot: { ...input.snapshot, capturedAt: "2000-01-01T00:00:00Z" } }, signal())).rejects.toThrow("expired");
  const controller = new AbortController(); controller.abort();
  await expect(f.adapter.submit(input, controller.signal)).rejects.toThrow(); expect(f.sessions.submit).not.toHaveBeenCalled();
});
