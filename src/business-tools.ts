import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ScheduledMemoryContext } from "./partner-context.js";
import { z } from "zod";
import { HttpAgentHost, RouterError, type HostPort, type ServiceHttp, type HostTool, type HostCall } from "@agent-router/server";
import { FeishuBotReader, feishuBotReaderSchema } from "@olorinm/agent-connectors/feishu-bot-reader";
import { CloudflareReadClient, cloudflareReadSchema } from "@olorinm/agent-connectors/cloudflare-read-client";
import { DurableStore } from "./store.js";
import { ConnectedApps, connectedAppDefinition, connectedAppInput, browserToolName, type ConnectedAppReader } from "./connected-apps.js";
import { APPROVAL_PREFIX, ConnectorApprovals, type ApprovalDesk, type ApprovalPort } from "./connector-approvals.js";
import { IMAGE_ITEMS, RelayError, SITE_CHOICES, agentCatalog, browserTool, finishBrowser, handoffCardInput, prepareBrowser, scrub, siteAnswer, siteCardInput, siteDenied,
  siteRequired, siteUnavailableHere, type Handoff, type SandboxFiles } from "./browser-relay.js";
import { validAdmission, type RunAdmission, type AdmissionValidator } from "./run-admission.js";
import { ownerPrivateRefusal, OWNER_PRIVATE_ONLY, type OwnerPrivatePolicy } from "./owner-private.js";

/** A Feishu bot identity read on the server, directly or through the Cloudflare read broker. */
export const feishuBotReadersSchema = z.array(z.union([feishuBotReaderSchema.extend({
  agentId: z.uuid(), owner: z.string().min(1),
}).strict(), cloudflareReadSchema])).max(100).default([]);

/** Compose trusted tools with Host's native dynamic-tool protocol; no credential goes to Host. */
const feishuInput = z.object({ args: z.array(z.string().max(100_000)).min(1).max(100) }).strict();
const feishuDefinition = { name: "feishu_bot_read", timeoutMs: 90_000,
  description: "Read Feishu resources using the existing bot's permissions through the server-side official CLI. Start with args=[\"skills\",\"read\",\"lark-shared\"] and the relevant domain skill, or args=[\"--help\"]. Inspect a command with args=[\"schema\",\"drive files list\"]. Avoid the full schema catalog. Pass args without the executable, --as, --profile, shell syntax or local paths. Writes are refused. Sending replies/files in the current conversation uses the separate channel tool.",
  inputSchema: z.toJSONSchema(feishuInput) };
type BotReader = Pick<FeishuBotReader, "read">;
// Native tool catalogs are frozen per session, so older sessions still list removed tools.
// Answer those calls at once instead of leaving them pending until Host's deadline.
const removedTools = new Set(["business_data", "employee_memory", "work_sessions"]);
const toolRemoved = { isError: true, error: "tool_removed",
  instruction: "This tool no longer exists. This conversation still lists the tools it began with; the owner can start a new conversation to load the current ones." };
const sameTool = (definition: Pick<HostTool, "name" | "namespace">, call: HostCall) =>
  definition.name === call.name && (definition.namespace ?? null) === (call.namespace ?? null);
