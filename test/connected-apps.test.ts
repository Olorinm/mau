import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { generateSigningKey } from "@olorinm/agent-connectors/issuer";
import { ConnectorReadClient } from "@olorinm/agent-connectors/read-client";
import { ConnectedApps } from "../src/connected-apps.js";
import { privateFile } from "../src/files.js";
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); });
it("binds app access to the configured Agent, owner and connections on every request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mau-apps-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const key = await generateSigningKey("caller"), agentId = randomUUID();
  privateFile(join(directory, "caller.json"), key.privateJwk);
  const options = { url: "http://127.0.0.1:18100", issuer: "mau", audience: "connectors", callerKeyFile: "caller.json",
    assignments: [{ agentId, owner: "alice", connections: ["alice-gmail"] }] };
  const client = new ConnectedApps(options, directory);
  expect(client.reader(agentId, "bob")).toBeUndefined(); expect(client.reader(randomUUID(), "alice")).toBeUndefined();
  expect(client.assigned("bob", "alice-gmail")).toEqual([]); expect(client.assigned("alice", "alice-gmail")).toEqual([agentId]);
  const list = vi.spyOn(ConnectorReadClient.prototype, "tools").mockResolvedValue([]);
  const call = vi.spyOn(ConnectorReadClient.prototype, "call").mockResolvedValue({ status: "completed" });
  await client.reader(agentId, "alice")!({ action: "tools" });
  expect(list).toHaveBeenCalledWith(options.assignments[0]);
  await client.reader(agentId, "alice")!({ action: "call", name: "alice_gmail__list", arguments: { maxResults: 1 } });
  expect(call).toHaveBeenCalledWith(options.assignments[0], "alice_gmail__list", { maxResults: 1 });
  list.mockResolvedValue([{ name: "alice_gmail__list", description: "List", inputSchema: { type: "object" } }, { name: "alice_gmail__read", description: "Read", inputSchema: { type: "object" } }]);
  const scope = { connections: ["alice-gmail", "someone-elses-account"], operations: ["alice_gmail__list"] };
  expect(await client.reader(agentId, "alice")!({ action: "tools" }, scope)).toMatchObject({ tools: [{ name: "alice_gmail__list" }] });
  expect(list).toHaveBeenLastCalledWith(options.assignments[0]);
  call.mockClear();
  expect(await client.reader(agentId, "alice")!({ action: "call", name: "alice_gmail__read" }, scope)).toMatchObject({ error: "connected_app_operation_not_granted" });
  expect(await client.reader(agentId, "alice")!({ action: "call", name: "alice_gmail__list" }, { connections: ["foreign"] })).toMatchObject({ error: "connected_app_not_granted" });
  expect(call).not.toHaveBeenCalled();
  expect(() => new ConnectedApps({ ...options, assignments: [...options.assignments, ...options.assignments] }, directory)).toThrow("duplicate_connected_app_agent");
});
it("a partner in a shared environment uses the connections of the partner that has it, under its own Agent ID", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mau-apps-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const key = await generateSigningKey("caller"), holder = randomUUID(), sharer = randomUUID(), configured = randomUUID(), foreign = randomUUID();
  privateFile(join(directory, "caller.json"), key.privateJwk);
  const options = { url: "http://127.0.0.1:18100", issuer: "mau", audience: "connectors", callerKeyFile: "caller.json",
    browserConnections: ["alice-browser"],
    assignments: [{ agentId: holder, owner: "alice", connections: ["alice-gmail", "alice-browser", "alice-feishu"] },
      { agentId: configured, owner: "alice", connections: ["alice-gmail"] }] };
  // `foreign` stands for a record that names the partner from another account; sharing is only created within one owner.
  const sharing = { sharedFrom: (agentId: string) => [sharer, configured, foreign].includes(agentId) ? holder : undefined,
    sharedBy: (agentId: string) => agentId === holder ? [sharer, configured] : [] };
  const apps = new ConnectedApps(options, directory, false, sharing);
  expect(apps.connections(sharer, "alice")).toEqual(["alice-gmail", "alice-browser", "alice-feishu"]);
  expect(apps.browser(sharer, "alice")).toEqual(["alice-browser"]);
  // An assignment of its own is used as written, and another owner's partner gets nothing.
  expect(apps.connections(configured, "alice")).toEqual(["alice-gmail"]);
  expect(apps.connections(foreign, "bob")).toEqual([]); expect(apps.reader(foreign, "bob")).toBeUndefined();
  expect(apps.connections(randomUUID(), "alice")).toEqual([]);
  expect(apps.assigned("alice", "alice-browser")).toEqual([holder, sharer]);
  expect(apps.assigned("alice", "alice-gmail")).toEqual([holder, sharer, configured]);
  expect(apps.configured("alice", "alice-browser")).toEqual([holder]);
  expect(apps.assigned("bob", "alice-gmail")).toEqual([]);
  // The connector service sees the sharing partner itself, so its operations and approvals stay its own.
  const list = vi.spyOn(ConnectorReadClient.prototype, "tools").mockResolvedValue([]);
  const call = vi.spyOn(ConnectorReadClient.prototype, "call").mockResolvedValue({ status: "completed" });
  await apps.reader(sharer, "alice")!({ action: "tools" });
  expect(list).toHaveBeenCalledWith({ agentId: sharer, owner: "alice", connections: ["alice-gmail", "alice-browser", "alice-feishu"] });
  await apps.reader(sharer, "alice")!({ action: "call", name: "alice_gmail__list" }, { connections: ["alice-gmail", "elsewhere"] });
  expect(call).toHaveBeenCalledWith({ agentId: sharer, owner: "alice", connections: ["alice-gmail"] }, "alice_gmail__list", {});
  // Without sharing, only the configured Agents have connections.
  const alone = new ConnectedApps(options, directory);
  expect(alone.reader(sharer, "alice")).toBeUndefined(); expect(alone.assigned("alice", "alice-browser")).toEqual([holder]);
});
