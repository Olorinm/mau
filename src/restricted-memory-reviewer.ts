import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { WorkSessions } from "@agent-router/server";
import type { MemoryReviewScope, MemoryReviewSubmission, RestrictedMemoryReviewer, ReviewCapabilities, ReviewWork } from "./memory-review.js";

export const CODEX_REVIEW_VERSION = "0.165.0";
export const CODEX_REVIEW_SOURCE = "360319d8dee62d87e2d59fc0c21805d79519cfed";
const disabledFeatures = ["apps", "connectors", "code_mode", "code_mode_only", "code_mode_host", "context_management",
  "current_time_reminder", "deferred_executor", "enable_fanout", "goals", "hooks", "codex_hooks", "plugin_hooks",
  "image_generation", "imagegenext", "memories", "memory_tool", "multi_agent", "multi_agent_v2", "multi_agent_v2_dynamic_tools",
  "plugins", "request_permissions_tool", "shell_snapshot", "shell_tool", "standalone_web_search", "token_budget",
  "tool_suggest", "unified_exec", "view_image", "js_repl", "browser_use", "browser_use_external", "computer_use",
  "in_app_browser", "send_message_to_user_async", "sleep_tool", "apply_patch_freeform", "tool_search", "skill_search"] as const;

/** Based on Codex's temporary_structured_request.rs. No selected environment is
 * crucial: feature flags alone are not a public global tool allowlist. This
 * baseline is version/model pinned and must be re-probed before changing either. */
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const nested of Object.values(value)) freeze(nested); Object.freeze(value); }
  return value;
}
export const CODEX_REVIEW_ARGS = freeze(["app-server", "--listen", "stdio://", "-c", "features.api_key_model_discovery=false"]);
export const CODEX_REVIEW_THREAD = freeze({
  model: "gpt-5.4", approvalPolicy: "never", sandbox: "read-only", ephemeral: true,
  environments: [] as unknown[], runtimeWorkspaceRoots: [] as string[], selectedCapabilityRoots: [] as string[],
  config: {
    ...Object.fromEntries(disabledFeatures.map(feature => [`features.${feature}`, false])),
    "cloud.skills.enabled": false, "skills.include_instructions": false,
    "tools.experimental_request_user_input.enabled": false, "tools.update_plan.enabled": false,
    "project_doc_max_bytes": 0, web_search: "disabled", mcp_servers: {},
  },
});
export interface CodexReviewProfile {
  id: string; kernel: "codex"; cwd: string;
  command: string; args: string[]; env: { HOME: string; CODEX_HOME: string };
  thread: typeof CODEX_REVIEW_THREAD;
  nativeAccess: { methods: ["config/read"]; notifications: [] };
}
export function codexReviewProfile(input: { id: string; cwd: string; command: string; home: string; codexHome: string }): CodexReviewProfile {
  const profile: CodexReviewProfile = { id: input.id, kernel: "codex", cwd: input.cwd,
    command: input.command, args: [...CODEX_REVIEW_ARGS], env: { HOME: input.home, CODEX_HOME: input.codexHome },
    thread: structuredClone(CODEX_REVIEW_THREAD), nativeAccess: { methods: ["config/read"], notifications: [] } };
  validateProfile(profile); return profile;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,canonical(v)]));
  return value;
}
export const reviewProfileDigest = (profile: CodexReviewProfile): string => createHash("sha256").update(JSON.stringify(canonical(profile))).digest("hex");
const sameScope = (a: MemoryReviewScope, b: MemoryReviewScope) => a.owner === b.owner && a.agentId === b.agentId;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function validateProfile(profile: CodexReviewProfile): void {
  if (!profile || profile.kernel !== "codex" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(profile.id) ||
    !isAbsolute(profile.cwd) || !isAbsolute(profile.command ?? "") || !isAbsolute(profile.env?.HOME ?? "") ||
    !isAbsolute(profile.env?.CODEX_HOME ?? "")) throw new Error("review_profile_invalid");
  const expected = { id: profile.id, kernel: "codex", cwd: profile.cwd,
    command: profile.command, args: CODEX_REVIEW_ARGS, env: { HOME: profile.env.HOME, CODEX_HOME: profile.env.CODEX_HOME },
    thread: CODEX_REVIEW_THREAD, nativeAccess: { methods: ["config/read"], notifications: [] } };
  if (JSON.stringify(canonical(profile)) !== JSON.stringify(canonical(expected))) throw new Error("review_profile_not_audited");
}

