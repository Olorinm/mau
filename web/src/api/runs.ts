import type { CommunicationTask, RunObservation } from "@agent-router/server";
import { createRunView, appendRunEvent, type HostEvent, type RunView } from "@olorinm/agent-ui/agent-host";
import { ApiError, request } from "./http";

export type { CommunicationTask };
export type RunDetail = Awaited<ReturnType<RunObservation["run"]>>;
type EventPage = Awaited<ReturnType<RunObservation["events"]>>;
const root = (agentId: string) => `/_agent-router/v1/agents/${encodeURIComponent(agentId)}/communication`;
export function runApi(token: string, agentId: string) {
  const base = root(agentId), run = (claimId: string) => base + "/runs/" + encodeURIComponent(claimId);
  return {
    tasks: (target: string, signal?: AbortSignal) => request<{ data: CommunicationTask[]; next: string | null }>(
      base + "/tasks?" + new URLSearchParams({ connectionId: "matrix", target, limit: "100" }), { token, ...(signal ? { signal } : {}) }),
    run: (claimId: string, signal?: AbortSignal) => request<RunDetail>(run(claimId), { token, ...(signal ? { signal } : {}) }),
    events: (claimId: string, after: number, signal?: AbortSignal) => request<EventPage>(run(claimId) + "/events?" + new URLSearchParams({ after: String(after), limit: "200" }), { token, ...(signal ? { signal } : {}) }),
    answer: (claimId: string, callId: string, result: unknown) => request(run(claimId) + "/calls/" + encodeURIComponent(callId) + "/result", { token, body: { result } }),
    cancel: (taskId: string) => request(base + "/tasks/" + encodeURIComponent(taskId) + "/cancel", { token, body: {} }),
  };
}

/** In-memory cursor cache only; a refresh reconstructs it from the public Host history through Router. */
export class RunReader {
  private view: RunView | undefined;
  private truncated = false;
  private terminalDetail: RunDetail | undefined;
  constructor(private api: ReturnType<typeof runApi>, private claimId: string) {}
  async refresh(signal?: AbortSignal) {
    const terminalBeforeRead = this.terminalDetail;
    const [detail, page] = await Promise.all([
      terminalBeforeRead ?? this.api.run(this.claimId, signal),
      this.api.events(this.claimId, this.view?.sequence ?? 0, signal),
    ]);
    signal?.throwIfAborted();
    let view = this.view ?? createRunView(detail.run.id);
    if (page.historyTruncated) { this.truncated = true; view = createRunView(detail.run.id); }
    for (const item of page.events) {
      if (typeof item.event.type !== "string" || item.event.runId !== detail.run.id || !Number.isSafeInteger(item.sequence) || item.sequence <= 0)
        throw new ApiError("invalid_response", 200);
      view = appendRunEvent(view, { sequence: item.sequence, event: item.event as unknown as HostEvent });
    }
    if (!Number.isSafeInteger(page.cursor) || page.cursor < view.sequence || (page.hasMore && page.cursor === view.sequence && !page.events.length)) throw new ApiError("invalid_response", 200);
    view = { ...view, sequence: page.cursor };
    this.view = view;
    if (detail.run.status !== "running") this.terminalDetail = detail;
    // Publish every page immediately. If completion raced the parallel event read,
    // drain once more after observing the terminal status so final events cannot be lost.
    const more = page.hasMore || (!!this.terminalDetail && !terminalBeforeRead);
    return { detail, view, truncated: this.truncated, more };
  }
}
