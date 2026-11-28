/**
 * How much of its context a session had used when a run ended, in tokens, as its kernel reported it. Kernels report
 * different things: one the size of each request, one a running total beside the last request, one the occupancy
 * itself. This reads the size of the last model request of the run's own thread, which is what the next turn of the
 * session starts from. A sub-agent of the kernel works in a context of its own, which the next turn does not read:
 * what it reports is left out. `undefined`: the kernel reported nothing that says so (Hermes and OpenClaw report no
 * size in their events).
 */
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sum = (...values: unknown[]) => {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  return numbers.length ? numbers.reduce((total, value) => total + value, 0) : undefined;
};

/**
 * The context size one Host event states for the run's own thread, if it states one. A Host puts the events of a
 * kernel's sub-agents in the same run, and each kernel marks them in its own way. `thread`: the native thread the
 * run's session is bound to (`session.bound`), which tells a Codex thread from the threads it spawned.
 */
export function contextTokens(event: Record<string, unknown>, thread?: string): number | undefined {
  if (event.type !== "native.notification") return undefined;
  const notification = object(event.notification), params = object(notification.params), method = notification.method;
  // Codex: the usage of the last request, beside the thread's running total. Its input counts what was read from cache.
  // A spawned thread reports the same way, under its own thread id.
  if (method === "thread/tokenUsage/updated") {
    const from = typeof params.threadId === "string" ? params.threadId : event.threadId;
    return thread !== undefined && typeof from === "string" && from !== thread ? undefined : sum(object(object(params.tokenUsage).last).inputTokens);
  }
  // Claude: every assistant message carries the usage of the request that produced it; cached input is counted apart.
  // A message of a sub-agent names the tool call that started it.
  if (method === "claude.message" && params.type === "assistant") {
    if (typeof params.parent_tool_use_id === "string") return undefined;
    const usage = object(object(params.message).usage);
    return sum(usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens);
  }
  // ACP: `used` is the occupancy of the context window. OpenCode marks what a child session reports.
  if (method === "session/update" && object(params.update).sessionUpdate === "usage_update")
    return object(object(params.update)._meta)["opencode/child-session"] ? undefined : sum(object(params.update).used);
  // Pi: an assistant message ends with the usage of the request that produced it; cached input is counted apart.
  if (method === "pi/message_end") {
    const model = object(object(params.event).entry).model, assistant = Array.isArray(model) ? model.map(object).filter(message => message.role === "assistant").at(-1) : undefined;
    const usage = object(assistant?.usage);
    return sum(usage.input, usage.cacheRead, usage.cacheWrite);
  }
  return undefined;
}

/** The events of one run, as a Host serves them. */
export interface RunEvents { events(runId: string, after: number, limit?: number): Promise<{ events: Array<{ event: Record<string, unknown> }>; cursor: number; hasMore: boolean }> }

/** The context size after a run: what the last event of its own thread that states one says. */
export async function runContextTokens(host: RunEvents, runId: string): Promise<number | undefined> {
  let tokens: number | undefined, thread: string | undefined, after = 0;
  for (let pages = 0; pages < 40; pages++) {
    const page = await host.events(runId, after, 500);
    for (const { event } of page.events) {
      if (event.type === "session.bound" && typeof event.threadId === "string") thread = event.threadId;
      else tokens = contextTokens(event, thread) ?? tokens;
    }
    if (!page.hasMore || page.cursor === after) break;
    after = page.cursor;
  }
  return tokens;
}