export interface ReviewToolBinding {
  /** Taken from the actual trusted dispatcher, never inferred from tool names. */
  enforcement: "server-dispatch-allowlist";
  memory: { scope: MemoryReviewScope; tool: string; origin: "review"; destructiveWrites: "stage-for-owner-approval" };
  skills: { mode: "unavailable" } | { mode: "native-managed"; scope: MemoryReviewScope; tools: string[] };
  allowedTools: string[];
  otherTools: "denied";
  delivery: "disabled";
  recursion: "disabled";
}
export interface ReviewRuntimeBinding {
  /** The trusted original employee whose memory is being maintained. The worker
   * may have another agent ID, but its tools must remain mapped to this scope. */
  employee: MemoryReviewScope;
  sessions: Pick<WorkSessions, "owner" | "agentId" | "runtimeId" | "submit" | "lookup" | "cancel" | "discover" | "host">;
  profile: CodexReviewProfile;
  /** The launcher must derive this from the installed profile, and verify private
   * empty HOME/cwd plus the live dispatcher mapping. A config boolean is not proof. */
  installed: { profileDigest: string; homeIsolation: "dedicated-private"; modelCatalog: "bundled-0.165.0"; toolBinding: ReviewToolBinding };
}
export interface CodexRestrictedReviewerDependencies {
  /** Resolve and attest the currently installed runtime, not a requested future
   * configuration. Called before every submission and reconciliation. */
  resolve(scope: MemoryReviewScope, signal: AbortSignal): Promise<ReviewRuntimeBinding>;
  maxToolCalls?: number;
  timeoutSeconds?: number;
}

/** A functioning Router adapter, with no connector, fork or deliver call. It
 * still requires the embedding server to provision a dedicated worker/runtime
 * and its original-employee managed-tool binding; it never fabricates that proof. */
