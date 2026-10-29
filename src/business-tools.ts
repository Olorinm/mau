import { resolve } from "node:path";
import { z } from "zod";
import { HttpAgentHost, type HostPort, type ServiceHttp } from "@agent-router/server";
import { BusinessDataClient, businessDataTools, businessDataOptionsSchema } from "@olorinm/agent-connectors/business-data";
import { FeishuBotReader, feishuBotReaderSchema } from "@olorinm/agent-connectors/feishu-bot-reader";
import { CloudflareReadClient, cloudflareReadSchema } from "@olorinm/agent-connectors/cloudflare-read-client";
import { DurableStore } from "./store.js";

export const businessToolsSchema = z.array(z.union([businessDataOptionsSchema.extend({
  agentId: z.uuid(), owner: z.string().min(1), feishu: feishuBotReaderSchema.optional(),
}).strict(), cloudflareReadSchema])).max(100).default([]);
const inputSchema = z.object({ tool: z.enum([...businessDataTools.filter(t => t !== "sql"), "tools"]), arguments: z.record(z.string(), z.unknown()) }).strict();
const definition = { name: "business_data", timeoutMs: 90_000,
  description: "Read permitted business data through a server-side connector. Start with tool=tools and arguments={} to see the exact schemas of permitted operations, then catalog for source grants and schema for tables. Available operations: catalog, schema, rows, novel_chapters, novel_production, outline_novel, script_content. The catalog describes each operation's arguments and source grants. No write operations are allowed. Credentials are managed by Mau; never look for keys or internal endpoints in the sandbox.",
  inputSchema: z.toJSONSchema(inputSchema) };

/** Compose trusted tools with Host's native dynamic-tool protocol; no credential goes to Host. */
const feishuInput = z.object({ args: z.array(z.string().max(100_000)).min(1).max(100) }).strict();
const feishuDefinition = { name: "feishu_bot_read", timeoutMs: 90_000,
  description: "Read Feishu resources using the existing bot's permissions through the server-side official CLI. Start with args=[\"skills\",\"read\",\"lark-shared\"] and the relevant domain skill, or args=[\"--help\"]. Inspect a command with args=[\"schema\",\"drive files list\"]. Avoid the full schema catalog. Pass args without the executable, --as, --profile, shell syntax or local paths. Writes are refused. Sending replies/files in the current conversation uses the separate channel tool.",
  inputSchema: z.toJSONSchema(feishuInput) };
type BusinessClient = Pick<BusinessDataClient, "call"> & { feishu?: Pick<FeishuBotReader, "read"> };
export class BusinessTools {
  private readonly clients = new Map<string, { owner: string; client: BusinessClient }>();
  constructor(options: z.input<typeof businessToolsSchema>, base: string, private readonly store: DurableStore) {
    for (const entry of businessToolsSchema.parse(options)) {
      const {agentId, owner} = entry;
      if (this.clients.has(agentId)) throw new Error("duplicate_business_tool_agent");
      if ("mode" in entry) {
        const client = new CloudflareReadClient({...entry, tokenFile: resolve(base, entry.tokenFile)});
        this.clients.set(agentId, {owner, client: {call: (name, input) => client.call(name, input), feishu: {read: args => client.read(args)}}});
        continue;
      }
      const {feishu, agentId: _agentId, owner: _owner, ...option} = entry;
      const data = new BusinessDataClient({ ...option, tokenFile: resolve(base, option.tokenFile) });
      this.clients.set(agentId, { owner, client: { call: (name, input) => data.call(name, input),
        ...(feishu ? { feishu: new FeishuBotReader({ ...feishu, appSecretFile: resolve(base, feishu.appSecretFile), directory: resolve(base, feishu.directory) }) } : {}) } });
    }
  }
  inventory(owner: string) {
    return [...this.clients].filter(([, entry]) => entry.owner === owner).map(([agentId, entry]) => ({
      agentId, kind: "business-data" as const, status: "configured" as const,
      tools: businessDataTools.filter(name => name !== "sql"), feishuBotRead: !!entry.client.feishu,
      permission: "read-only" as const,
    }));
  }
  async check(owner: string, agentId: string) {
    const entry = this.clients.get(agentId);
    if (!entry || entry.owner !== owner) throw new Error("business_tool_not_authorized");
    const result = await entry.client.call("tools", {}) as { isError?: boolean; content?: unknown } | undefined;
    if (!result || result.isError !== false || !Array.isArray(result.content)) throw new Error("connector_check_failed");
    return { status: "verified" as const, checkedAt: new Date().toISOString() };
  }
  host(agentId: string, owner: string, binding: string, http: ServiceHttp): HostPort {
    const entry = this.clients.get(agentId);
    if (!entry || entry.owner !== owner) return new HttpAgentHost(http);
    return new BusinessHost(http, entry.client, this.store, `${agentId}:${binding}`);
  }
}
export class BusinessHost extends HttpAgentHost {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(http: ServiceHttp, private readonly client: BusinessClient,
    private readonly store: DurableStore, private readonly scope: string) { super(http); }
  override async start(input: Parameters<HostPort["start"]>[0]) {
    // Router supplies channel tools only to conversations admitted by its channel policy.
    const allowed = input.tools?.some(tool => tool.name === "channel") === true;
    const run = await super.start(allowed ? { ...input, tools: [...input.tools!, definition, ...(this.client.feishu ? [feishuDefinition] : [])] } : input);
    this.store.set("business_runs", `${this.scope}:${run.id}`, { allowed });
    return run;
  }
  override async calls(id: string): ReturnType<HostPort["calls"]> {
    const calls = await super.calls(id);
    for (const call of calls) {
      if (![definition.name, feishuDefinition.name].includes(call.name) || call.kind !== "tool" || call.status !== "pending") continue;
      let operation = this.pending.get(call.id);
      if (!operation) {
        operation = (async () => {
          const grant = this.store.get<{ allowed: boolean }>("business_runs", `${this.scope}:${id}`);
          let result: unknown;
          try {
            if (!grant?.allowed || call.runId !== id) throw new Error("business_tool_not_authorized");
            if (call.name === feishuDefinition.name) {
              const parsed = feishuInput.safeParse(call.input);
              if (!this.client.feishu || !parsed.success) throw new Error("invalid_business_arguments");
              result = await this.client.feishu.read(parsed.data.args);
            } else {
              const parsed = inputSchema.safeParse(call.input);
              if (!parsed.success) throw new Error("invalid_business_arguments");
              result = await this.client.call(parsed.data.tool, parsed.data.arguments);
            }
          } catch (error) {
            result = { isError: true, error: error instanceof Error && ["business_tool_not_authorized", "invalid_business_arguments", "feishu_write_requires_owner_approval"].includes(error.message)
              ? error.message : call.name === feishuDefinition.name ? "feishu_read_unavailable" : "business_data_unavailable" };
          }
          let text = JSON.stringify(result);
          if (text.length > 1_000_000) text = JSON.stringify({ isError: true, error: "business_result_too_large", instruction: "Narrow the query." });
          await super.resolve(id, call.id, { success: !(result as any)?.isError,
            contentItems: [{ type: "inputText", text }] });
        })().finally(() => this.pending.delete(call.id));
        this.pending.set(call.id, operation);
      }
      await operation;
    }
    return calls.filter(call => ![definition.name, feishuDefinition.name].includes(call.name) || call.kind !== "tool");
  }
}
