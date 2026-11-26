/**
 * How much of its context a session had used when a run ended, in tokens, as its kernel reported it. Kernels report
 * different things: one the size of each request, one a running total beside the last request, one the occupancy
 * itself. This reads the size of the last model request of the run, which is what the next turn of the session starts
 * from. `undefined`: the kernel reported nothing that says so.
 */
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sum = (...values: unknown[]) => {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  return numbers.length ? numbers.reduce((total, value) => total + value, 0) : undefined;
};

/** The context size one Host event states, if it states one. */
export function contextTokens(event: Record<string, unknown>): number | undefined {
  if (event.type !== "native.notification") return undefined;
  const notification = object(event.notification), params = object(notification.params), method = notification.method;
  // Codex: the usage of the last request, beside the thread's running total. Its input counts what was read from cache.
  if (method === "thread/tokenUsage/updated") return sum(object(object(params.tokenUsage).last).inputTokens);
  // Claude: every assistant message carries the usage of the request that produced it; cached input is counted apart.
  if (method === "claude.message" && params.type === "assistant") {
    const usage = object(object(params.message).usage);
    return sum(usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens);
  }
  // ACP: `used` is the occupancy of the context window.
  if (method === "session/update" && object(params.update).sessionUpdate === "usage_update") return sum(object(params.update).used);
  return undefined;
}

/** The events of one run, as a Host serves them. */
export interface RunEvents { events(runId: string, after: number, limit?: number): Promise<{ events: Array<{ event: Record<string, unknown> }>; cursor: number; hasMore: boolean }> }

/** The context size after a run: what its last event that states one says. */
export async function runContextTokens(host: RunEvents, runId: string): Promise<number | undefined> {
  let tokens: number | undefined, after = 0;
  for (let pages = 0; pages < 40; pages++) {
    const page = await host.events(runId, after, 500);
    for (const { event } of page.events) tokens = contextTokens(event) ?? tokens;
    if (!page.hasMore || page.cursor === after) break;
    after = page.cursor;
  }
  return tokens;
}
