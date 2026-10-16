import type { ReactNode } from "react";
import { ActivityRow } from "./activity.js";
import { Disclosure } from "./disclosure.js";
import type { HostEvent } from "./agent-host.js";

export interface ProcessTool {
  id: string;
  title: string;
  status: "running" | "completed" | "failed" | "interrupted";
  input?: unknown;
  output?: unknown;
}
export interface ProcessView { tools: ProcessTool[]; commentary: string[]; }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";

/** Host event projection for a caller-owned process surface. Original events remain with the caller.
 * Reuses OpenGrove's process grouping and activity disclosures without its room protocol.
 */
export function projectAgentProcess(events: readonly HostEvent[], active = false): ProcessView {
  const tools = new Map<string, ProcessTool>(), notes = new Map<string, string>();
  const phases = new Map<string, string>();
  for (const event of events) {
    const row = event as unknown as Record<string, unknown>;
    if (event.type === "native.notification") {
      const notification = object(row.notification), params = object(notification.params), item = object(params.item);
      const id = text(item.id) || text(params.itemId);
      if (item.phase) phases.set(id, text(item.phase));
      if (notification.method === "item/agentMessage/delta" && (params.phase ?? phases.get(id)) === "commentary")
        notes.set(id, (notes.get(id) ?? "") + text(params.delta));
      if (notification.method === "item/completed" && item.type === "agentMessage" && (item.phase ?? phases.get(id)) === "commentary")
        notes.set(id, text(item.text));
      if (notification.method === "item/commandExecution/outputDelta" && tools.has(id)) {
        const previous = tools.get(id)!;
        tools.set(id, { ...previous, output: text(previous.output) + text(params.delta) });
      }
    }
    if (!["native.tool", "tool.started", "tool.finished"].includes(event.type)) continue;
    const native = object(row.native), id = text(row.callId);
    // Events without a stable call ID must not be incorrectly merged with another call.
    const key = id || `event-${tools.size}`;
    const previous = tools.get(key);
    const finished = row.phase === "finished" || event.type === "tool.finished";
    const result = object(row.result);
    const failed = result.success === false || native.status === "failed" || (typeof native.exitCode === "number" && native.exitCode !== 0);
    tools.set(key, {
      id: key,
      title: text(row.tool) || text(native.command) || text(native.name) || text(native.type) || previous?.title || "Tool",
      status: finished ? failed ? "failed" : "completed" : "running",
      input: row.input ?? native.arguments ?? native.input ?? previous?.input ?? row.native,
      output: row.result ?? (finished ? row.native : previous?.output),
    });
  }
  return { tools: [...tools.values()].map((tool) => !active && tool.status === "running" ? { ...tool, status: "interrupted" } : tool),
    commentary: [...notes.values()].filter(Boolean) };
}

const defaultLabels = {
  process: "Execution process", running: "Running", completed: "Completed", failed: "Failed", interrupted: "Interrupted",
  input: "Input", output: "Output", empty: "Waiting for execution events",
};
export function AgentProcess({ events, active = false, labels: overrides, children }: {
  events: readonly HostEvent[];
  active?: boolean;
  labels?: Partial<typeof defaultLabels>;
  children?: ReactNode;
}) {
  const labels = { ...defaultLabels, ...overrides }, view = projectAgentProcess(events, active);
  return <Disclosure summary={`${labels.process} · ${view.tools.length}`} variant="process" defaultOpen={active} active={active}>
    {view.commentary.map((note, i) => <p key={i}>{note}</p>)}
    {view.tools.map((tool) => <ActivityRow key={tool.id} title={tool.title} status={tool.status}
      detail={{ label: labels[tool.status] }}
      fullDetail={`${labels.input}\n${JSON.stringify(tool.input ?? null, null, 2)}\n\n${labels.output}\n${JSON.stringify(tool.output ?? null, null, 2)}`} />)}
    {!view.tools.length && !view.commentary.length && active ? <p>{labels.empty}</p> : null}
    {children}
  </Disclosure>;
}
