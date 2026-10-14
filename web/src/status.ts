import type { ProductStatusTone } from "@olorinm/agent-ui/app";
import type { EnvironmentAction, EnvironmentState, EnvironmentView } from "./api/client";

const tones: Record<EnvironmentState, ProductStatusTone> = {
  unconfigured: "neutral",
  creating: "running",
  starting: "running",
  ready: "success",
  pausing: "running",
  paused: "neutral",
  sleeping: "neutral",
  resuming: "running",
  deleting: "running",
  deleted: "neutral",
  needs_action: "error",
};
export const stateTone = (view: EnvironmentView | null): ProductStatusTone =>
  view?.busy ? "running" : tones[view?.state ?? "unconfigured"];

/** Lifecycle actions offered for a settled state; Mau still validates each request. */
export function availableActions(view: EnvironmentView | null): EnvironmentAction[] {
  if (!view || view.busy) return [];
  switch (view.state) {
    case "ready": return ["pause"];
    case "sleeping": return ["resume", "pause"];
    case "paused": return ["resume"];
    case "needs_action": return ["reconcile"];
    default: return [];
  }
}
export const canDestroy = (view: EnvironmentView | null) =>
  !!view && !view.busy && !["unconfigured", "deleted", "creating", "deleting"].includes(view.state);
