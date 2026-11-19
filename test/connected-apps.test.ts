import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { generateSigningKey } from "@olorinm/agent-connectors/issuer";
import { ConnectorReadClient } from "@olorinm/agent-connectors/read-client";
import { ConnectedApps } from "../src/connected-apps.js";
import { privateFile } from "../src/files.js";
import { DurableStore } from "../src/store.js";
const cleanup: Array<() => void> = [];
const memory = () => { const store = new DurableStore(":memory:", "fixture"); cleanup.push(() => store.close()); return store; };
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); });
it("binds app access to the assigned Agent, owner and connections on every request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mau-apps-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const key = await generateSigningKey("caller"), agentId = randomUUID();
  privateFile(join(directory, "caller.json"), key.privateJwk);
  const options = { url: "http://127.0.0.1:18100", issuer: "mau", audience: "connectors", callerKeyFile: "caller.json" };
  const client = new ConnectedApps(options, directory, memory()), assignment = { agentId, owner: "alice", connections: ["alice-gmail"] };
  client.assign("alice", agentId, ["alice-gmail", "alice-gmail"]);
  // Another owner and an Agent without an assignment reach nothing.
  for (const reader of [client.reader(agentId, "bob")!, client.reader(randomUUID(), "alice")!])
    expect(await reader({ action: "tools" })).toEqual({ status: "failed", error: "connected_app_not_granted" });
  expect(client.connections(agentId, "bob")).toEqual([]);
  expect(client.assigned("bob", "alice-gmail")).toEqual([]); expect(client.assigned("alice", "alice-gmail")).toEqual([agentId]);
  const list = vi.spyOn(ConnectorReadClient.prototype, "tools").mockResolvedValue([]);
  const call = vi.spyOn(ConnectorReadClient.prototype, "call").mockResolvedValue({ status: "completed" });
  await client.reader(agentId, "alice")!({ action: "tools" });
  expect(list).toHaveBeenCalledWith(assignment);
  await client.reader(agentId, "alice")!({ action: "call", name: "alice_gmail__list", arguments: { maxResults: 1 } });
  expect(call).toHaveBeenCalledWith(assignment, "alice_gmail__list", { maxResults: 1 });
  list.mockResolvedValue([{ name: "alice_gmail__list", description: "List", inputSchema: { type: "object" } }, { name: "alice_gmail__read", description: "Read", inputSchema: { type: "object" } }]);
  const scope = { connections: ["alice-gmail", "someone-elses-account"], operations: ["alice_gmail__list"] };
  expect(await client.reader(agentId, "alice")!({ action: "tools" }, scope)).toMatchObject({ tools: [{ name: "alice_gmail__list" }] });
  expect(list).toHaveBeenLastCalledWith(assignment);
  call.mockClear();
  expect(await client.reader(agentId, "alice")!({ action: "call", name: "alice_gmail__read" }, scope)).toMatchObject({ error: "connected_app_operation_not_granted" });
  expect(await client.reader(agentId, "alice")!({ action: "call", name: "alice_gmail__list" }, { connections: ["foreign"] })).toMatchObject({ error: "connected_app_not_granted" });
  expect(call).not.toHaveBeenCalled();
  // Without the connector service configured there is nothing to read with.
  expect(new ConnectedApps(undefined, directory, memory()).reader(agentId, "alice")).toBeUndefined();
});
it("uses the assignment the owner set last, without a new reader, and forgets a removed one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mau-apps-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const key = await generateSigningKey("caller"), agentId = randomUUID();
  privateFile(join(directory, "caller.json"), key.privateJwk);
  const apps = new ConnectedApps({ url: "http://127.0.0.1:18100", issuer: "mau", audience: "connectors", callerKeyFile: "caller.json", browserConnections: ["alice-browser"] }, directory, memory());
  const list = vi.spyOn(ConnectorReadClient.prototype, "tools").mockResolvedValue([]);
  const reader = apps.reader(agentId, "alice")!;
  expect(await reader({ action: "tools" })).toMatchObject({ error: "connected_app_not_granted" });
  apps.assign("alice", agentId, ["alice-gmail"]);
  expect(await reader({ action: "tools" })).toMatchObject({ status: "completed" });
  expect(list).toHaveBeenLastCalledWith({ agentId, owner: "alice", connections: ["alice-gmail"] });
  apps.assign("alice", agentId, ["alice-browser"]);
  await reader({ action: "tools" });
  expect(list).toHaveBeenLastCalledWith({ agentId, owner: "alice", connections: ["alice-browser"] });
  expect(apps.browser(agentId, "alice")).toEqual(["alice-browser"]); expect(apps.configured("alice", "alice-gmail")).toEqual([]);
  apps.assign("alice", agentId, []);
  expect(await reader({ action: "tools" })).toMatchObject({ error: "connected_app_not_granted" });
  expect(apps.connections(agentId, "alice")).toEqual([]); expect(apps.assigned("alice", "alice-browser")).toEqual([]);
});
it("a partner in a shared environment uses the connections of the partner that has it, under its own Agent ID", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mau-apps-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const key = await generateSigningKey("caller"), holder = randomUUID(), sharer = randomUUID(), configured = randomUUID(), foreign = randomUUID();
  privateFile(join(directory, "caller.json"), key.privateJwk);
  const options = { url: "http://127.0.0.1:18100", issuer: "mau", audience: "connectors", callerKeyFile: "caller.json",
    browserConnections: ["alice-browser"] };
  const store = memory(), assign = (apps: ConnectedApps) => {
    apps.assign("alice", holder, ["alice-gmail", "alice-browser", "alice-feishu"]); apps.assign("alice", configured, ["alice-gmail"]);
  };
  // `foreign` stands for a record that names the partner from another account; sharing is only created within one owner.
  const sharing = { sharedFrom: (agentId: string) => [sharer, configured, foreign].includes(agentId) ? holder : undefined,
    sharedBy: (agentId: string) => agentId === holder ? [sharer, configured] : [] };
  const apps = new ConnectedApps(options, directory, store, false, sharing);
  assign(apps);
  expect(apps.inheritedFrom(sharer, "alice")).toBe(holder);
  expect(apps.inheritedFrom(configured, "alice")).toBeUndefined(); expect(apps.inheritedFrom(holder, "alice")).toBeUndefined();
  expect(apps.inheritedFrom(foreign, "bob")).toBeUndefined();
  expect(apps.connections(sharer, "alice")).toEqual(["alice-gmail", "alice-browser", "alice-feishu"]);
  expect(apps.browser(sharer, "alice")).toEqual(["alice-browser"]);
  // An assignment of its own is used as written, and another owner's partner gets nothing.
  expect(apps.connections(configured, "alice")).toEqual(["alice-gmail"]);
  expect(apps.connections(foreign, "bob")).toEqual([]);
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
  const alone = new ConnectedApps(options, directory, store);
  expect(alone.connections(sharer, "alice")).toEqual([]); expect(alone.assigned("alice", "alice-browser")).toEqual([holder]);
});
