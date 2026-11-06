import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { RouterError } from "@agent-router/server";
import { signGrant, signServiceToken } from "@olorinm/agent-connectors/issuer";

export const connectorAccountsSchema = z.object({
  url: z.url(), issuer: z.string().min(1), audience: z.string().min(1),
  authorityKeyFile: z.string().min(1),
  consentOrigins: z.array(z.url()).min(1).max(20),
  runtimeConfigFile: z.string().min(1).optional(),
}).strict().optional();
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const entrySchema = z.object({ id: idSchema, kind: z.string().max(64), owner: z.string().max(256),
  label: z.string().max(200), usage: z.string().max(64).optional(), account: z.record(z.string(), z.unknown()) });
/** An application the product already holds (Router's Feishu chat bot), handed to the connector for owner authorization. */
export interface FeishuApplication { appId: string; appSecret: string; domain: "feishu" | "lark"; ownerOpenId: string }
const operationIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const operationViewSchema = z.object({ id: z.string(), owner: z.string(), agentId: z.string(), connectionId: z.string(), tool: z.string(),
  digest: z.string().regex(/^[0-9a-f]{64}$/), status: z.enum(["pending", "executing", "completed", "failed", "uncertain", "denied", "expired"]),
  summary: z.string().max(4000), input: z.unknown(), createdAt: z.string(), expiresAt: z.string(),
  outcome: z.record(z.string(), z.unknown()).optional() }).passthrough();
