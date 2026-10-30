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
export function projectHostMessage(events: readonly HostEvent[], options: { active?: boolean; answer?: string; detailsLabel?: string } = {}): MessagePart[] {
  const parts = new Map<string, MessagePart>();
  const phases = new Map<string, string>();
  const calls = new Map<string, ToolPart>();
  let reasoning = "", anonymous = 0, segment = 0, pending = "", rootThread = "";
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
      reasoning += event.text ?? "";
      parts.set("reasoning", { id: "reasoning", type: "reasoning", reasoningId: "reasoning", kernelId: "",
        kind: "summary", text: reasoning, status: options.active ? "running" : "complete", redacted: false });
    }
    if (event.type === "native.notification") {
      const notification = record(row.notification), params = record(notification.params), item = record(params.item);
      const thread = text(params.threadId) || text(row.threadId);
      rootThread ||= thread;
      // Subagent threads are summarized by their parent's activity rows.
      if (thread && thread !== rootThread) continue;
      const id = text(item.id) || text(params.itemId);
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
    const failed = result.success === false || result.ok === false || result.isError === true || result.is_error === true || native.isError === true || native.is_error === true ||
      native.status === "failed" || (typeof native.exitCode === "number" && native.exitCode !== 0);
    const nativeName = text(native.name) || text(native.toolName) || text(native.title) || text(native.type);
    const toolId = text(row.tool) || previous?.toolId || nativeName || "tool";
    // Keep the structured native item so original command/search/edit presenters can
    // show meaningful summaries, diff lines and results instead of an opaque JSON list.
    const input = row.input ?? (
      ["commandExecution", "fileChange", "webSearch"].includes(text(native.type)) ? native :
      native.arguments ?? native.input ?? native.rawInput ?? native.args ?? previous?.input ?? row.native);
    const output = row.result ?? native.result ?? native.output ?? native.rawOutput ?? native.content ?? (finished ? row.native : undefined);
    const base: ToolPart = {
      id: `${key}:call`, type: "tool", phase: "call", toolId, callId: key,
      title: toolId, input: json(input), status: "running", error: "", approvalId: "", approvalStatus: "",
      approvalReason: "", questionId: "", questionStatus: "", questionPrompt: "",
    };
    if (!finished) {
      const call = previous ? { ...previous, input: json(input ?? previous.input), toolId, title: toolId } : base;
      if (native.partialResult !== undefined) call.result = json(native.partialResult);
      calls.set(key, call); parts.set(call.id, call);
    } else {
      if (previous) previous.status = failed ? "error" : "complete";
      parts.set(`${key}:result`, { ...base, id: `${key}:result`, phase: "result", input: previous?.input ?? json(input),
        result: json(output), status: failed ? "error" : "complete", error: failed ? text(native.error) || text(result.error) : "" });
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
  return {
    id: `interaction:${id}`, type: "tool", phase: request.kind === "approval" ? "approval" : "question",
    toolId: "interaction", title: request.title, status, error: "",
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