/** What the product grants a turn that a partner's message started, beyond its tool grants. */
export interface PartnerAuthority {
  /** Connected-app writes can ask the owner, as in the owner's turn the message came from. */
  write: boolean;
  /** Where the owner is asked when the turn itself has no owner conversation to ask in. */
  approvals?: ApprovalDesk;
  /** The tool whose delivery the turn's input is: a kernel that takes tool output is given the input under this name. */
  tool: string;
}
export interface PartnerTools {
  definitions: NonNullable<Parameters<HostPort["start"]>[0]["tools"]>;
  context(admission: RunAdmission, input: string, sessionKey?: string): unknown;
  scheduledContext?(admission: RunAdmission): ScheduledMemoryContext | undefined;
  /**
   * What a turn is told beside its input: a memory reminder, the roster, notes partners left. Keys become context
   * members. `tools` names the product tools of the turn's session, which may have begun with an earlier set.
   */
  turnContext?(admission: RunAdmission, sessionId: string, tools: string[]): Promise<Record<string, unknown>>;
  /** Defined only for a turn a partner's message started: one that handles the message, or one that hands its result over. */
  authority?(admission: RunAdmission): PartnerAuthority | undefined;
  /** Every run seen at the Host, running or ended. */
  observe?(run: { id: string; status: string }): void;
  /** The result of a call of one of these tools has reached the Host. */
  delivered?(name: string, admission: RunAdmission, callId: string): void;
  execute(name: string, input: unknown, admission: RunAdmission, callId: string, runId: string): Promise<unknown>;
}
export class BusinessTools {
  private readonly readers = new Map<string, { owner: string; reader: BotReader }>();
  private admissionValidator?: AdmissionValidator;
  private partnerTools?: (agentId: string, owner: string) => PartnerTools;
  private completed?: (input: CompletedPartnerTurn) => void;
  private approvals?: ApprovalPort;
  private files?: (agentId: string, binding: string) => Promise<SandboxFiles>;
  private sites?: SitePort;
  constructor(options: z.input<typeof feishuBotReadersSchema>, base: string, private readonly store: DurableStore, private readonly apps?: ConnectedApps) {
    for (const entry of feishuBotReadersSchema.parse(options)) {
      const { agentId, owner } = entry;
      if (this.readers.has(agentId)) throw new Error("duplicate_business_tool_agent");
      if ("mode" in entry) {
        const client = new CloudflareReadClient({ ...entry, tokenFile: resolve(base, entry.tokenFile) });
        this.readers.set(agentId, { owner, reader: { read: args => client.read(args) } });
        continue;
      }
      const { agentId: _agentId, owner: _owner, ...settings } = entry;
      this.readers.set(agentId, { owner, reader: new FeishuBotReader({ ...settings,
        appSecretFile: resolve(base, settings.appSecretFile), directory: resolve(base, settings.directory) }) });
    }
  }
  setAdmissionValidator(validate: AdmissionValidator) { this.admissionValidator = validate; }
  setPartnerTools(provider: (agentId: string, owner: string) => PartnerTools) { this.partnerTools = provider; }
  onCompleted(callback: (input: CompletedPartnerTurn) => void) { this.completed = callback; }
  /** Only a component holding the authority key may present connector writes; without it every caller stays read-only. */
  setApprovals(port: ApprovalPort) { this.approvals = port; }
  setSandboxFiles(files: (agentId: string, binding: string) => Promise<SandboxFiles>) { this.files = files; }
  /** Only a component holding the authority key can record the owner's answer on a site card; without it no turn can ask. */
  setSites(port: SitePort) { this.sites = port; }
  private ownerPrivate?: OwnerPrivatePolicy;
  /** Owner-identity connections are admitted only in the owner's private conversation. */
  setOwnerPrivate(policy: OwnerPrivatePolicy) { this.ownerPrivate = policy; }
  private skills?: (agentId: string, owner: string, binding: string) => Promise<unknown>;
  /** Connector guides and CLI commands are brought into the environment before a run starts. */
  setSkills(sync: (agentId: string, owner: string, binding: string) => Promise<unknown>) { this.skills = sync; }
  private guides?: (agentId: string) => ((tools: string[]) => Record<string, unknown>) | undefined;
  /** For an Agent whose kernel has no relay commands: the guides its `connected_apps` catalog carries, for the tools it lists. */
  setGuides(guides: (agentId: string) => ((tools: string[]) => Record<string, unknown>) | undefined) { this.guides = guides; }
  host(agentId: string, owner: string, binding: string, http: ServiceHttp): HostPort {
    const entry = this.readers.get(agentId);
    const bot = entry?.owner === owner ? entry.reader : undefined, appReader = this.apps?.reader(agentId, owner);
    const partner = this.partnerTools?.(agentId, owner);
    if (!bot && !appReader && !partner) return new HttpAgentHost(http);
    const files = this.files, skills = this.skills, guides = appReader ? this.guides?.(agentId) : undefined;
    const host = new BusinessHost(http, bot, this.store, `${agentId}:${binding}`, appReader,
      { agentId, owner, validate: admission => this.admissionValidator?.(admission) ?? true }, partner, this.completed,
      appReader ? { connections: () => this.apps!.connections(agentId, owner), browser: () => this.apps!.browser(agentId, owner),
        ...(this.approvals && this.apps!.writable ? { approvals: this.approvals } : {}),
        ...(this.sites ? { sites: this.sites } : {}),
        ...(this.ownerPrivate ? { ownerPrivate: this.ownerPrivate } : {}),
        ...(guides ? { guides } : {}),
        ...(files ? { files: () => files(agentId, binding) } : {}) } : undefined);
    if (appReader && skills) host.beforeStart = () => skills(agentId, owner, binding);
    return host;
  }
}
export interface CompletedPartnerTurn { admission: RunAdmission; runId: string; sessionId: string; sessionKey: string; input: string; inputRole?: "user" | "tool"; answer: string; }
/** Records a site the owner allowed for a browser connection: always, or with `task` for that conversation only. */
export interface SitePort { allowSite(owner: string, connection: string, site: string, task?: string): Promise<void>; }
/**
 * A browser command waiting for the owner's answer about a site. `open` has its card up; `decided` holds the answer;
 * `running` means the permission is being recorded and the command run again, which is never done twice; `closed`
 * is done.
 */
interface SiteRequest {
  status: "open" | "decided" | "running" | "closed"; choice?: "task" | "always" | "deny";
  runId: string; callId: string; deadlineAt: string; owner: string; agentId: string; connections: string[];
  connection: string; site: string; command: string; task: string;
  name: string; arguments: Record<string, unknown>; scope?: { connections: string[]; operations?: string[] | undefined }; write: boolean;
}
/** Product-side extras for connected apps: owner write approvals and the browser workspace relay. */
interface ConnectedAppHosting {
  /** The connections the Agent can use now, and the browser ones among them: read on every use, as the owner can change them. */
  connections(): string[];
  browser(): string[];
  approvals?: ApprovalPort;
  sites?: SitePort;
  files?: () => Promise<SandboxFiles>;
  ownerPrivate?: OwnerPrivatePolicy;
  /** The connector guides for the tools a catalog lists, when the Agent's kernel has none installed. */
  guides?: (tools: string[]) => Record<string, unknown>;
}
const WAITING = Symbol("approval_waiting");
class Removed extends Error {}
const delivered = (admission: RunAdmission | undefined, toolOutput: unknown) => Boolean(toolOutput) || (admission !== undefined && admission.kind !== "owner");
const HANDOFF_PREFIX = "mau-handoff:";
const SITE_PREFIX = "mau-site:";
const handoffCancel = "取消接管";
// A structured single-choice question both Router's chat cards and the web console render with buttons.
const handoffMethod = "item/tool/requestUserInput";
/** Work that cannot ask the owner (a schedule) is refused an operation set to ask, with this explanation. */
const APPROVAL_UNAVAILABLE_HERE = "owner_approval_unavailable_here";
const approvalUnavailableHere = (refusal: Record<string, unknown>) => {
  const detail = z.object({ operation: z.string().max(100).nullable().optional(), label: z.string().max(200).optional() }).passthrough().safeParse(refusal.detail).data;
  return { status: "failed", error: APPROVAL_UNAVAILABLE_HERE, ...(detail?.operation ? { operation: detail.operation } : {}), ...(detail?.label ? { label: detail.label } : {}),
    message: "这个操作被设置为每次都要你批准，但定时任务这类后台任务无法向你弹出批准卡片，所以这里不能执行。",
    instruction: "The owner cannot approve here. Do not retry in this task; tell the owner it needs their approval in their own conversation, or that they can allow it in Mau's connector settings." };
};
const approvalRequired = z.object({ status: z.literal("approval_required"), operationId: z.string().min(1).max(64),
  expiresAt: z.string().optional() }).passthrough();