export type OperationView = z.infer<typeof operationViewSchema>;
const errorCode = (body: unknown) => {
  const code = body && typeof body === "object" && "error" in body ? (body as { error: unknown }).error : undefined;
  return typeof code === "string" && /^[a-z0-9_]{1,80}$/.test(code) ? code : "operation_refused";
};
export interface AccountState {
  state: "connected" | "authorization_required" | "authorization_pending" | "expired" | "disconnected" | "needs_setup" | "needs_attention";
  verification: "oauth" | "provider" | "none";
  scopes: string[];
  /** Why the account is expired or needs setup, e.g. `refresh_token_expired`, `application_not_provided`. */
  reason?: string;
  /** The authorized user's display name (Feishu), shown to that owner only. */
  name?: string;
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
  private async request(path: string, mutation = false, options: { body?: unknown; service?: string; status?: (status: number, body: unknown) => unknown } = {}): Promise<unknown> {
    if (!this.options || !this.key || !this.endpoint) throw new RouterError("connector_service_not_configured", 503);
    let dispatched = false;
    try {
      const token = await signServiceToken({ key: this.key, issuer: this.options.issuer,
        audience: this.options.audience, service: options.service ?? "mau-account-management", ttlSeconds: 120 });
      dispatched = true;
      const response = await fetch(this.endpoint + path, { method: mutation ? "POST" : "GET", redirect: "error",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}), signal: AbortSignal.timeout(options.body !== undefined ? 150_000 : 65_000) });
      if (!response.ok && options.status && response.status < 500) {
        // Refusals (404/409/403) are definite answers for approvals; the body is only an error code.
        const text = await response.text().catch(() => "");
        let parsed: unknown; try { parsed = JSON.parse(text.slice(0, 10_000)); } catch { parsed = undefined; }
        return options.status(response.status, parsed);
      }
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
  /** Trusted operation view for the approval card; the Agent never receives the service token or the grant. */
  async operation(id: string): Promise<OperationView | undefined> {
    if (!operationIdSchema.safeParse(id).success) return undefined;
    const raw = await this.request(`/v1/operations/${id}`, false, { service: "mau-approvals", status: status => status === 404 ? null : undefined });
    if (raw === null) return undefined;
    const parsed = operationViewSchema.safeParse(raw);
    if (!parsed.success || parsed.data.id !== id) throw new RouterError("connector_service_unavailable", 502);
    return parsed.data;
  }
  /** Sign a single-use grant for exactly this owner, operation and digest, then execute it upstream. */
  async approve(owner: string, id: string, digest: string): Promise<{ outcome?: Record<string, unknown>; refused?: string }> {
    if (!this.options || !this.key) throw new RouterError("connector_service_not_configured", 503);
    if (!operationIdSchema.safeParse(id).success || !/^[0-9a-f]{64}$/.test(digest)) return { refused: "operation_not_found" };
    const grant = await signGrant({ key: this.key, issuer: this.options.issuer, audience: this.options.audience,
      owner, operationId: id, digest, approver: owner, ttlSeconds: 120 });
    const raw = await this.request(`/v1/operations/${id}/approve`, true, { body: { grant }, service: "mau-approvals",
      status: (_status, body) => ({ refused: errorCode(body) }) });
    if (raw && typeof raw === "object" && "refused" in raw) return raw as { refused: string };
    const parsed = z.record(z.string(), z.unknown()).safeParse(raw);
    if (!parsed.success || typeof parsed.data.status !== "string") throw new RouterError("connector_action_unknown", 409);
    return { outcome: parsed.data };
  }
  async deny(id: string): Promise<{ refused?: string }> {
    if (!operationIdSchema.safeParse(id).success) return { refused: "operation_not_found" };
    const raw = await this.request(`/v1/operations/${id}/deny`, true, { service: "mau-approvals", status: (_status, body) => ({ refused: errorCode(body) }) });
    return raw && typeof raw === "object" && "refused" in raw ? raw as { refused: string } : {};
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
      : ["authorization_required", "authorization_pending", "expired", "disconnected"].includes(String(status)) ? status as AccountState["state"]
      : typeof status === "string" && /configuration|client.*required|redirect.*required|account_management_unavailable/.test(status) ? "needs_setup" : "needs_attention";
    const result: AccountState = { state, verification: connected ? account.verification === "oauth" ? "oauth" : "provider" : "none",
      scopes: z.array(z.string().max(256)).max(100).safeParse(account.scopes ?? account.scope).data ?? [] };
    const reason = z.string().regex(/^[a-z0-9_]{1,64}$/).safeParse(account.reason);
    if (reason.success && state !== "connected") result.reason = reason.data;
    const name = z.string().min(1).max(200).safeParse(account.userName);
    if (name.success && connected) result.name = name.data.replace(/[\x00-\x1f\x7f]/g, "");
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
      .map(entry => ({ id: entry.id, kind: entry.kind, label: entry.label, ...(entry.usage === "owner_private" ? { usage: "owner_private" as const } : {}),
        ...this.state(entry.account) })) };
  }
  /** Connection IDs and declared usage, for admission policy. Service-wide; never returned to a browser. */
  async usage() { return (await this.entries()).map(({ id, usage }) => ({ id, usage })); }
  /** Hand over an app Mau already holds to this owner's Feishu connection; the secret goes only to the connector service. */
  async provideApplication(owner: string, id: string, application: FeishuApplication) {
    if (!idSchema.safeParse(id).success) throw new RouterError("connector_account_not_found", 404);
    const entry = (await this.entries()).find(entry => entry.id === id && entry.owner === owner);
    if (!entry) throw new RouterError("connector_account_not_found", 404);
    if (entry.kind !== "feishu") throw new RouterError("connector_application_not_supported", 409);
    return this.state(await this.request(`/v1/connections/${id}/application`, true, { body: application }));
  }
  async action(owner: string, id: string, action: "check" | "connect" | "complete" | "disconnect") {
    if (!idSchema.safeParse(id).success) throw new RouterError("connector_account_not_found", 404);
    // Service tokens are service-wide: authenticate and recheck upstream ownership before every action.
    const entry = (await this.entries()).find(entry => entry.id === id && entry.owner === owner);
    if (!entry) throw new RouterError("connector_account_not_found", 404);
    if (action === "check") return this.state(entry.account);
    // Do not invalidate a working account just because Connect was clicked twice.
    if (action === "connect" && this.state(entry.account).state === "connected") return this.state(entry.account);
    // Device-flow consent (Feishu) is finished by `complete`; while it waits, the same consent link is returned.
    if (action === "complete" && entry.kind !== "feishu") throw new RouterError("connector_action_not_supported", 409);
    return this.state(await this.request(`/v1/connections/${id}/${action}`, true), action === "connect" || action === "complete");
  }
}
