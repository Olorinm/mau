import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ScheduledMemoryContext } from "./employee-context.js";
import { z } from "zod";
import { HttpAgentHost, RouterError, type HostPort, type ServiceHttp, type HostTool, type HostCall } from "@agent-router/server";
import { FeishuBotReader, feishuBotReaderSchema } from "@olorinm/agent-connectors/feishu-bot-reader";
import { CloudflareReadClient, cloudflareReadSchema } from "@olorinm/agent-connectors/cloudflare-read-client";
import { DurableStore } from "./store.js";
import { ConnectedApps, connectedAppDefinition, connectedAppInput, browserToolName, type ConnectedAppReader } from "./connected-apps.js";
import { APPROVAL_PREFIX, ConnectorApprovals, type ApprovalPort } from "./connector-approvals.js";
import { IMAGE_ITEMS, RelayError, agentCatalog, browserTool, finishBrowser, readUpload, scrub, type Handoff, type SandboxFiles } from "./browser-relay.js";
import { validAdmission, type RunAdmission, type AdmissionValidator } from "./run-admission.js";

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
const removedTools = new Set(["business_data"]);
const sameTool = (definition: Pick<HostTool, "name" | "namespace">, call: HostCall) =>
  definition.name === call.name && (definition.namespace ?? null) === (call.namespace ?? null);
export interface EmployeeTools {
  definitions: NonNullable<Parameters<HostPort["start"]>[0]["tools"]>;
  context(admission: RunAdmission, input: string, sessionKey?: string): unknown;
  scheduledContext?(admission: RunAdmission): ScheduledMemoryContext | undefined;
  reminders?(admission: RunAdmission, sessionId: string): string;
  execute(name: string, input: unknown, admission: RunAdmission, callId: string, runId: string): Promise<unknown>;
}
export class BusinessTools {
  private readonly readers = new Map<string, { owner: string; reader: BotReader }>();
  private admissionValidator?: AdmissionValidator;
  private employeeTools?: (agentId: string, owner: string) => EmployeeTools;
  private completed?: (input: CompletedEmployeeTurn) => void;
  private approvals?: ApprovalPort;
  private files?: (agentId: string, binding: string) => Promise<SandboxFiles>;
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
  setEmployeeTools(provider: (agentId: string, owner: string) => EmployeeTools) { this.employeeTools = provider; }
  onCompleted(callback: (input: CompletedEmployeeTurn) => void) { this.completed = callback; }
  /** Only a component holding the authority key may present connector writes; without it every caller stays read-only. */
  setApprovals(port: ApprovalPort) { this.approvals = port; }
  setSandboxFiles(files: (agentId: string, binding: string) => Promise<SandboxFiles>) { this.files = files; }
  private skills?: (agentId: string, owner: string, binding: string) => Promise<unknown>;
  /** Connector guides and CLI commands are brought into the environment before a run starts. */
  setSkills(sync: (agentId: string, owner: string, binding: string) => Promise<unknown>) { this.skills = sync; }
  host(agentId: string, owner: string, binding: string, http: ServiceHttp): HostPort {
    const entry = this.readers.get(agentId);
    const bot = entry?.owner === owner ? entry.reader : undefined, appReader = this.apps?.reader(agentId, owner);
    const employee = this.employeeTools?.(agentId, owner);
    if (!bot && !appReader && !employee) return new HttpAgentHost(http);
    const files = this.files, skills = this.skills;
    const host = new BusinessHost(http, bot, this.store, `${agentId}:${binding}`, appReader,
      { agentId, owner, validate: admission => this.admissionValidator?.(admission) ?? true }, employee, this.completed,
      appReader ? { connections: this.apps!.connections(agentId, owner), browser: this.apps!.browser(agentId, owner),
        ...(this.approvals && this.apps!.writable ? { approvals: this.approvals } : {}),
        ...(files ? { files: () => files(agentId, binding) } : {}) } : undefined);
    if (appReader && skills) host.beforeStart = () => skills(agentId, owner, binding);
    return host;
  }
}
export interface CompletedEmployeeTurn { admission: RunAdmission; runId: string; sessionId: string; sessionKey: string; input: string; inputRole?: "user" | "tool"; answer: string; }
/** Product-side extras for connected apps: owner write approvals and the browser workspace relay. */
export interface ConnectedAppHosting {
  connections: string[];
  browser: string[];
  approvals?: ApprovalPort;
  files?: () => Promise<SandboxFiles>;
}
const WAITING = Symbol("approval_waiting");
const HANDOFF_PREFIX = "mau-handoff:";
const handoffCancel = "取消接管";
// A structured single-choice question both Router's chat cards and the web console render with buttons.
const handoffMethod = "item/tool/requestUserInput";
const approvalRequired = z.object({ status: z.literal("approval_required"), operationId: z.string().min(1).max(64),
  expiresAt: z.string().optional() }).passthrough();
