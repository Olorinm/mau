import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ScheduledMemoryContext } from "./employee-context.js";
import { z } from "zod";
import { HttpAgentHost, RouterError, type HostPort, type ServiceHttp, type HostTool, type HostCall } from "@agent-router/server";
import { BusinessDataClient, businessDataTools, businessDataOptionsSchema } from "@olorinm/agent-connectors/business-data";
import { FeishuBotReader, feishuBotReaderSchema } from "@olorinm/agent-connectors/feishu-bot-reader";
import { CloudflareReadClient, cloudflareReadSchema } from "@olorinm/agent-connectors/cloudflare-read-client";
import { DurableStore } from "./store.js";
import { ConnectedApps, connectedAppDefinition, connectedAppInput, type ConnectedAppReader } from "./connected-apps.js";
import { validAdmission, type RunAdmission, type AdmissionValidator } from "./run-admission.js";

export const businessToolsSchema = z.array(z.union([businessDataOptionsSchema.extend({
  agentId: z.uuid(), owner: z.string().min(1), feishu: feishuBotReaderSchema.optional(),
}).strict(), cloudflareReadSchema])).max(100).default([]);
const inputSchema = z.object({ tool: z.enum([...businessDataTools.filter(t => t !== "sql"), "tools"]), arguments: z.record(z.string(), z.unknown()) }).strict();
const definition = { name: "business_data", timeoutMs: 90_000,
  description: "Read permitted business data through a server-side connector. Start with tool=tools and arguments={} to see the exact schemas of permitted operations, then catalog for source grants and schema for tables. Available operations: catalog, schema, rows, novel_chapters, novel_production, outline_novel, script_content. The catalog describes each operation's arguments and source grants. No write operations are allowed. Credentials are managed by Mau; never look for keys or internal endpoints in the sandbox.",
  inputSchema: z.toJSONSchema(inputSchema) };

/** Compose trusted tools with Host's native dynamic-tool protocol; no credential goes to Host. */
const feishuInput = z.object({ args: z.array(z.string().max(100_000)).min(1).max(100) }).strict();
const feishuDefinition = { name: "feishu_bot_read", timeoutMs: 90_000,
  description: "Read Feishu resources using the existing bot's permissions through the server-side official CLI. Start with args=[\"skills\",\"read\",\"lark-shared\"] and the relevant domain skill, or args=[\"--help\"]. Inspect a command with args=[\"schema\",\"drive files list\"]. Avoid the full schema catalog. Pass args without the executable, --as, --profile, shell syntax or local paths. Writes are refused. Sending replies/files in the current conversation uses the separate channel tool.",
  inputSchema: z.toJSONSchema(feishuInput) };
