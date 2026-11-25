import type { HostEvent, HostInteraction } from "./agent-host.js";
import type { JsonValue, MessagePart, ToolPart } from "./message-parts.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const json = (value: unknown) => value as JsonValue | undefined;

/** The service adapter translates Host events into display records. UI components
 * consume these records without knowing the Host, transport, or native event stream.
 * Native inputs/results are retained; native call IDs are never replaced by tool names.
 * Parts keep event order: text spoken between tool calls stays in the process as
 * commentary, and only the final answer becomes answer text (OpenGrove room order).
 */
/** Codex dynamic tool results: text items, with JSON text read as the value it encodes. */
function contentItems(value: unknown): unknown {
  if (!Array.isArray(value) || !value.length) return undefined;
  const items = value.map((item) => {
    const entry = record(item), body = typeof entry.text === "string" ? entry.text : undefined;
    if (body === undefined) return item;
    try { return JSON.parse(body) as unknown; } catch { return body; }
  });
  return items.length === 1 ? items[0] : items;
}

// Claude's MCP bridge and the Host can assign different IDs to the same invocation.
function callSignature(name: string, input: JsonValue): string {
  return JSON.stringify([name, input], (_, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}

export function projectHostMessage(events: readonly HostEvent[], options: { active?: boolean; answer?: string; detailsLabel?: string;
  /** What a refused tool call says: the caller's sentence for the error code its result carries, or nothing to keep the row as it is. */
  describeError?(code: string, toolId: string): string | undefined } = {}): MessagePart[] {
  const parts = new Map<string, MessagePart>();
  const phases = new Map<string, string>();
  const calls = new Map<string, ToolPart>();
  const hostCalls = new Set<string>();
  const bridgeCalls = new Map<string, string>();
  let reasoning = "", reasoningTail = "", anonymous = 0, segment = 0, pending = "", rootThread = "";
  // Deltas are live-only; a completed reasoning item replaces the fragments streamed for it.
  const showReasoning = () => {
    const value = [reasoning, reasoningTail].filter(Boolean).join("\n\n");
    if (value) parts.set("reasoning", { id: "reasoning", type: "reasoning", reasoningId: "reasoning", kernelId: "",
      kind: "summary", text: value, status: options.active ? "running" : "complete", redacted: false });
  };
  // Codex reports each agent message as a native item with a phase; prefer those over
  // the aggregated text stream so commentary is not repeated inside the answer.
  const nativeMessages = events.some(event => {
    const item = record(record(record((event as unknown as Record<string, unknown>).notification).params).item);
    return event.type === "native.notification" && item.type === "agentMessage";
  });
  const commentary = (key: string, value: string) => parts.set(key, { id: key, type: "note", tone: "diagnostic",
    text: value, data: { kind: "agent_message", phase: "commentary" } });
  // Text streamed before a tool call is the agent narrating its work, not the answer.
  const flushPending = () => {
    if (!pending.trim()) { pending = ""; return; }
    commentary(`commentary:text-${segment++}`, pending); pending = "";
  };
  for (const event of events) {
    const row = event as unknown as Record<string, unknown>;
    if (!nativeMessages && event.type === "assistant.delta") pending += event.text ?? "";
    if (!nativeMessages && event.type === "model.response" && segment === 0) pending = event.text ?? pending;
    if (event.type === "reasoning.delta") {
      reasoningTail += event.text ?? "";
      showReasoning();
    }
    if (event.type === "native.notification") {
      const notification = record(row.notification), params = record(notification.params), item = record(params.item);
      const thread = text(params.threadId) || text(row.threadId);
      rootThread ||= thread;
      // Subagent threads are summarized by their parent's activity rows.
      if (thread && thread !== rootThread) continue;
      const id = text(item.id) || text(params.itemId);
      if (notification.method === "item/completed" && item.type === "reasoning") {
        const lines = (value: unknown) => Array.isArray(value) ? value.map(text).filter(Boolean).join("\n\n") : "";
        const value = lines(item.summary) || lines(item.content);
        if (value) { reasoning = [reasoning, value].filter(Boolean).join("\n\n"); reasoningTail = ""; showReasoning(); }
      }
      if (id && item.phase) phases.set(id, text(item.phase));
      const phase = text(params.phase) || text(item.phase) || phases.get(id);
      const delta = notification.method === "item/agentMessage/delta";
      const complete = notification.method === "item/completed" && item.type === "agentMessage";
      if (id && (delta || complete)) {
        const key = phase === "commentary" ? `commentary:${id}` : `answer:${id}`, previous = parts.get(key);
        const value = delta ? (previous && previous.type !== "tool" && "text" in previous ? previous.text : "") + text(params.delta) : text(item.text);
        if (phase === "commentary") commentary(key, value);
        else if (value) parts.set(key, { id: key, type: "text", text: value });
      }
      if (id && notification.method === "item/commandExecution/outputDelta") {
        const call = calls.get(id);
        if (call) {
          const input = record(call.input);
          call.input = json({ ...input, aggregatedOutput: text(input.aggregatedOutput) + text(params.delta) });
        }
      }
      // Native multi-agent items only arrive as notifications; show them as activity rows.
      if (id && ["subAgentActivity", "collabAgentToolCall"].includes(text(item.type)) &&
          ["item/started", "item/completed"].includes(text(notification.method))) {
        const finished = notification.method === "item/completed";
        const previous = calls.get(id);
        const call: ToolPart = previous ? { ...previous, input: json(item) } : {
          id: `${id}:call`, type: "tool", phase: "call", toolId: text(item.type), callId: id, title: text(item.type),
          input: json(item), status: "running", error: "", approvalId: "", approvalStatus: "", approvalReason: "",
          questionId: "", questionStatus: "", questionPrompt: "" };
        const failed = text(item.status) === "failed";
        if (finished) call.status = failed ? "error" : "complete";
        calls.set(id, call); parts.set(call.id, call);
        if (finished) parts.set(`${id}:result`, { ...call, id: `${id}:result`, phase: "result", result: json(item) });
      }
    }
    if (!["native.tool", "tool.started", "tool.finished"].includes(event.type)) continue;
    flushPending();
    const native = record(row.native);
    const callId = text(row.callId) || text(native.id) || text(native.toolCallId) || text(native.tool_use_id);
    const key = callId || `anonymous:${anonymous++}`;
    const previous = calls.get(key);
    const finished = row.phase === "finished" || event.type === "tool.finished";
    const result = record(row.result);
    const failed = result.success === false || result.ok === false || result.isError === true || result.is_error === true || native.isError === true || native.is_error === true || native.success === false ||
      native.status === "failed" || (typeof native.exitCode === "number" && native.exitCode !== 0);
    const nativeName = text(native.name) || text(native.toolName) || text(native.title) || text(native.type);
    const toolId = text(row.tool) || previous?.toolId || nativeName || "tool";
    if (event.type === "tool.started") hostCalls.add(key);
    if (event.type === "native.tool" && native.type === "tool_use" && toolId.startsWith("mcp__agent_host__")) {
      bridgeCalls.set(key, toolId.slice("mcp__agent_host__".length));
    }
    // Keep the structured native item so original command/search/edit presenters can
    // show meaningful summaries, diff lines and results instead of an opaque JSON list.
    const input = row.input ?? (
      ["commandExecution", "fileChange", "webSearch"].includes(text(native.type)) ? native :
      native.arguments ?? native.input ?? native.rawInput ?? native.args ?? previous?.input ?? row.native);
    const output = row.result ?? native.result ?? native.output ?? native.rawOutput ?? native.content ?? contentItems(native.contentItems) ?? (finished ? row.native : undefined);
    // A product tool's refusal is a code inside its answer; only the caller knows what to say for it.
    const reported = text(native.error) || text(result.error);
    const code = reported || text(record(contentItems(result.contentItems ?? native.contentItems)).error);
    const error = failed ? (code && options.describeError?.(code, toolId)) || reported : "";
    // An ACP agent says what kind of call this is and which files it is about; a title alone need not name either.
    const paths = text(native.sessionUpdate) && Array.isArray(native.locations) ? native.locations.flatMap(place => text(record(place).path) || []) : [];
    const said = { ...(text(native.sessionUpdate) && text(native.kind) ? { kind: text(native.kind) } : previous?.kind ? { kind: previous.kind } : {}),
      ...(paths.length ? { paths } : previous?.paths ? { paths: previous.paths } : {}) };
    const base: ToolPart = {
      id: `${key}:call`, type: "tool", phase: "call", toolId, callId: key, ...said,
      title: toolId, input: json(input), status: "running", error: "", approvalId: "", approvalStatus: "",
      approvalReason: "", questionId: "", questionStatus: "", questionPrompt: "",
    };
    if (!finished) {
      const call = previous ? { ...previous, ...said, input: json(input ?? previous.input), toolId, title: toolId } : base;
      if (native.partialResult !== undefined) call.result = json(native.partialResult);
      calls.set(key, call); parts.set(call.id, call);
    } else {
      if (previous) previous.status = failed ? "error" : "complete";
      parts.set(`${key}:result`, { ...base, id: `${key}:result`, phase: "result", input: previous?.input ?? json(input),
        result: json(output), status: failed ? "error" : "complete", error });
    }
  }
  if (bridgeCalls.size && hostCalls.size) {
    // Consume one Host record per matching bridge record. A failed delivery without a Host
    // counterpart must survive even if another call used exactly the same arguments.
    const reports = new Map<string, ToolPart[]>();
    for (const id of hostCalls) {
      const call = calls.get(id);
      if (!call || call.input === undefined) continue;
      const key = callSignature(call.toolId, call.input);
      const entries = reports.get(key);
      if (entries) entries.push(call);
      else reports.set(key, [call]);
    }
    for (const [id, name] of bridgeCalls) {
      const call = calls.get(id);
      if (!call || call.input === undefined || hostCalls.has(id)) continue;
      const matches = reports.get(callSignature(name, call.input));
      if (!matches?.length) continue;
      let index = matches.findIndex(report => report.status === call.status);
      // A Host answer can reach the console before the bridge finishes the same call.
      if (index < 0 && call.status === "running" && matches.length === 1) index = 0;
      if (index >= 0) {
        matches.splice(index, 1);
        parts.delete(call.id);
        parts.delete(`${id}:result`);
      }
    }
  }
  if (!options.active) for (const part of parts.values()) {
    if (part.type === "tool" && part.status === "running") part.status = "interrupted";
  }
  for (const part of parts.values()) {
    if (part.type !== "tool") continue;
    const result = parts.get(part.id.replace(/:call$/, ":result"));
    const output = part.phase === "result" ? part.result : result?.type === "tool" ? result.result : part.result ?? record(part.input).aggregatedOutput;
    part.detail = {label: options.detailsLabel ?? "Details", text: JSON.stringify({input: part.input ?? null, output: output ?? null}, null, 2)};
  }
  const answered = [...parts.values()].some(part => part.type === "text");
  // A running Codex turn has no answer until its final_answer item; the aggregated text
  // would repeat commentary. Finished runs may still fall back to the stored answer.
  const finalAnswer = answered || (nativeMessages && options.active) ? "" : options.answer ?? pending;
  if (finalAnswer) parts.set("answer", { id: "answer", type: "text", text: finalAnswer });
  return [...parts.values()];
}

/** Host request semantics remain in Host. These fields only control original UI cards. */
export function projectHostInteraction(id: string, request: HostInteraction, options: {status?: string; disabledReason?: string; result?: unknown} = {}): ToolPart | undefined {
  if (request.kind !== "approval" && request.kind !== "questions") return undefined;
  const status = options.status ?? "pending";
  // The kernel names the step it asks about: Codex's item, Claude's tool use, ACP's tool call.
  const asked = record(record(request.native).params);
  const step = text(asked.itemId) || text(asked.toolUseID) || text(record(asked.toolCall).toolCallId);
  return {
    id: `interaction:${id}`, type: "tool", phase: request.kind === "approval" ? "approval" : "question",
    toolId: "interaction", ...(step ? { callId: step } : {}), title: request.title, status, error: "",
    input: json(request.native), result: json(options.result),
    approvalId: request.kind === "approval" ? id : "", approvalStatus: status, approvalReason: request.title,
    approvalInput: json(request.permissions ?? request.native),
    questionId: request.kind === "questions" ? id : "", questionStatus: status, questionPrompt: request.title,
    questionInput: json({questions: request.questions}),
    interaction: {
      disabledReason: options.disabledReason, allowSkip: false,
      choices: request.choices?.map(choice => ({id: choice.id, label: choice.label, description: choice.scope, primary: choice.allows && choice.scope === "once"})),
      questions: request.questions?.map(question => ({id: question.id, title: question.title, multiSelect: question.multiple, secret: question.secret,
        options: (question.options ?? []).map(option => ({...option, value: option.label}))})),
    },
  };
}

/**
 * Adds a request's part to a run's parts. A waiting request, and any question, stands after them. An approval
 * that is over belongs to the step it was about, whose row says how it ended; without that step it is a step of
 * its own, before the answer.
 */
export function placeHostInteraction(parts: MessagePart[], part: ToolPart): void {
  if (part.phase !== "approval" || part.approvalStatus === "pending") { parts.push(part); return; }
  const steps = parts.filter((step): step is ToolPart => step.type === "tool" && (step.phase === "call" || step.phase === "result") && !!step.callId && step.callId === part.callId);
  if (steps.length) { for (const step of steps) step.approvalStatus = part.approvalStatus; return; }
  parts.splice(parts.at(-1)?.type === "text" ? parts.length - 1 : parts.length, 0, part);
}
