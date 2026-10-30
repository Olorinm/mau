import { expect, it, vi } from "vitest";
import type { ConnectedApps } from "../src/connected-apps.js";
import type { ProactiveRule } from "../src/proactive.js";
import { checkConnector } from "../src/connector-precheck.js";

it("checks only scoped reads, hashes data without metadata, and rejects failed or unknown results", async () => {
  const reader = vi.fn().mockResolvedValue({ status: "completed", operationId: "one", result: { a: 1, b: [2] } });
  const apps = { reader: () => reader } as unknown as ConnectedApps;
  const rule = { owner: "alice", agentId: "agent", connections: ["mail"], operations: ["mail_search"],
    precheck: { connectionId: "mail", tool: "mail_search", arguments: { q: "in:inbox" } } } as ProactiveRule;
  const first = await checkConnector(apps, rule, {}); expect(first.changed).toBe(true);
  expect(reader).toHaveBeenCalledWith({ action: "call", name: "mail_search", arguments: { q: "in:inbox" } }, { connections: ["mail"], operations: ["mail_search"] });
  reader.mockResolvedValue({ status: "completed", operationId: "two", result: { b: [2], a: 1 } });
  expect((await checkConnector(apps, rule, { previous: first.checkpoint })).changed).toBe(false);
  reader.mockResolvedValue({ status: "failed", error: "expired" });
  await expect(checkConnector(apps, rule, { previous: first.checkpoint })).rejects.toThrow();
  await expect(checkConnector(apps, { ...rule, connections: [] }, {})).rejects.toThrow("precheck_not_granted");
  await expect(checkConnector(apps, { ...rule, operations: ["mail__connection_status"],
    precheck: { ...rule.precheck!, tool: "mail__connection_status" } }, {})).rejects.toThrow("precheck_business_read_required");
});
