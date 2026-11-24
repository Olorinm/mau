import { resolve } from "node:path";
import { z } from "zod";
import { ConnectorReadClient, readClientSchema } from "@olorinm/agent-connectors/read-client";
import { ConnectorCallerClient } from "./connector-client.js";
import type { DurableStore } from "./store.js";

const connectionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
export const connectedAppsSchema = readClientSchema.extend({
  /** Employee mode uses explicit assignments, including for partners sharing an environment. */
  authorization: z.enum(["run", "employee"]).optional(),
  /** Connections served by the browser connector; Mau relays their files through the Agent's workspace. */
  browserConnections: z.array(connectionId).max(64).default([]),
  /** Connections acting as the owner's personal identity, in addition to those the service reports as `owner_private`. */
  ownerPrivateConnections: z.array(connectionId).max(64).default([]) }).strict().optional();
/** What the owner sets for one partner: the connections it can use. An empty list removes the partner's own assignment. */
export const connectorAssignmentInput = z.object({ connections: z.array(connectionId).max(64) }).strict();
export const connectedAppInput = z.object({ action: z.enum(["tools", "call"]), name: z.string().max(64).optional(),
  arguments: z.record(z.string(), z.unknown()).optional() }).strict();
export const connectedAppDefinition = { name: "connected_apps", timeoutMs: 600_000,
  // What to do about a refused call (a write the owner declined, a missing authorization, a personal connection used
  // outside the owner's private conversation) is said by that call's own result, in its instruction.
  description: "Use the owner's authorized apps through Mau. Call action=tools for the available operations and their input schemas, then action=call with name and arguments. Reads run directly. An operation marked risk=write asks the owner to approve on a card; this call waits for the decision and returns the outcome. The card appears in the owner's conversation with you, or, when you are handling a partner's message, in the conversation that message was sent from. Scheduled work can only read. Connections that act as the owner's personal identity work only in a turn the owner started in the owner's private conversation with you; elsewhere tools lists them under unavailableHere. Credentials stay in Mau: do not look for them or for endpoints in the sandbox.",
  inputSchema: z.toJSONSchema(connectedAppInput) };
export const employeeAppDefinition = { ...connectedAppDefinition,
  description: "Use the connections assigned to this employee. List tools with action=tools, then call one with its name and arguments. The connector applies the owner's allow, ask or deny setting before execution. Requests for approval wait for the owner's decision. If declined, report the result. Credentials stay with the connector." };
interface ConnectedAppScope { connections: string[]; operations?: string[] | undefined; }
/** `write` is set only by Mau for owner admissions; model arguments never select it. */
interface ConnectedAppOptions { write?: boolean; }
export type ConnectedAppReader = (input: z.infer<typeof connectedAppInput>, scope?: ConnectedAppScope, options?: ConnectedAppOptions) => Promise<unknown>;
export const browserToolName = (connection: string, tool: string) => `${connection.replaceAll("-", "_")}__${tool}`;
/** Which partners run in another partner's environment. Such a partner has no assignment of its own by default. */
export interface EnvironmentSharing {
  sharedFrom(agentId: string): string | undefined;
  sharedBy(agentId: string): string[];
}
interface Assignment { owner: string; connections: string[] }
const assignments = "connector_assignments";
/**
 * Which connections each partner can use. The owner sets them through the API; they are stored (one document per
 * Agent ID, removed with the partner's other records) and read on every use, so a change needs no restart.
 */