export class BusinessHost extends HttpAgentHost {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly siteWork = new Map<string, Promise<void>>();
  private readonly approvals?: ConnectorApprovals;
  beforeStart?: () => Promise<unknown>;
  constructor(http: ServiceHttp, private readonly bot: BotReader | undefined,
    private readonly store: DurableStore, private readonly scope: string, private readonly appReader?: ConnectedAppReader,
    private readonly principal?: { agentId: string; owner: string; validate?: AdmissionValidator }, private readonly partner?: PartnerTools,
    private readonly completed?: (input: CompletedPartnerTurn) => void, private readonly apps?: ConnectedAppHosting) {
    super(http);
    if (apps?.approvals) this.approvals = new ConnectorApprovals(store, scope, apps.approvals, async (record, outcome) => {
      let value: unknown;
      try { value = await this.finishApp({ runId: record.runId, id: record.callId }, record.name, outcome); } catch { value = { status: "failed", error: "browser_relay_failed" }; }
      const receiptKey = `${this.scope}:${record.runId}:${record.callId}`;
      const receipt = this.store.get<{ hash: string }>("business_call_receipts", receiptKey);
      if (receipt) this.store.set("business_call_receipts", receiptKey, { hash: receipt.hash, result: value });
      await this.deliver(record.runId, record.callId, value, true);
    });
  }
  override async start(input: Parameters<HostPort["start"]>[0] & { admission?: RunAdmission }) {
    const { admission: supplied, ...request } = input;
    // Installing guides must never block or fail a run.
    await this.beforeStart?.().catch((error: unknown) => console.warn(JSON.stringify({ event: "agent_skills_sync_failed",
      error: error instanceof Error ? error.message : "unknown" })));
    const admission = this.admission(supplied);
    if (supplied && !admission) throw new RouterError("business_run_admission_invalid", 403);
    const requestId = input.requestKey ? `${this.scope}:${input.runtimeId}:${input.requestKey}` : undefined;
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const sessionKey = `${this.scope}:${input.sessionId}`;
    /** The session's product tools: the ones it began with, or for a new session the ones this turn is admitted to. */
    const partnerTurn = admission && this.partner?.authority?.(admission);
    const catalog = () => {
      // A partner's message opens the same session an owner's message would: the whole catalog. Calls stay bound to the run's grants.
      const granted = (kind: "feishu" | "connectedApps") => admission &&
        (admission.kind === "owner" && !admission.toolGrants || Boolean(partnerTurn) || Boolean(admission.toolGrants?.[kind]));
      const proposed = [...(granted("feishu") && this.bot ? [feishuDefinition] : []),
        // A session gets `connected_apps` when the Agent has a connection at its first turn; what the tool reaches is read on every call.
        ...(granted("connectedApps") && this.appReader && this.apps?.connections().length !== 0 ? [connectedAppDefinition] : []),
        ...(admission && admission.kind !== "schedule" ? this.partner?.definitions ?? [] : [])];
      return this.store.get<typeof proposed>("business_session_catalog", sessionKey) ?? proposed;
    };
    const prepare = (added: ReturnType<typeof catalog>, told: Record<string, unknown>) => {
      const priorInstructions = this.store.get<string>("business_session_instructions", sessionKey);
      const snapshot = priorInstructions === undefined && admission ? this.partner?.context(admission, input.input, sessionKey) : undefined;
      const memory = snapshot && typeof snapshot === "object" && "text" in snapshot && typeof snapshot.text === "string" ? snapshot.text : "";
      // Frozen native instructions survive writes, restarts and forks. A scheduled
      // turn in an existing conversation retains that conversation's original snapshot.
      const instructions = priorInstructions ?? (memory ? `${request.instructions}\n\n${memory}` : request.instructions);
      // Admission is consumed here; native model input cannot grant itself access.
      const scheduledMemory = admission?.kind === "schedule" ? this.partner?.scheduledContext?.(admission) : undefined;
      // Router labels delegated input with the product's former delegation tool. A partner's turn names the tool that
      // sent it, in a session that has that tool; a session that began with the former one keeps Router's label.
      let toolOutput = partnerTurn && request.toolOutput?.namespace === "mau" && added.some(tool => tool.name === partnerTurn.tool)
        ? { ...request.toolOutput, name: partnerTurn.tool } : request.toolOutput;
      let memoryContext: ScheduledMemoryContext | Omit<ScheduledMemoryContext, "text"> | undefined = scheduledMemory;
      if (scheduledMemory && toolOutput) {
        let original = toolOutput.output;
        if (typeof original === "string") { try { original = JSON.parse(original); } catch { /* Plain text is also valid tool output. */ } }
        // Put the full read-only view in the actual tool result consumed by the
        // native turn; additionalContext carries only metadata, not a second copy.
        const body = original && typeof original === "object" && !Array.isArray(original) ? original : { taskOutput: original };
        toolOutput = { ...toolOutput, output: JSON.stringify({ ...body, scheduledMemory }) };
        const { text: _text, ...metadata } = scheduledMemory; memoryContext = metadata;
      }
      const forwarded = { ...request, instructions, ...(added.length ? { tools: [...(request.tools ?? []), ...added] } : {}),
        ...(toolOutput ? { toolOutput } : {}),
        ...(Object.keys(told).length || memoryContext ? { context: { requestContext: request.context ?? null,
          ...told, ...(memoryContext ? { scheduledMemory: memoryContext } : {}) } } : {}) };
      return { hash, request: forwarded, sessionKey, added,
        ...(admission ? { admission } : {}) };
    };
    let selected = requestId ? this.store.get<ReturnType<typeof prepare>>("business_run_requests", requestId) : undefined;
    if (selected && selected.hash !== hash) throw new RouterError("business_run_request_conflict", 409);
    if (!selected) {
      // What the turn is told is read once, with its first request; a retry sends what was saved.
      const added = catalog();
      selected = prepare(added, admission && admission.kind !== "schedule"
        ? await this.partner?.turnContext?.(admission, input.sessionId, added.map(tool => tool.name)) ?? {} : {});
      if (requestId && !this.store.insert("business_run_requests", requestId, selected)) {
        selected = this.store.get<ReturnType<typeof prepare>>("business_run_requests", requestId)!;
        if (selected.hash !== hash) throw new RouterError("business_run_request_conflict", 409);
      }
    }
    this.store.set("business_session_instructions", sessionKey, selected.request.instructions);
    const run = await super.start(selected.request);
    this.store.set("business_session_catalog", sessionKey, selected.added);
    this.saveGrant(run.id, selected.admission);
    // Only an owner's turn has a human's input. Delivered input is a tool output, or text for a runtime that takes no tool output.
    this.store.set("business_turn_inputs", `${this.scope}:${run.id}`, { sessionKey, sessionId: input.sessionId,
      input: input.toolOutput ? JSON.stringify(input.toolOutput) : input.input, inputRole: delivered(selected.admission, input.toolOutput) ? "tool" : "user" });
    this.partner?.observe?.(run);
    this.observeCompleted(run);
    return run;
  }
  override async findRun(runtimeId: string, requestKey: string) {
    const run = await super.findRun(runtimeId, requestKey);
    if (run) {
      const pending = this.store.get<{ request: { sessionId: string; input: string; instructions: string; toolOutput?: unknown }; sessionKey: string; added: unknown; admission?: RunAdmission }>(
        "business_run_requests", `${this.scope}:${runtimeId}:${requestKey}`);
      if (pending) {
        if (run.runtimeId !== runtimeId || run.sessionId !== pending.request.sessionId) throw new RouterError("business_run_scope_mismatch", 409);
        this.store.set("business_session_catalog", pending.sessionKey, pending.added);
        this.store.set("business_session_instructions", pending.sessionKey, pending.request.instructions);
        this.store.set("business_turn_inputs", `${this.scope}:${run.id}`, { sessionKey: pending.sessionKey, sessionId: pending.request.sessionId,
          input: pending.request.toolOutput ? JSON.stringify(pending.request.toolOutput) : pending.request.input, inputRole: delivered(pending.admission, pending.request.toolOutput) ? "tool" : "user" });
        this.saveGrant(run.id, pending.admission);
        this.partner?.observe?.(run);
        this.observeCompleted(run);
      }
    }
    return run;
  }
  override async get(id: string) {
    const run = await super.get(id); this.partner?.observe?.(run); this.observeCompleted(run); return run;
  }
  private observeCompleted(run: Awaited<ReturnType<HostPort["get"]>>) {
    if (!this.completed || run.status !== "completed" || run.outcome?.outcomeUnknown) return;
    const key = `${this.scope}:${run.id}`;
    const grant = this.store.get<{ admission?: RunAdmission }>("business_runs", key);
    const turn = this.store.get<{ sessionKey: string; sessionId: string; input: string; inputRole?: "user" | "tool" }>("business_turn_inputs", key);
    if (!grant?.admission || !turn || this.store.get("business_turn_observed", key)) return;
    // The observer only enqueues local work; no model or remote calls on the foreground path.
    try {
      this.completed({ ...turn, admission: grant.admission, runId: run.id, answer: run.answer });
      this.store.set("business_turn_observed", key, true);
      this.store.delete("business_observation_errors", key);
    } catch {
      // Memory bookkeeping must not turn a completed owner task into a failed run.
      this.store.set("business_observation_errors", key, { status: "failed", error: "memory_bookkeeping_failed", runId: run.id });
    }
  }
  override async nativeSessions(input: Parameters<HttpAgentHost["nativeSessions"]>[0]) {
    const result = await super.nativeSessions(input);
    if (input.action === "fork" && input.sessionId && input.targetSessionId) {
      // Codex forks the complete tool binding. Keep that catalog even when the
      // child's next admitted run has narrower permissions than its parent.
      const catalog = this.store.get("business_session_catalog", `${this.scope}:${input.sessionId}`);
      if (catalog) this.store.set("business_session_catalog", `${this.scope}:${input.targetSessionId}`, catalog);
      const instructions = this.store.get<string>("business_session_instructions", `${this.scope}:${input.sessionId}`);
      if (instructions !== undefined) this.store.set("business_session_instructions", `${this.scope}:${input.targetSessionId}`, instructions);
    }
    return result;
  }
  private saveGrant(runId: string, admission?: RunAdmission) {
    const key = `${this.scope}:${runId}`;
    const prior = this.store.get<{ admission?: RunAdmission; count: number }>("business_runs", key);
    if (prior && JSON.stringify(prior.admission) !== JSON.stringify(admission)) throw new Error("business_run_grant_conflict");
    if (!prior) this.store.set("business_runs", key, { ...(admission ? { admission } : {}), count: 0 });
  }
  private admission(value: unknown) {
    return this.principal ? validAdmission(value, this.principal.agentId, this.principal.owner, this.principal.validate) : undefined;
  }
  private ownsCall(call: HostCall) {
    return (removedTools.has(call.name) && !call.namespace) ||
      [feishuDefinition, connectedAppDefinition, ...(this.partner?.definitions ?? [])].some(tool => sameTool(tool, call));
  }
  override async calls(id: string): ReturnType<HostPort["calls"]> {
    // Synthetic IDs belong to Mau. A sandbox Host listing one could put its own text on Mau's approval.
    const calls = (await super.calls(id)).filter(call => ![APPROVAL_PREFIX, HANDOFF_PREFIX, SITE_PREFIX].some(prefix => call.id.startsWith(prefix)));
    for (const call of calls) {
      if (!this.ownsCall(call) || call.kind !== "tool" || call.status !== "pending") continue;
      const pendingKey = `${id}:${call.id}`;
      let operation = this.pending.get(pendingKey);
      if (!operation) {
        operation = (async () => {
          const grantKey = `${this.scope}:${id}`;
          const grant = this.store.get<{ admission?: RunAdmission; count: number }>("business_runs", grantKey);
          let result: unknown, delivered: (() => void) | undefined;
          try {
            if (removedTools.has(call.name) && !call.namespace) throw new Removed();
            const admission = this.admission(grant?.admission);
            if (!grant || !admission || call.runId !== id) throw new Error("business_tool_not_authorized");
            const productTool = this.partner?.definitions.some(d => sameTool(d, call));
            const kind = call.name === connectedAppDefinition.name ? "connectedApps" : "feishu";
            if (productTool ? admission.kind === "schedule" : !(admission.kind === "owner" && !admission.toolGrants) && !admission.toolGrants?.[kind]) throw new Error("business_tool_not_authorized");
            if (!productTool && (kind === "connectedApps" ? !this.appReader : !this.bot)) throw new Error("business_tool_not_authorized");
            const receiptKey = `${grantKey}:${call.id}`;
            const hash = createHash("sha256").update(JSON.stringify([call.namespace ?? null, call.name, call.input])).digest("hex");
            const prior = this.store.get<{ hash: string; result?: unknown; approval?: boolean }>("business_call_receipts", receiptKey);
            if (prior) {
              if (prior.hash !== hash) throw new Error("business_call_changed");
              result = prior.approval && prior.result === undefined ? WAITING
                : prior.result ?? { isError: true, status: "uncertain", error: "business_call_outcome_unknown" };
              // Only the tool's own result counts as delivered, not the notice that its outcome is unknown.
              if (productTool && prior.result !== undefined) delivered = () => this.partner?.delivered?.(call.name, admission, call.id);
            } else {
            // A call past its deadline is not started. One that waits for the owner is ended by its approval record above.
            if (!(Date.parse(call.deadlineAt) > Date.now())) throw new Error("business_tool_not_authorized");
            if (grant.count >= (admission.maxToolCalls ?? 1000)) throw new Error("business_tool_budget_exhausted");
            this.store.transaction(() => {
              this.store.set("business_runs", grantKey, { ...grant, count: grant.count + 1 });
              this.store.set("business_call_receipts", receiptKey, { hash });
            });
            if (productTool) {
              result = await this.partner!.execute(call.name, call.input, admission, call.id, id);
              delivered = () => this.partner?.delivered?.(call.name, admission, call.id);
            } else if (call.name === connectedAppDefinition.name) {
              const parsed = connectedAppInput.safeParse(call.input);
              if (!this.appReader || !parsed.success) throw new Error("business_tool_not_authorized");
              result = await this.connectedApp(parsed.data, admission, call);
            } else {
              const parsed = feishuInput.safeParse(call.input);
              if (!this.bot || !parsed.success) throw new Error("invalid_business_arguments");
              result = await this.bot.read(parsed.data.args);
            }
            this.store.set("business_call_receipts", receiptKey, result === WAITING ? { hash, approval: true } : { hash, result });
            }
          } catch (error) {
            const known = error instanceof Error && ["business_tool_not_authorized", "business_call_changed", "business_tool_budget_exhausted", "invalid_business_arguments", "feishu_write_requires_owner_approval", "proactive_owner_admission_required"].includes(error.message);
            // The model is told only that the tool is unavailable; the operator's log has the cause, never the tool's input.
            if (!(error instanceof Removed) && !known) process.stderr.write(JSON.stringify({ event: "mau.tool_failed", runId: id, tool: call.name,
              name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) }) + "\n");
            result = error instanceof Removed ? toolRemoved
              : { isError: true, error: known ? (error as Error).message
                : call.name === connectedAppDefinition.name ? "connected_app_unavailable" : this.partner?.definitions.some(d => d.name === call.name) ? "partner_tool_unavailable" : "feishu_read_unavailable" };
          }
          // A write awaiting the owner keeps its Host call pending; the approval card resolves it.
          if (result !== WAITING) { await this.deliver(id, call.id, result); delivered?.(); }
        })().finally(() => this.pending.delete(pendingKey));
        this.pending.set(pendingKey, operation);
      }
      await operation;
    }
    const cards = [...await this.approvals?.synthetic(id, calls, this.desk(id)) ?? [], ...this.handoffCards(id), ...await this.siteCards(id, calls)];
    return [...calls.filter(call => !this.ownsCall(call) || call.kind !== "tool"), ...cards];
  }
  /** Synthetic IDs are answered here and never forwarded to Host. */
  override async resolve(id: string, callId: string, result: unknown) {
    if (callId.startsWith(APPROVAL_PREFIX)) {
      if (!this.approvals) throw new RouterError("approval_not_found", 404);
      return this.approvals.decide(id, callId, result);
    }
    if (callId.startsWith(HANDOFF_PREFIX)) return this.answerHandoff(id, callId.slice(HANDOFF_PREFIX.length), result);
    if (callId.startsWith(SITE_PREFIX)) return this.answerSite(id, callId.slice(SITE_PREFIX.length), result);
    return super.resolve(id, callId, result);
  }
  /** Where the owner is asked for a run that handles a partner's message: the conversation that message came from. */
  private desk(runId: string) {
    const admission = this.admission(this.store.get<{ admission?: RunAdmission }>("business_runs", `${this.scope}:${runId}`)?.admission);
    return admission && this.partner?.authority?.(admission)?.approvals;
  }
  /** Test and shutdown hook: wait for decided approvals of a run to reach Host. */
  async settled(runId: string) {
    await Promise.all([...this.siteWork].filter(([key]) => key.startsWith(`${this.scope}:${runId}:`)).map(([, work]) => work));
    await this.approvals?.waitFor(runId);
  }
  private async deliver(runId: string, callId: string, result: unknown, tolerateClosed = false) {
    const images = result && typeof result === "object" && Array.isArray((result as Record<string, unknown>)[IMAGE_ITEMS])
      ? (result as Record<string, unknown>)[IMAGE_ITEMS] as string[] : [];
    const { [IMAGE_ITEMS]: _images, ...visible } = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : { value: result };
    const body = result && typeof result === "object" && !Array.isArray(result) ? visible : result;
    let text = JSON.stringify(body);
    if (text.length > 1_000_000) text = JSON.stringify({ isError: true, error: "business_result_too_large", instruction: "Narrow the query." });
    const value = { success: !(body as any)?.isError && !["failed", "uncertain"].includes((body as any)?.status),
      contentItems: [{ type: "inputText" as const, text }, ...images.map(imageUrl => ({ type: "inputImage" as const, imageUrl }))] };
    try { await super.resolve(runId, callId, value); }
    catch (error) {
      // An approval decided after Host closed the call has nowhere to go; a transient failure retries.
      if (!tolerateClosed || (await super.calls(runId)).some(call => call.id === callId && call.status === "pending")) throw error;
    }
  }
  private async connectedApp(input: z.infer<typeof connectedAppInput>, admission: RunAdmission, call: HostCall): Promise<unknown> {
    const granted = admission.toolGrants?.connectedApps, apps = this.apps;
    let connections = (apps?.connections() ?? []).filter(id => !granted || granted.connections.includes(id));
    // A turn a partner's message started may write where the owner's turn that message came from could.
    const partnerTurn = this.partner?.authority?.(admission);
    // Hard check: connections acting as the owner's personal identity only in the owner's private conversation,
    // in a turn the owner started. No partner turn is one.
    let blocked: string[] = [];
    if (apps?.ownerPrivate && !(await apps.ownerPrivate.admitted(admission))) {
      const ids = await apps.ownerPrivate.connections();
      blocked = connections.filter(id => !ids || ids.has(id));
      connections = connections.filter(id => !blocked.includes(id));
    }
    const scope = blocked.length ? { connections, ...(granted?.operations ? { operations: granted.operations } : {}) } : granted;
    const browser = (apps?.browser() ?? []).filter(id => connections.includes(id));
    // The owner can be asked in the owner's own turn, and for a partner turn that came from one. Schedules keep read-only tokens.
    const write = (admission.kind === "owner" || partnerTurn?.write === true) && !!this.approvals;
    const options = write ? { write: true } : undefined;
    const read = (value: z.infer<typeof connectedAppInput>) => options ? this.appReader!(value, scope, options)
      : scope ? this.appReader!(value, scope) : this.appReader!(value);
    const unavailable = blocked.map(connection => ({ connection, reason: OWNER_PRIVATE_ONLY }));
    if (input.action === "tools") {
      const catalog = blocked.length && !connections.length ? { status: "completed", tools: [] } : agentCatalog(await read(input), browser);
      if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return catalog;
      const listed = z.object({ status: z.literal("completed"), tools: z.array(z.object({ name: z.string() }).passthrough()) }).passthrough().safeParse(catalog);
      return { ...catalog, ...(unavailable.length ? { unavailableHere: unavailable } : {}),
        ...(listed.success ? apps?.guides?.(listed.data.tools.map(tool => tool.name)) : {}) };
    }
    const refused = blocked.find(id => input.name?.startsWith(`${id.replaceAll("-", "_")}__`));
    if (refused) return ownerPrivateRefusal(refused);
    const found = input.name ? browserTool(input.name, browser) : undefined;
    // Site permissions given "for this task" belong to the conversation of an owner's own turn. Other turns cannot
    // ask the owner about a site and carry no task, so they reach always-allowed sites only.
    const session = found && admission.kind === "owner" && !partnerTurn && apps?.sites
      ? this.store.get<{ sessionKey: string }>("business_turn_inputs", `${this.scope}:${call.runId}`)?.sessionKey : undefined;
    const task = session === undefined ? undefined : createHash("sha256").update(session).digest("hex");
    const commands = found?.tool === "agent_browser_read" || found?.tool === "agent_browser_write";
    let args = input.arguments ?? {};
    if (found) {
      // An upload names the current site for the owner's approval; it is read from the browser, not from the model.
      const currentUrl = async () => {
        const page = await read({ action: "call", name: browserToolName(found.connection, "agent_browser_read"), arguments: { args: ["get", "url"], ...(task ? { task } : {}) } });
        const output = z.object({ status: z.literal("completed"), result: z.object({ output: z.string() }) }).safeParse(page);
        return output.success ? output.data.result.output.trim() : undefined;
      };
      try { args = await prepareBrowser(found.tool, args, apps?.files, currentUrl); }
      catch (error) { if (error instanceof RelayError) return { status: "failed", error: error.message }; throw error; }
      if (commands && task) args = { ...args, task };
    }
    const outcome = await read({ ...input, arguments: args });
    const site = found?.tool === "agent_browser_read" ? siteRequired.safeParse(outcome) : undefined;
    if (site?.success) {
      if (!task) return siteUnavailableHere(site.data.detail.site);
      // The record comes first: a card without one would be a question nobody reads the answer to.
      this.store.insert("browser_site_requests", `${this.scope}:${call.runId}:${call.id}`, { status: "open", runId: call.runId, callId: call.id, deadlineAt: call.deadlineAt,
        owner: admission.owner, agentId: admission.agentId, connections, connection: found!.connection, site: site.data.detail.site, command: site.data.detail.command, task,
        name: input.name!, arguments: args, ...(scope ? { scope } : {}), write } satisfies SiteRequest);
      return WAITING;
    }
    return this.appResult(call, input.name ?? "", outcome, { owner: admission.owner, agentId: admission.agentId, connections }, write, partnerTurn?.approvals);
  }
  /** What a connected-app call comes to: a refusal where the owner cannot be asked, a wait for their approval, or its result. */
  private async appResult(call: Pick<HostCall, "runId" | "id" | "deadlineAt">, name: string, outcome: unknown, principal: { owner: string; agentId: string; connections: string[] },
    write: boolean, desk?: ApprovalDesk) {
    // The owner set this operation to ask, and this turn has no way to ask.
    const refusal = z.object({ status: z.literal("failed"), error: z.literal("connector_operation_requires_approval") }).passthrough().safeParse(outcome);
    if (refusal.success) return approvalUnavailableHere(refusal.data);
    const approval = approvalRequired.safeParse(outcome);
    if (approval.success) {
      if (!write || !this.approvals) return { status: "failed", error: "owner_approval_unavailable" };
      const requested = await this.approvals.request(call as HostCall, name, principal, approval.data, desk);
      return "result" in requested ? requested.result : WAITING;
    }
    return this.finishApp(call, name, outcome);
  }
  /**
   * Site cards of this run. A card is withdrawn when its call is gone or past its deadline. After a restart an answer
   * not yet acted on is taken up again, and a command that may already have run is reported as such, not repeated.
   */
  private async siteCards(runId: string, hostCalls: HostCall[]): Promise<HostCall[]> {
    const prefix = `${this.scope}:${runId}:`, cards: HostCall[] = [];
    for (const { id, value } of this.store.entriesByStatus<SiteRequest>("browser_site_requests", ["open", "decided", "running"])) {
      if (!id.startsWith(prefix)) continue;
      if (value.status !== "open") { void this.settleSite(id).catch(() => undefined); continue; }
      const live = hostCalls.some(call => call.id === value.callId && call.status === "pending");
      if (!live || Date.parse(value.deadlineAt) <= Date.now()) {
        if (this.decideSite(id, "deny")) await this.settleSite(id, "expired").catch(() => undefined);
        continue;
      }
      cards.push({ id: SITE_PREFIX + value.callId, runId, kind: "interaction", name: handoffMethod, status: "pending", deadlineAt: value.deadlineAt,
        input: siteCardInput(value.site, value.command) });
    }
    return cards;
  }
  private decideSite(id: string, choice: NonNullable<SiteRequest["choice"]>) {
    return this.store.transaction(() => {
      const current = this.store.get<SiteRequest>("browser_site_requests", id);
      if (current?.status !== "open") return false;
      this.store.set("browser_site_requests", id, { ...current, status: "decided", choice }); return true;
    });
  }
  /** The owner's choice on a site card. Anything but the two allowing choices, a typed line included, is a refusal. */
  private async answerSite(runId: string, callId: string, result: unknown) {
    const id = `${this.scope}:${runId}:${callId}`, record = this.store.get<SiteRequest>("browser_site_requests", id);
    if (!record || record.status !== "open") return;
    const answer = siteAnswer(result), choice = answer === SITE_CHOICES.task ? "task" : answer === SITE_CHOICES.always ? "always" : "deny";
    // A permission is recorded only for a command that still waits for it.
    const live = Date.parse(record.deadlineAt) > Date.now() && (await super.calls(runId)).some(call => call.id === callId && call.status === "pending");
    if (!this.decideSite(id, live ? choice : "deny")) return;
    // Recording the permission and running the command again happen outside Router's input handling.
    void this.settleSite(id, live ? undefined : "expired").catch(() => undefined);
    // Router routes the owner's next chat line to an open card; hand that text to the Agent instead of dropping it.
    if (answer && !Object.values(SITE_CHOICES).includes(answer as never)) await super.steer(runId, answer).catch(() => undefined);
  }
  private settleSite(id: string, reason?: string): Promise<void> {
    let work = this.siteWork.get(id);
    if (!work) {
      work = this.settleSiteOnce(id, reason).finally(() => this.siteWork.delete(id));
      this.siteWork.set(id, work);
    }
    return work;
  }
  private async settleSiteOnce(id: string, reason?: string) {
    const record = this.store.transaction(() => {
      const current = this.store.get<SiteRequest>("browser_site_requests", id);
      if (current?.status === "decided") this.store.set("browser_site_requests", id, { ...current, status: "running" });
      return current;
    });
    if (record?.status !== "decided" && record?.status !== "running") return;
    let value: unknown;
    try {
      if (record.status === "running") value = { isError: true, status: "uncertain", error: "business_call_outcome_unknown" };
      else if (record.choice === "deny" || !this.apps?.sites || !this.appReader) value = siteDenied(record.site, reason);
      else {
        await this.apps.sites.allowSite(record.owner, record.connection, record.site, record.choice === "task" ? record.task : undefined);
        const outcome = await this.appReader({ action: "call", name: record.name, arguments: record.arguments }, record.scope, record.write ? { write: true } : undefined);
        // The permission was recorded, so a second refusal for the site is not asked about again.
        value = siteRequired.safeParse(outcome).success ? siteDenied(record.site, "permission_not_recorded")
          : await this.appResult({ runId: record.runId, id: record.callId, deadlineAt: record.deadlineAt }, record.name, outcome, record, record.write);
      }
    } catch { value = { status: "failed", error: "connected_app_unavailable" }; }
    // The operation itself is set to ask: its approval card answers the call from here on.
    if (value !== WAITING) {
      const receiptKey = `${this.scope}:${record.runId}:${record.callId}`, receipt = this.store.get<{ hash: string }>("business_call_receipts", receiptKey);
      if (receipt) this.store.set("business_call_receipts", receiptKey, { hash: receipt.hash, result: value });
      await this.deliver(record.runId, record.callId, value, true);
    }
    this.store.set("browser_site_requests", id, { ...record, status: "closed" });
  }
  private async finishApp(call: Pick<HostCall, "runId" | "id">, name: string, outcome: unknown) {
    const found = browserTool(name, this.apps?.browser() ?? []);
    if (!found) return scrub(outcome);
    try {
      return await finishBrowser(found.tool, outcome, this.apps?.files, handoff => {
        const key = `${this.scope}:${call.runId}:${call.id}`;
        this.store.insert("browser_handoffs", key, { ...handoff, connection: found.connection, runId: call.runId, callId: call.id, status: "open" } satisfies Handoff);
      });
    } catch (error) {
      if (error instanceof RelayError) return { status: "failed", error: error.message };
      throw error;
    }
  }
  private handoffCards(runId: string): HostCall[] {
    const prefix = `${this.scope}:${runId}:`, cards: HostCall[] = [];
    for (const { id, value } of this.store.entriesByStatus<Handoff>("browser_handoffs", ["open"])) {
      if (!id.startsWith(prefix)) continue;
      if (Date.parse(value.expiresAt) <= Date.now()) { this.store.set("browser_handoffs", id, { ...value, status: "closed" }); continue; }
      cards.push({ id: HANDOFF_PREFIX + value.callId, runId, kind: "interaction", name: handoffMethod, status: "pending", deadlineAt: value.expiresAt,
        input: handoffCardInput(value, handoffCancel) });
    }
    return cards;
  }
  private async answerHandoff(runId: string, callId: string, result: unknown) {
    const key = `${this.scope}:${runId}:${callId}`, handoff = this.store.get<Handoff>("browser_handoffs", key);
    if (!handoff || handoff.status !== "open") return;
    this.store.set("browser_handoffs", key, { ...handoff, status: "closed" });
    const answer = z.object({ answers: z.object({ handoff: z.object({ answers: z.array(z.string()).min(1) }) }) }).safeParse(result).data?.answers.handoff.answers[0];
    if (answer !== handoffCancel) {
      // Router routes the owner's next chat line to an open card; hand that text to the Agent instead of dropping it.
      if (answer) await super.steer(runId, answer).catch(() => undefined);
      return;
    }
    await this.cancelHandoff(handoff).catch(() => undefined);
  }
  /** The owner's click on the trusted card is the decision; a connector approval for this exact cancel is granted. */
  private async cancelHandoff(handoff: Handoff) {
    const grant = this.store.get<{ admission?: RunAdmission }>("business_runs", `${this.scope}:${handoff.runId}`);
    const admission = this.admission(grant?.admission);
    if (!admission || admission.kind !== "owner" || !this.appReader) return;
    const name = browserToolName(handoff.connection, "handoff_cancel"), port = this.apps?.approvals;
    const outcome = await this.appReader({ action: "call", name, arguments: { handoffId: handoff.handoffId } },
      { connections: [handoff.connection] }, port ? { write: true } : undefined);
    const approval = approvalRequired.safeParse(outcome);
    if (!approval.success || !port) return;
    const view = await port.operation(approval.data.operationId);
    if (view?.status === "pending" && view.owner === admission.owner && view.agentId === admission.agentId && view.connectionId === handoff.connection &&
      view.tool === "handoff_cancel" && JSON.stringify(view.input) === JSON.stringify({ handoffId: handoff.handoffId }))
      await port.approve(admission.owner, view.id, view.digest);
  }
}
