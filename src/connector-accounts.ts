import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { RouterError } from "@agent-router/server";
import { signServiceToken } from "@olorinm/agent-connectors/issuer";

export const connectorAccountsSchema = z.object({
  url: z.url(), issuer: z.string().min(1), audience: z.string().min(1),
  authorityKeyFile: z.string().min(1),
  consentOrigins: z.array(z.url()).min(1).max(20),
  runtimeConfigFile: z.string().min(1).optional(),
}).strict().optional();
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const entrySchema = z.object({ id: idSchema, kind: z.string().max(64), owner: z.string().max(256),
  label: z.string().max(200), account: z.record(z.string(), z.unknown()) });
export interface AccountState {
  state: "connected" | "authorization_required" | "authorization_pending" | "disconnected" | "needs_setup" | "needs_attention";
  verification: "oauth" | "provider" | "none";
  scopes: string[];
  authorizationUrl?: string;
  expiresAt?: string;
}

/** Trusted account management only. No caller tokens, grants, tools or provider credentials enter the browser. */
export class ConnectorAccounts {
  readonly configured: boolean;
  private readonly endpoint?: string;
  private readonly key?: Parameters<typeof signServiceToken>[0]["key"];
  private readonly origins = new Set<string>();
  constructor(private readonly options: z.infer<typeof connectorAccountsSchema>, base: string) {
    this.configured = !!options;
    if (!options) return;
    const url = new URL(options.url);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("connector_endpoint_invalid");
    this.endpoint = url.origin;
    for (const raw of options.consentOrigins) {
      const origin = new URL(raw);
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/")
        throw new Error("connector_consent_origin_invalid");
      this.origins.add(origin.origin);
    }
    const path = resolve(base, options.authorityKeyFile);
    if (statSync(path).mode & 0o077) throw new Error("connector_authority_key_permissions");
    const privateJwk = z.object({ kid: z.string().min(1), kty: z.literal("OKP"), crv: z.literal("Ed25519"),
      x: z.string().min(1), d: z.string().min(1) }).parse(JSON.parse(readFileSync(path, "utf8")));
    this.key = { kid: privateJwk.kid, privateJwk };
  }
  private async request(path: string, mutation = false): Promise<unknown> {
    if (!this.options || !this.key || !this.endpoint) throw new RouterError("connector_service_not_configured", 503);
    let dispatched = false;
    try {
      const token = await signServiceToken({ key: this.key, issuer: this.options.issuer,
        audience: this.options.audience, service: "mau-account-management", ttlSeconds: 120 });
      dispatched = true;
      const response = await fetch(this.endpoint + path, { method: mutation ? "POST" : "GET", redirect: "error",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(65_000) });
      if (!response.ok || !response.body) throw new Error("connector_service_unavailable");
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 1_000_000) throw new Error("connector_response_too_large");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      // A timed-out connect/disconnect can already have invalidated prior tokens or approvals.
      throw new RouterError(mutation && dispatched ? "connector_action_unknown" : "connector_service_unavailable", mutation && dispatched ? 409 : 502);
    }
  }
  private async entries() {
    const result = z.object({ connections: z.array(entrySchema).max(1000) }).safeParse(await this.request("/v1/connections"));
    if (!result.success || new Set(result.data.connections.map(c => c.id)).size !== result.data.connections.length)
      throw new RouterError("connector_service_unavailable", 502);
    return result.data.connections;
  }
  private state(raw: unknown, includeConsent = false): AccountState {
    const parsed = z.record(z.string(), z.unknown()).safeParse(raw);
    if (!parsed.success) throw new RouterError("connector_service_unavailable", 502);
    const account = parsed.data, status = account.status;
    const connected = status === "connected" || (account.authorized === true && account.verified === true);
    const state: AccountState["state"] = connected ? "connected"
      : ["authorization_required", "authorization_pending", "disconnected"].includes(String(status)) ? status as AccountState["state"]
      : typeof status === "string" && /configuration|client.*required|redirect.*required|account_management_unavailable/.test(status) ? "needs_setup" : "needs_attention";
    const result: AccountState = { state, verification: connected ? account.verification === "oauth" ? "oauth" : "provider" : "none",
      scopes: z.array(z.string().max(256)).max(100).safeParse(account.scopes).data ?? [] };
    if (includeConsent) {
      const rawUrl = account.authorizationUrl ?? account.verificationUrl;
      if (typeof rawUrl === "string") {
        try {
          const url = new URL(rawUrl);
          if (rawUrl.length > 16_384 || /[\x00-\x20\x7f]/.test(rawUrl) || url.username || url.password || !this.origins.has(url.origin)) throw new Error();
          result.authorizationUrl = url.href;
        } catch { throw new RouterError("connector_consent_url_refused", 502); }
      }
      if (typeof account.expiresAt === "string" && Number.isFinite(Date.parse(account.expiresAt))) result.expiresAt = account.expiresAt;
    }
    return result;
  }
  async list(owner: string) {
    if (!this.configured) return { configured: false, data: [] };
    return { configured: true, data: (await this.entries()).filter(entry => entry.owner === owner)
      .map(entry => ({ id: entry.id, kind: entry.kind, label: entry.label, ...this.state(entry.account) })) };
  }
  async action(owner: string, id: string, action: "check" | "connect" | "disconnect") {
    if (!idSchema.safeParse(id).success) throw new RouterError("connector_account_not_found", 404);
    // Service tokens are service-wide: authenticate and recheck upstream ownership before every action.
    const entry = (await this.entries()).find(entry => entry.id === id && entry.owner === owner);
    if (!entry) throw new RouterError("connector_account_not_found", 404);
    if (action === "check") return this.state(entry.account);
    // Do not invalidate a working account just because Connect was clicked twice.
    if (action === "connect" && this.state(entry.account).state === "connected") return this.state(entry.account);
    return this.state(await this.request(`/v1/connections/${id}/${action}`, true), action === "connect");
  }
}
