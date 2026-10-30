import { resolve } from "node:path";
import { z } from "zod";
import { ConnectorReadClient, readClientSchema } from "@olorinm/agent-connectors/read-client";

export const connectedAppsSchema = readClientSchema.extend({ assignments: z.array(z.object({
  agentId: z.uuid(), owner: z.string().min(1), connections: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)).min(1).max(64),
}).strict()).max(100) }).strict().optional();
export const connectedAppInput = z.object({ action: z.enum(["tools", "call"]), name: z.string().max(64).optional(),
  arguments: z.record(z.string(), z.unknown()).optional() }).strict();
export const connectedAppDefinition = { name: "connected_apps", timeoutMs: 120_000,
  description: "Read the owner's authorized apps through Mau. First call action=tools to discover available operations and their exact input schemas. Then use action=call, name and arguments. Only reads are available. Account consent and credentials stay in Mau; if authorization is missing, ask the owner to connect the app in Mau. Do not look for credentials or endpoints in the sandbox.",
  inputSchema: z.toJSONSchema(connectedAppInput) };
export interface ConnectedAppScope { connections: string[]; operations?: string[] | undefined; }
export type ConnectedAppReader = (input: z.infer<typeof connectedAppInput>, scope?: ConnectedAppScope) => Promise<unknown>;
export class ConnectedApps {
  private readonly client?: ConnectorReadClient;
  constructor(private readonly config: z.infer<typeof connectedAppsSchema>, base: string) {
    if (!config) return;
    if (new Set(config.assignments.map(a => a.agentId)).size !== config.assignments.length) throw new Error("duplicate_connected_app_agent");
    this.client = new ConnectorReadClient({ ...config, callerKeyFile: resolve(base, config.callerKeyFile) });
  }
  assigned(owner: string, connection: string) {
    return this.config?.assignments.filter(a => a.owner === owner && a.connections.includes(connection)).map(a => a.agentId) ?? [];
  }
  connections(agentId: string, owner: string): string[] {
    return [...(this.config?.assignments.find(a => a.agentId === agentId && a.owner === owner)?.connections ?? [])];
  }
  reader(agentId: string, owner: string): ConnectedAppReader | undefined {
    const principal = this.config?.assignments.find(a => a.agentId === agentId && a.owner === owner);
    if (!principal || !this.client) return undefined;
    const client = this.client;
    return async (input, scope) => {
      const selected = scope ? { ...principal, connections: principal.connections.filter(id => scope.connections.includes(id)) } : principal;
      if (!selected.connections.length) return { status: "failed", error: "connected_app_not_granted" };
      if (input.action === "tools") {
        const tools = await client.tools(selected);
        return { status: "completed", tools: scope?.operations ? tools.filter(t => scope.operations!.includes(t.name)) : tools };
      }
      if (!input.name) return { status: "failed", error: "tool_name_required" };
      if (scope?.operations && !scope.operations.includes(input.name)) return { status: "failed", error: "connected_app_operation_not_granted" };
      return client.call(selected, input.name, input.arguments ?? {});
    };
  }
}