export class BusinessHost extends HttpAgentHost {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly approvals?: ConnectorApprovals;
  beforeStart?: () => Promise<unknown>;
  constructor(http: ServiceHttp, private readonly bot: BotReader | undefined,
    private readonly store: DurableStore, private readonly scope: string, private readonly appReader?: ConnectedAppReader,
    private readonly principal?: { agentId: string; owner: string; validate?: AdmissionValidator }, private readonly employee?: EmployeeTools,
    private readonly completed?: (input: CompletedEmployeeTurn) => void, private readonly apps?: ConnectedAppHosting) {
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
    const prepare = () => {
      const granted = (kind: "feishu" | "connectedApps") => admission &&
        (admission.kind === "owner" && !admission.toolGrants || Boolean(admission.toolGrants?.[kind]));
      const proposed = [...(granted("feishu") && this.bot ? [feishuDefinition] : []),
        ...(granted("connectedApps") && this.appReader ? [connectedAppDefinition] : []),
        ...(admission && admission.kind !== "schedule" ? this.employee?.definitions ?? [] : [])];
      const added = this.store.get<typeof proposed>("business_session_catalog", sessionKey) ?? proposed;
      const priorInstructions = this.store.get<string>("business_session_instructions", sessionKey);
      const snapshot = priorInstructions === undefined && admission ? this.employee?.context(admission, input.input, sessionKey) : undefined;
      const memory = snapshot && typeof snapshot === "object" && "text" in snapshot && typeof snapshot.text === "string" ? snapshot.text : "";
      // Frozen native instructions survive writes, restarts and forks. A scheduled
      // turn in an existing conversation retains that conversation's original snapshot.
      const instructions = priorInstructions ?? (memory ? `${request.instructions}\n\n${memory}` : request.instructions);
      // Admission is consumed here; native model input cannot grant itself access.
      const reminder = admission?.kind === "owner" ? this.employee?.reminders?.(admission, input.sessionId) : undefined;
      const scheduledMemory = admission?.kind === "schedule" ? this.employee?.scheduledContext?.(admission) : undefined;
      let toolOutput = request.toolOutput;
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
        ...(reminder || memoryContext ? { context: { requestContext: request.context ?? null,
          ...(reminder ? { memoryMaintenanceReminder: reminder } : {}), ...(memoryContext ? { scheduledMemory: memoryContext } : {}) } } : {}) };
      return { hash, request: forwarded, sessionKey, added,
        ...(admission ? { admission } : {}) };
    };
    let selected = requestId ? this.store.get<ReturnType<typeof prepare>>("business_run_requests", requestId) : undefined;
    if (selected && selected.hash !== hash) throw new RouterError("business_run_request_conflict", 409);
    if (!selected) {
      selected = prepare();
      if (requestId && !this.store.insert("business_run_requests", requestId, selected)) {
        selected = this.store.get<ReturnType<typeof prepare>>("business_run_requests", requestId)!;
        if (selected.hash !== hash) throw new RouterError("business_run_request_conflict", 409);
      }
    }
    this.store.set("business_session_instructions", sessionKey, selected.request.instructions);
    const run = await super.start(selected.request);
    this.store.set("business_session_catalog", sessionKey, selected.added);
    this.saveGrant(run.id, selected.admission);
    this.store.set("business_turn_inputs", `${this.scope}:${run.id}`, { sessionKey, sessionId: input.sessionId,
      input: input.toolOutput ? JSON.stringify(input.toolOutput) : input.input, inputRole: input.toolOutput ? "tool" : "user" });
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
          input: pending.request.toolOutput ? JSON.stringify(pending.request.toolOutput) : pending.request.input, inputRole: pending.request.toolOutput ? "tool" : "user" });
        this.saveGrant(run.id, pending.admission);
        this.observeCompleted(run);
      }
    }
    return run;
  }
  override async get(id: string) {
    const run = await super.get(id); this.observeCompleted(run); return run;
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
      [feishuDefinition, connectedAppDefinition, ...(this.employee?.definitions ?? [])].some(tool => sameTool(tool, call));
  }
  override async calls(id: string): ReturnType<HostPort["calls"]> {
    // Synthetic IDs belong to Mau. A sandbox Host listing one could put its own text on Mau's approval.
    const calls = (await super.calls(id)).filter(call => !call.id.startsWith(APPROVAL_PREFIX) && !call.id.startsWith(HANDOFF_PREFIX));
    for (const call of calls) {
      if (!this.ownsCall(call) || call.kind !== "tool" || call.status !== "pending") continue;
      const pendingKey = `${id}:${call.id}`;
      let operation = this.pending.get(pendingKey);
      if (!operation) {
        operation = (async () => {
          const grantKey = `${this.scope}:${id}`;
          const grant = this.store.get<{ admission?: RunAdmission; count: number }>("business_runs", grantKey);
          let result: unknown;
          try {
            if (removedTools.has(call.name) && !call.namespace) throw new Error("tool_removed");
            const admission = this.admission(grant?.admission);
            if (!grant || !admission || call.runId !== id || !Number.isFinite(Date.parse(call.deadlineAt)) || Date.parse(call.deadlineAt) <= Date.now()) throw new Error("business_tool_not_authorized");
            const productTool = this.employee?.definitions.some(d => sameTool(d, call));
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
            } else {
            if (grant.count >= (admission.maxToolCalls ?? 1000)) throw new Error("business_tool_budget_exhausted");
            this.store.transaction(() => {
              this.store.set("business_runs", grantKey, { ...grant, count: grant.count + 1 });
              this.store.set("business_call_receipts", receiptKey, { hash });
            });
            if (productTool) {
              result = await this.employee!.execute(call.name, call.input, admission, call.id, id);
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
            const dependencyErrors = ["work_dependency_capacity_exhausted", "work_dependency_same_session", "work_dependency_run_not_active", "work_dependency_run_not_current", "work_dependency_context_mismatch", "work_dependency_wait_in_progress", "work_dependency_wait_unsupported", "invalid_dependency_wait_context"];
            result = { isError: true, error: error instanceof Error && ["tool_removed", "business_tool_not_authorized", "business_call_changed", "business_tool_budget_exhausted", "invalid_business_arguments", "feishu_write_requires_owner_approval", "proactive_owner_admission_required", "steer_owner_admission_required", ...dependencyErrors].includes(error.message)
              ? error.message : call.name === connectedAppDefinition.name ? "connected_app_unavailable" : this.employee?.definitions.some(d => d.name === call.name) ? "employee_tool_unavailable" : "feishu_read_unavailable",
              ...(error instanceof Error && error.message === "work_dependency_capacity_exhausted" ? { instruction: "The fixed execution capacity is full. Finish this turn and inspect the existing event later; do not create a replacement task." } : {}) };
          }
          // A write awaiting the owner keeps its Host call pending; the approval card resolves it.
          if (result !== WAITING) await this.deliver(id, call.id, result);
        })().finally(() => this.pending.delete(pendingKey));
        this.pending.set(pendingKey, operation);
      }
      await operation;
    }
    const cards = [...await this.approvals?.synthetic(id, calls) ?? [], ...this.handoffCards(id)];
    return [...calls.filter(call => !this.ownsCall(call) || call.kind !== "tool"), ...cards];
  }
  /** Synthetic IDs are answered here and never forwarded to Host. */
  override async resolve(id: string, callId: string, result: unknown) {
    if (callId.startsWith(APPROVAL_PREFIX)) {
      if (!this.approvals) throw new RouterError("approval_not_found", 404);
      return this.approvals.decide(id, callId, result);
    }
    if (callId.startsWith(HANDOFF_PREFIX)) return this.answerHandoff(id, callId.slice(HANDOFF_PREFIX.length), result);
    return super.resolve(id, callId, result);
  }
  /** Test and shutdown hook: wait for decided approvals of a run to reach Host. */
  async settled(runId: string) { await this.approvals?.waitFor(runId); }
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
    const scope = admission.toolGrants?.connectedApps, apps = this.apps;
    const connections = (apps?.connections ?? []).filter(id => !scope || scope.connections.includes(id));
    const browser = (apps?.browser ?? []).filter(id => connections.includes(id));
    // Only the owner's own conversation can approve; schedules and delegations keep read-only tokens.
    const write = admission.kind === "owner" && !!this.approvals;
    const options = write ? { write: true } : undefined;
    const read = (value: z.infer<typeof connectedAppInput>) => options ? this.appReader!(value, scope, options)
      : scope ? this.appReader!(value, scope) : this.appReader!(value);
    if (input.action === "tools") return agentCatalog(await read(input), browser);
    const found = input.name ? browserTool(input.name, browser) : undefined;
    let args = input.arguments ?? {};
    if (found?.tool === "upload") {
      if (!apps?.files) return { status: "failed", error: "browser_workspace_unavailable" };
      try { args = await readUpload(await apps.files(), args); }
      catch (error) { if (error instanceof RelayError) return { status: "failed", error: error.message }; throw error; }
    }
    const outcome = await read({ ...input, arguments: args });
    const approval = approvalRequired.safeParse(outcome);
    if (approval.success) {
      if (!write || !this.approvals) return { status: "failed", error: "owner_approval_unavailable" };
      const requested = await this.approvals.request(call, input.name!, { owner: admission.owner, agentId: admission.agentId, connections }, approval.data);
      return "result" in requested ? requested.result : WAITING;
    }
    return this.finishApp(call, input.name ?? "", outcome);
  }
  private async finishApp(call: Pick<HostCall, "runId" | "id">, name: string, outcome: unknown) {
    const found = browserTool(name, this.apps?.browser ?? []);
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
        input: { questions: [{ id: "handoff", question: `浏览器已交给你接管（${value.expiresAt} 前有效）。请在此私密链接中操作，不要转发：\n${value.liveViewUrl}\n完成后直接回到对话告诉 Agent。`,
          options: [{ label: handoffCancel }] }] } });
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