export class CodexRestrictedMemoryReviewer implements RestrictedMemoryReviewer {
  private readonly maxToolCalls: number;
  private readonly timeoutSeconds: number;
  constructor(private readonly deps: CodexRestrictedReviewerDependencies) {
    this.maxToolCalls = deps.maxToolCalls ?? 20; this.timeoutSeconds = deps.timeoutSeconds ?? 300;
    if (!Number.isInteger(this.maxToolCalls) || this.maxToolCalls < 1 || this.maxToolCalls > 1000 ||
      !Number.isInteger(this.timeoutSeconds) || this.timeoutSeconds < 1 || this.timeoutSeconds > 1800) throw new Error("review_budget_invalid");
  }
  async capabilities(scope: MemoryReviewScope, signal: AbortSignal) {
    try { const binding = await this.verified(scope, signal); return this.proof(binding); }
    catch (error) { return { status: "unsupported" as const, reason: error instanceof Error ? error.message.slice(0,200) : "review_runtime_unverified" }; }
  }
  async submit(input: MemoryReviewSubmission, signal: AbortSignal): Promise<ReviewWork> {
    const binding = await this.verified(input, signal), capabilities = this.proof(binding);
    if (input.origin !== "review" || input.runtimeId !== capabilities.runtimeId || input.policyId !== capabilities.policyId ||
      (input.reviewSkills && !capabilities.skills) || !sameScope(input, input.snapshot) || input.snapshot.source !== "native_history" ||
      input.snapshot.sessionId !== input.sourceSessionId || input.snapshot.sourceRunId !== input.sourceRunId || input.sessionId === input.sourceSessionId ||
      !/^memory-review-[a-f0-9]{64}$/.test(input.eventId) || !/^review-[a-f0-9]{64}$/.test(input.sessionId)) throw new Error("review_submission_scope_invalid");
    const expiresAt = new Date(Date.parse(input.snapshot.capturedAt) + this.timeoutSeconds * 1000);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new Error("review_submission_expired");
    signal.throwIfAborted();
    return binding.sessions.submit({ eventId: input.eventId, sessionId: input.sessionId, input: input.prompt,
      admission: { kind: "delegation", owner: binding.sessions.owner, agentId: binding.sessions.agentId,
        reference: input.eventId, toolGrants: {}, maxToolCalls: this.maxToolCalls, expiresAt: expiresAt.toISOString() },
      context: { origin: "review", policyId: capabilities.policyId, employee: { owner: input.owner, agentId: input.agentId },
        reviewMemory: input.reviewMemory, reviewSkills: input.reviewSkills,
        copiedTranscript: structuredClone(input.snapshot) } });
  }
  async lookup(scope: MemoryReviewScope, eventId: string, signal: AbortSignal): Promise<ReviewWork | null> {
    const binding = await this.bound(scope, signal); signal.throwIfAborted(); return binding.sessions.lookup(eventId);
  }
  async cancel(scope: MemoryReviewScope, eventId: string, signal: AbortSignal): Promise<unknown> {
    const binding = await this.bound(scope, signal); signal.throwIfAborted(); return binding.sessions.cancel(eventId);
  }
  private async bound(scope: MemoryReviewScope, signal: AbortSignal): Promise<ReviewRuntimeBinding> {
    const binding = await this.deps.resolve({ owner: scope.owner, agentId: scope.agentId }, signal);
    signal.throwIfAborted();
    if (!sameScope(scope, binding.employee) || binding.sessions.owner !== scope.owner || binding.sessions.runtimeId !== binding.profile.id)
      throw new Error("review_runtime_scope_mismatch");
    return binding;
  }
  private async verified(scope: MemoryReviewScope, signal: AbortSignal): Promise<ReviewRuntimeBinding> {
    const binding = await this.bound(scope, signal); validateProfile(binding.profile);
    if (binding.installed.profileDigest !== reviewProfileDigest(binding.profile) || binding.installed.homeIsolation !== "dedicated-private" || binding.installed.modelCatalog !== "bundled-0.165.0")
      throw new Error("review_installed_profile_unverified");
    const policy = binding.installed.toolBinding;
    const skills = policy.skills.mode === "native-managed" ? policy.skills.tools : [];
    if (policy.enforcement !== "server-dispatch-allowlist" || policy.otherTools !== "denied" || policy.delivery !== "disabled" || policy.recursion !== "disabled" ||
      !sameScope(scope, policy.memory.scope) || policy.memory.origin !== "review" || policy.memory.destructiveWrites !== "stage-for-owner-approval" ||
      (policy.skills.mode === "native-managed" && (!sameScope(scope, policy.skills.scope) || !skills.length)) ||
      !policy.memory.tool || new Set(policy.allowedTools).size !== policy.allowedTools.length ||
      JSON.stringify([...policy.allowedTools].sort()) !== JSON.stringify([policy.memory.tool, ...skills].sort()))
      throw new Error("review_dispatch_policy_unverified");
    const discovery = object(await binding.sessions.discover()), native = object(discovery.native);
    const userAgent = object(native.initialize).userAgent;
    if (typeof userAgent !== "string" || !/(?:\/|\s)0\.165\.0(?:\s|$)/.test(userAgent)) throw new Error("review_codex_version_not_audited");
    signal.throwIfAborted();
    if (!binding.sessions.host.nativeRequest) throw new Error("review_effective_config_unavailable");
    const result = object(await binding.sessions.host.nativeRequest(binding.sessions.runtimeId, "config/read", { includeLayers: false, cwd: binding.profile.cwd }));
    if (!result.config || typeof result.config !== "object") throw new Error("review_effective_config_unavailable");
    const config = object(result.config), servers = config.mcp_servers;
    if (config.model_catalog_json || Object.values(object(config.model_providers)).some(provider => object(provider).model_catalog_url))
      throw new Error("review_model_catalog_override_not_audited");
    const features = object(config.features), provider = object(object(config.model_providers)[String(config.model_provider)]);
    // remote_models is a removed flag in this version. Restrict to the tested
    // dedicated Responses-provider path; do not claim an OAuth catalog is frozen.
    if (features.api_key_model_discovery !== false || provider.requires_openai_auth !== false || provider.wire_api !== "responses")
      throw new Error("review_provider_catalog_not_audited");
    // An empty thread override does not erase inherited named MCP servers. Refuse
    // any enabled server instead of silently relying on an incomplete list.
    if (servers !== undefined && (servers === null || typeof servers !== "object" || Array.isArray(servers) ||
      Object.values(servers).some(server => object(server).enabled !== false))) throw new Error("review_mcp_not_disabled");
    signal.throwIfAborted(); return binding;
  }
  private proof(binding: ReviewRuntimeBinding): ReviewCapabilities {
    return { ...binding.employee, status: "available", runtimeId: binding.profile.id,
      policyId: createHash("sha256").update(JSON.stringify(canonical({ version: CODEX_REVIEW_VERSION, profile: binding.installed.profileDigest, tools: binding.installed.toolBinding }))).digest("hex"),
      isolation: "dedicated-runtime", enforcement: "runtime-tool-allowlist", otherTools: "denied",
      contextAccess: "copied-session-and-managed-memory-skills", sideEffects: "managed-memory-skills-only",
      unattendedDestructiveWrites: "stage-for-owner-approval", delivery: "disabled", recursion: "disabled",
      memory: true, skills: binding.installed.toolBinding.skills.mode === "native-managed" };
  }
}
