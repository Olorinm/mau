import { createHash } from "node:crypto";
import { z } from "zod";
import type { ConnectedApps } from "./connected-apps.js";
import type { ProactiveRule } from "./proactive.js";

const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

/** Compare a specific read result. This does not claim to detect changes outside that query. */
export async function checkConnector(apps: ConnectedApps, rule: ProactiveRule, input: { previous?: string }) {
  const check = rule.precheck;
  if (!check || !rule.connections.includes(check.connectionId) || rule.operations && !rule.operations.includes(check.tool))
    throw new Error("precheck_not_granted");
  // Account-status reads encode an authorization/network failure inside a
  // successful result envelope. They are not a business-data change source.
  if (check.tool.endsWith("__connection_status")) throw new Error("precheck_business_read_required");
  const reader = apps.reader(rule.agentId, rule.owner);
  if (!reader) throw new Error("precheck_unavailable");
  const response = z.object({ status: z.literal("completed"), result: z.unknown() }).passthrough().parse(
    await reader({ action: "call", name: check.tool, arguments: check.arguments }, { connections: [check.connectionId], operations: [check.tool] }));
  if (response.result === undefined) throw new Error("precheck_result_missing");
  const checkpoint = createHash("sha256").update(stable(response.result)).digest("hex");
  return { changed: checkpoint !== input.previous, checkpoint };
}
