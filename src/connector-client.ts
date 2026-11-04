import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { signCallerToken } from "@olorinm/agent-connectors/issuer";
import type { ReadPrincipal } from "@olorinm/agent-connectors/read-client";

/** Owner-admitted caller. Writes still return approval_required; only the owner's grant executes them. */
export class ConnectorCallerClient {
  private readonly url: URL;
  private readonly key: Parameters<typeof signCallerToken>[0]["key"];
  constructor(private readonly config: { url: string; issuer: string; audience: string; callerKeyFile: string },
    private readonly maxResponseBytes = 16_000_000) {
    this.url = new URL(config.url);
    if ((this.url.protocol !== "https:" && !(this.url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(this.url.hostname))) ||
      this.url.username || this.url.password || this.url.hash || this.url.search || this.url.pathname !== "/")
      throw new Error("connector_endpoint_invalid");
    if (statSync(config.callerKeyFile).mode & 0o077) throw new Error("connector_caller_key_must_be_private");
    const privateJwk = z.object({ kid: z.string().min(1), kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string().min(1), d: z.string().min(1) })
      .parse(JSON.parse(readFileSync(config.callerKeyFile, "utf8")));
    this.key = { kid: privateJwk.kid, privateJwk };
  }
  private async session<T>(principal: ReadPrincipal, work: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
    const token = await signCallerToken({ key: this.key, issuer: this.config.issuer, audience: this.config.audience,
      agentId: principal.agentId, owner: principal.owner, connections: principal.connections, readOnly: false, ttlSeconds: 120 });
    const signal = AbortSignal.timeout(150_000), endpoint = new URL("/mcp", this.url), limit = this.maxResponseBytes;
    const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        if (target.href !== endpoint.href) throw new Error("connector_endpoint_refused");
        const response = await fetch(input, { ...init, redirect: "error", signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
        if (!response.body) return response;
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > limit) throw new Error("connector_response_too_large");
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
      } });
    const client = new Client({ name: "mau-connector-caller", version: "1" });
    try {
      await client.connect(transport as Parameters<Client["connect"]>[0], { signal });
      return await work(client, signal);
    } catch {
      throw new Error("connector_unavailable");
    } finally { await client.close().catch(() => {}); }
  }
  async tools(principal: ReadPrincipal) {
    return this.session(principal, async (client, signal) => {
      const result = await client.listTools({}, { signal });
      if (result.nextCursor || result.tools.length > 300) throw new Error("connector_tool_catalog_invalid");
      return result.tools.filter(tool => tool.name !== "operation_status")
        .map(({ name, description, inputSchema, annotations }) => ({ name, description: description ?? "", inputSchema,
          risk: annotations?.readOnlyHint === true ? "read" as const : "write" as const }));
    });
  }
  async call(principal: ReadPrincipal, name: string, input: Record<string, unknown>): Promise<unknown> {
    return this.session(principal, async (client, signal) => {
      const result = await client.callTool({ name, arguments: input }, undefined, { signal, timeout: 130_000 });
      if (!result.structuredContent) throw new Error("connector_result_invalid");
      return result.structuredContent;
    });
  }
}
