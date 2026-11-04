import { resolve } from "node:path";
import { z } from "zod";
import { ConnectorReadClient, readClientSchema } from "@olorinm/agent-connectors/read-client";
import { ConnectorCallerClient } from "./connector-client.js";

const connectionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
export const connectedAppsSchema = readClientSchema.extend({ assignments: z.array(z.object({
  agentId: z.uuid(), owner: z.string().min(1), connections: z.array(connectionId).min(1).max(64),
}).strict()).max(100),
  /** Connections served by the browser connector; Mau relays their files through the Agent's workspace. */
  browserConnections: z.array(connectionId).max(64).default([]) }).strict().optional();
export const connectedAppInput = z.object({ action: z.enum(["tools", "call"]), name: z.string().max(64).optional(),
  arguments: z.record(z.string(), z.unknown()).optional() }).strict();
export const connectedAppDefinition = { name: "connected_apps", timeoutMs: 600_000,
  description: "Use the owner's authorized apps through Mau. First call action=tools to discover available operations and their exact input schemas. Then use action=call, name and arguments. Reads run directly. In the owner's own conversations, operations marked risk=write ask the owner to approve on a trusted card and this call waits for the decision, then returns the outcome; if the owner declines, the result is owner_denied: do not retry or ask for approvals in chat. Scheduled and delegated work can only read. Account consent and credentials stay in Mau; if authorization is missing, ask the owner to connect the app in Mau. Do not look for credentials or endpoints in the sandbox.",
  inputSchema: z.toJSONSchema(connectedAppInput) };
export interface ConnectedAppScope { connections: string[]; operations?: string[] | undefined; }
/** `write` is set only by Mau for owner admissions; model arguments never select it. */
export interface ConnectedAppOptions { write?: boolean; }
export type ConnectedAppReader = (input: z.infer<typeof connectedAppInput>, scope?: ConnectedAppScope, options?: ConnectedAppOptions) => Promise<unknown>;
export const browserToolName = (connection: string, tool: string) => `${connection.replaceAll("-", "_")}__${tool}`;
export class ConnectedApps {
  private readonly client?: ConnectorReadClient;
  private readonly caller?: ConnectorCallerClient;
  constructor(private readonly config: z.infer<typeof connectedAppsSchema>, base: string, writable = false) {
    if (!config) return;
    if (new Set(config.assignments.map(a => a.agentId)).size !== config.assignments.length) throw new Error("duplicate_connected_app_agent");
    const { browserConnections: _browser, assignments: _assignments, ...endpoint } = config;
    this.client = new ConnectorReadClient({ ...endpoint, callerKeyFile: resolve(base, config.callerKeyFile) });
    // Without an approval presenter (authority key), write-capable tokens are never minted.
    if (writable) this.caller = new ConnectorCallerClient({ ...endpoint, callerKeyFile: resolve(base, config.callerKeyFile) });
  }
  get writable() { return !!this.caller; }
  assigned(owner: string, connection: string) {
    return this.config?.assignments.filter(a => a.owner === owner && a.connections.includes(connection)).map(a => a.agentId) ?? [];
  }
  connections(agentId: string, owner: string): string[] {
    return [...(this.config?.assignments.find(a => a.agentId === agentId && a.owner === owner)?.connections ?? [])];
  }
  /** Browser connections assigned to this Agent, by their tool-name prefix. */
  browser(agentId: string, owner: string): string[] {
    const browser = this.config?.browserConnections ?? [];
    return this.connections(agentId, owner).filter(id => browser.includes(id));
  }
  reader(agentId: string, owner: string): ConnectedAppReader | undefined {
    const principal = this.config?.assignments.find(a => a.agentId === agentId && a.owner === owner);
    if (!principal || !this.client) return undefined;
    const client = this.client, caller = this.caller;
    return async (input, scope, options) => {
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