type BusinessClient = Pick<BusinessDataClient, "call"> & { feishu?: Pick<FeishuBotReader, "read"> };
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
  private readonly clients = new Map<string, { owner: string; client: BusinessClient }>();
  private admissionValidator?: AdmissionValidator;
  private employeeTools?: (agentId: string, owner: string) => EmployeeTools;
  private completed?: (input: CompletedEmployeeTurn) => void;
  constructor(options: z.input<typeof businessToolsSchema>, base: string, private readonly store: DurableStore, private readonly apps?: ConnectedApps) {
    for (const entry of businessToolsSchema.parse(options)) {
      const {agentId, owner} = entry;
      if (this.clients.has(agentId)) throw new Error("duplicate_business_tool_agent");
      if ("mode" in entry) {
        const client = new CloudflareReadClient({...entry, tokenFile: resolve(base, entry.tokenFile)});
        this.clients.set(agentId, {owner, client: {call: (name, input) => client.call(name, input), feishu: {read: args => client.read(args)}}});
        continue;
      }
      const {feishu, agentId: _agentId, owner: _owner, ...option} = entry;
      const data = new BusinessDataClient({ ...option, tokenFile: resolve(base, option.tokenFile) });
      this.clients.set(agentId, { owner, client: { call: (name, input) => data.call(name, input),
        ...(feishu ? { feishu: new FeishuBotReader({ ...feishu, appSecretFile: resolve(base, feishu.appSecretFile), directory: resolve(base, feishu.directory) }) } : {}) } });
    }
  }
  inventory(owner: string) {
    return [...this.clients].filter(([, entry]) => entry.owner === owner).map(([agentId, entry]) => ({
      agentId, kind: "business-data" as const, status: "configured" as const,
      tools: businessDataTools.filter(name => name !== "sql"), feishuBotRead: !!entry.client.feishu,
      permission: "read-only" as const,
    }));
  }
  async check(owner: string, agentId: string) {
    const entry = this.clients.get(agentId);
    if (!entry || entry.owner !== owner) throw new Error("business_tool_not_authorized");
    const result = await entry.client.call("tools", {}) as { isError?: boolean; content?: unknown } | undefined;
    if (!result || result.isError !== false || !Array.isArray(result.content)) throw new Error("connector_check_failed");
    return { status: "verified" as const, checkedAt: new Date().toISOString() };
  }
  setAdmissionValidator(validate: AdmissionValidator) { this.admissionValidator = validate; }
  setEmployeeTools(provider: (agentId: string, owner: string) => EmployeeTools) { this.employeeTools = provider; }
  onCompleted(callback: (input: CompletedEmployeeTurn) => void) { this.completed = callback; }
  host(agentId: string, owner: string, binding: string, http: ServiceHttp): HostPort {
    const entry = this.clients.get(agentId);
    const client = entry?.owner === owner ? entry.client : undefined, appReader = this.apps?.reader(agentId, owner);
    const employee = this.employeeTools?.(agentId, owner);
    if (!client && !appReader && !employee) return new HttpAgentHost(http);
    return new BusinessHost(http, client, this.store, `${agentId}:${binding}`, appReader,
      { agentId, owner, validate: admission => this.admissionValidator?.(admission) ?? true }, employee, this.completed);
  }
}
export interface CompletedEmployeeTurn { admission: RunAdmission; runId: string; sessionId: string; sessionKey: string; input: string; inputRole?: "user" | "tool"; answer: string; }
export class BusinessHost extends HttpAgentHost {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(http: ServiceHttp, private readonly client: BusinessClient | undefined,
    private readonly store: DurableStore, private readonly scope: string, private readonly appReader?: ConnectedAppReader,
    private readonly principal?: { agentId: string; owner: string; validate?: AdmissionValidator }, private readonly employee?: EmployeeTools,
    private readonly completed?: (input: CompletedEmployeeTurn) => void) { super(http); }
  override async start(input: Parameters<HostPort["start"]>[0] & { admission?: RunAdmission }) {
    const { admission: supplied, ...request } = input;
    const admission = this.admission(supplied);
    if (supplied && !admission) throw new RouterError("business_run_admission_invalid", 403);
    const requestId = input.requestKey ? `${this.scope}:${input.runtimeId}:${input.requestKey}` : undefined;
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const sessionKey = `${this.scope}:${input.sessionId}`;
    const prepare = () => {
      const granted = (kind: "business" | "feishu" | "connectedApps") => admission &&
        (admission.kind === "owner" && !admission.toolGrants || Boolean(admission.toolGrants?.[kind]));
      const proposed = [...(granted("business") && this.client ? [definition] : []),
        ...(granted("feishu") && this.client?.feishu ? [feishuDefinition] : []),
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
    return [definition, feishuDefinition, connectedAppDefinition, ...(this.employee?.definitions ?? [])].some(tool => sameTool(tool, call));
  }
  override async calls(id: string): ReturnType<HostPort["calls"]> {
    const calls = await super.calls(id);
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
            const admission = this.admission(grant?.admission);
            if (!grant || !admission || call.runId !== id || !Number.isFinite(Date.parse(call.deadlineAt)) || Date.parse(call.deadlineAt) <= Date.now()) throw new Error("business_tool_not_authorized");
            const productTool = this.employee?.definitions.some(d => sameTool(d, call));
            const kind = call.name === connectedAppDefinition.name ? "connectedApps" : call.name === feishuDefinition.name ? "feishu" : "business";
            if (productTool ? admission.kind === "schedule" : !(admission.kind === "owner" && !admission.toolGrants) && !admission.toolGrants?.[kind]) throw new Error("business_tool_not_authorized");
            if (!productTool && (kind === "connectedApps" ? !this.appReader : kind === "feishu" ? !this.client?.feishu : !this.client)) throw new Error("business_tool_not_authorized");
            const receiptKey = `${grantKey}:${call.id}`;
            const hash = createHash("sha256").update(JSON.stringify([call.namespace ?? null, call.name, call.input])).digest("hex");
            const prior = this.store.get<{ hash: string; result?: unknown }>("business_call_receipts", receiptKey);
            if (prior) {
              if (prior.hash !== hash) throw new Error("business_call_changed");
              result = prior.result ?? { isError: true, status: "uncertain", error: "business_call_outcome_unknown" };
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
              result = admission.toolGrants?.connectedApps ? await this.appReader(parsed.data, admission.toolGrants.connectedApps) : await this.appReader(parsed.data);
            } else if (call.name === feishuDefinition.name) {
              const parsed = feishuInput.safeParse(call.input);
              if (!this.client?.feishu || !parsed.success) throw new Error("invalid_business_arguments");
              result = await this.client.feishu.read(parsed.data.args);
            } else {
              const parsed = inputSchema.safeParse(call.input);
              if (!this.client || !parsed.success) throw new Error("invalid_business_arguments");
              result = await this.client.call(parsed.data.tool, parsed.data.arguments);
            }
            this.store.set("business_call_receipts", receiptKey, { hash, result });
            }
          } catch (error) {
            const dependencyErrors = ["work_dependency_capacity_exhausted", "work_dependency_same_session", "work_dependency_run_not_active", "work_dependency_run_not_current", "work_dependency_context_mismatch", "work_dependency_wait_in_progress", "work_dependency_wait_unsupported", "invalid_dependency_wait_context"];
            result = { isError: true, error: error instanceof Error && ["business_tool_not_authorized", "business_call_changed", "business_tool_budget_exhausted", "invalid_business_arguments", "feishu_write_requires_owner_approval", "proactive_owner_admission_required", "steer_owner_admission_required", ...dependencyErrors].includes(error.message)
              ? error.message : call.name === connectedAppDefinition.name ? "connected_app_unavailable" : call.name === feishuDefinition.name ? "feishu_read_unavailable" : this.employee?.definitions.some(d => d.name === call.name) ? "employee_tool_unavailable" : "business_data_unavailable",
              ...(error instanceof Error && error.message === "work_dependency_capacity_exhausted" ? { instruction: "The fixed execution capacity is full. Finish this turn and inspect the existing event later; do not create a replacement task." } : {}) };
          }
          let text = JSON.stringify(result);
          if (text.length > 1_000_000) text = JSON.stringify({ isError: true, error: "business_result_too_large", instruction: "Narrow the query." });
          await super.resolve(id, call.id, { success: !(result as any)?.isError && !["failed", "uncertain"].includes((result as any)?.status),
            contentItems: [{ type: "inputText", text }] });
        })().finally(() => this.pending.delete(pendingKey));
        this.pending.set(pendingKey, operation);
      }
      await operation;
    }
    return calls.filter(call => !this.ownsCall(call) || call.kind !== "tool");
  }
}