export class ConnectedApps {
  private readonly client?: ConnectorReadClient;
  private readonly caller?: ConnectorCallerClient;
  constructor(private readonly config: z.infer<typeof connectedAppsSchema>, base: string, private readonly store: DurableStore,
    writable = false, private readonly sharing?: EnvironmentSharing) {
    if (!config) return;
    const { authorization: _authorization, browserConnections: _browser, ownerPrivateConnections: _private, ...endpoint } = config;
    this.client = new ConnectorReadClient({ ...endpoint, callerKeyFile: resolve(base, config.callerKeyFile) });
    // Without an approval presenter (authority key), write-capable tokens are never minted.
    if (writable) this.caller = new ConnectorCallerClient({ ...endpoint, callerKeyFile: resolve(base, config.callerKeyFile) });
  }
  get employeePermissions() { return this.config?.authorization === "employee"; }
  sharedEmployee(agentId: string) { return this.employeePermissions && this.sharing?.sharedFrom(agentId) !== undefined; }
  get writable() { return !!this.caller; }
  get ownerPrivateConnections() { return [...(this.config?.ownerPrivateConnections ?? [])]; }
  private own(agentId: string, owner: string) {
    const found = this.store.get<Assignment>(assignments, agentId);
    return found?.owner === owner ? found : undefined;
  }
  /** Replace the Agent's own assignment; an empty list removes it. */
  assign(owner: string, agentId: string, connections: string[]) {
    if (connections.length) this.store.set(assignments, agentId, { owner, connections: [...new Set(connections)] } satisfies Assignment);
    else this.store.delete(assignments, agentId);
  }
  /** The partner whose connections the Agent uses: it has no assignment of its own and runs in that partner's environment. */
  inheritedFrom(agentId: string, owner: string): string | undefined {
    if (this.employeePermissions || this.store.get<Assignment>(assignments, agentId)) return undefined;
    const sharedFrom = this.sharing?.sharedFrom(agentId);
    return sharedFrom !== undefined && this.own(sharedFrom, owner) ? sharedFrom : undefined;
  }
  /**
   * The Agent's own assignment. A partner in a shared environment without one uses the connections of the partner
   * whose environment it runs in (same owner), under its own Agent ID.
   */
  private principal(agentId: string, owner: string) {
    const source = this.own(this.inheritedFrom(agentId, owner) ?? agentId, owner);
    return source && { agentId, owner, connections: source.connections };
  }
  /** The Agents whose own assignment names the connection. */
  configured(owner: string, connection: string) {
    return this.store.entries<Assignment>(assignments).filter(a => a.value.owner === owner && a.value.connections.includes(connection)).map(a => a.id);
  }
  /** Every Agent that can use the connection: the configured ones and the partners using their connections. */
  assigned(owner: string, connection: string) {
    if (this.employeePermissions) return this.configured(owner, connection);
    const explicit = new Set(this.store.entries<Assignment>(assignments).map(a => a.id));
    return this.configured(owner, connection)
      .flatMap(agentId => [agentId, ...(this.sharing?.sharedBy(agentId) ?? []).filter(id => !explicit.has(id))]);
  }
  connections(agentId: string, owner: string): string[] {
    return [...(this.principal(agentId, owner)?.connections ?? [])];
  }
  /** Everyone sharing the same skill directories; the connector still authorizes each agent independently. */
  environmentAssignments(holder: string, owner: string) {
    return [holder, ...(this.sharing?.sharedBy(holder) ?? [])].flatMap(agentId => {
      const connections = this.connections(agentId, owner);
      return connections.length ? [{ agentId, connections }] : [];
    });
  }
  /** Browser connections assigned to this Agent, by their tool-name prefix. */
  browser(agentId: string, owner: string): string[] {
    const browser = this.config?.browserConnections ?? [];
    return this.connections(agentId, owner).filter(id => browser.includes(id));
  }
  /** Reads the Agent's assignment on every call: what it may use is what the owner set last. */
  reader(agentId: string, owner: string): ConnectedAppReader | undefined {
    if (!this.client) return undefined;
    const client = this.client, caller = this.caller;
    return async (input, scope, options) => {
      const principal = this.principal(agentId, owner);
      if (!principal) return { status: "failed", error: "connected_app_not_granted" };
      const selected = scope ? { ...principal, connections: principal.connections.filter(id => scope.connections.includes(id)) } : principal;
      if (!selected.connections.length) return { status: "failed", error: "connected_app_not_granted" };
      const write = options?.write === true && caller;
      if (input.action === "tools") {
        const tools = write ? await caller.tools(selected) : await client.tools(selected);
        return { status: "completed", tools: scope?.operations ? tools.filter(t => scope.operations!.includes(t.name)) : tools };
      }
      if (!input.name) return { status: "failed", error: "tool_name_required" };
      if (scope?.operations && !scope.operations.includes(input.name)) return { status: "failed", error: "connected_app_operation_not_granted" };
      return write ? caller.call(selected, input.name, input.arguments ?? {}) : client.call(selected, input.name, input.arguments ?? {});
    };
  }
}
