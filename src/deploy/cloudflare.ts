// The Cloudflare REST calls deploy and doctor make. Each is documented under
// https://developers.cloudflare.com/api/ ; the paths are relative to https://api.cloudflare.com/client/v4.
import type { Effects } from "./effects.js";

const API = "https://api.cloudflare.com/client/v4";

export class CloudflareError extends Error {
  constructor(readonly status: number, readonly codes: number[], message: string) { super(message); }
  /** The credentials are valid but may not do this. */
  get denied() { return this.status === 401 || this.status === 403; }
  get missing() { return this.status === 404; }
}
/** Where the token came from: `CLOUDFLARE_API_TOKEN`, or the local `wrangler login`. */
export interface Credentials { token: string; source: "api-token" | "wrangler-login" }

export interface Zone { id: string; name: string; status: string; account: { id: string; name: string } }
export interface AccessApplication { id: string; domain: string; aud: string; name: string; type: string }
interface Envelope<T> { success: boolean; result: T; errors?: Array<{ code: number; message: string }>; result_info?: { cursor?: string } }

export class Cloudflare {
  constructor(private readonly effects: Effects, readonly credentials: Credentials, readonly accountId = "") {}
  forAccount(accountId: string) { return new Cloudflare(this.effects, this.credentials, accountId); }
  private get account() { return `/accounts/${this.accountId}`; }

  private async call<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    const response = await this.effects.fetch(API + path, {
      method, headers: { Authorization: `Bearer ${this.credentials.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const envelope = await response.json().catch(() => undefined) as Envelope<T> | undefined;
    if (!response.ok || !envelope?.success) {
      const errors = envelope?.errors ?? [];
      throw new CloudflareError(response.status, errors.map((error) => error.code),
        `${method} ${path.split("?")[0]}: ${response.status} ${errors.map((error) => `${error.code} ${error.message}`).join("; ")}`.trim());
    }
    return envelope;
  }
  private async request<T>(method: string, path: string, body?: unknown) { return (await this.call<T>(method, path, body)).result; }

  /** The accounts these credentials can use. */
  accounts() { return this.request<Array<{ id: string; name: string }>>("GET", "/accounts?per_page=50"); }
  /** The zone a hostname belongs to: the longest zone name among its suffixes that these credentials can see. */
  async zoneOf(hostname: string): Promise<Zone | undefined> {
    const labels = hostname.split(".");
    for (let start = 0; start <= labels.length - 2; start++) {
      const [zone] = await this.request<Zone[]>("GET", `/zones?name=${encodeURIComponent(labels.slice(start).join("."))}`);
      if (zone) return zone;
    }
    return undefined;
  }
  /** DNS records with exactly this name. A Custom Domain replaces a record that is in its way. */
  dnsRecords(zoneId: string, hostname: string) {
    return this.request<Array<{ id: string; type: string; name: string }>>("GET", `/zones/${zoneId}/dns_records?name.exact=${encodeURIComponent(hostname)}`);
  }
  /** The Worker a hostname is attached to as a Custom Domain, if any. */
  async customDomainService(hostname: string): Promise<string | undefined> {
    const domains = await this.request<Array<{ hostname: string; service: string }>>("GET", `${this.account}/workers/domains?hostname=${encodeURIComponent(hostname)}`);
    return domains.find((domain) => domain.hostname === hostname)?.service;
  }
  /** The account's workers.dev subdomain, or undefined when none was ever registered. */
  async workersSubdomain(): Promise<string | undefined> {
    try { return (await this.request<{ subdomain?: string }>("GET", `${this.account}/workers/subdomain`)).subdomain || undefined; }
    catch (error) { if (error instanceof CloudflareError && (error.missing || error.codes.includes(10007))) return undefined; throw error; }
  }

  async bucketExists(name: string): Promise<boolean> {
    try { await this.request("GET", `${this.account}/r2/buckets/${name}`); return true; }
    catch (error) { if (error instanceof CloudflareError && (error.missing || error.codes.includes(10006))) return false; throw error; }
  }
  createBucket(name: string) { return this.request("POST", `${this.account}/r2/buckets`, { name }); }
  async lifecycleRules(bucket: string) {
    return (await this.request<{ rules?: Array<{ id: string }> }>("GET", `${this.account}/r2/buckets/${bucket}/lifecycle`)).rules ?? [];
  }
  /** Replaces the bucket's whole rule list. */
  setLifecycleRules(bucket: string, rules: unknown[]) { return this.request("PUT", `${this.account}/r2/buckets/${bucket}/lifecycle`, { rules }); }

  // Account API tokens. An R2 S3 key pair is such a token: https://developers.cloudflare.com/r2/api/tokens/
  async permissionGroup(name: string): Promise<string | undefined> {
    const groups = await this.request<Array<{ id: string; name: string }>>("GET", `${this.account}/tokens/permission_groups?name=${encodeURIComponent(name)}`);
    return groups.find((group) => group.name === name)?.id;
  }
  async tokenNamed(name: string): Promise<string | undefined> {
    for (let page = 1; ; page++) {
      const tokens = await this.request<Array<{ id: string; name: string }>>("GET", `${this.account}/tokens?per_page=50&page=${page}`);
      const found = tokens.find((token) => token.name === name);
      if (found || tokens.length < 50) return found?.id;
    }
  }
  createToken(name: string, permissionGroup: string, resourceKeys: string[]) {
    return this.request<{ id: string; value: string }>("POST", `${this.account}/tokens`, { name,
      policies: [{ effect: "allow", permission_groups: [{ id: permissionGroup }], resources: Object.fromEntries(resourceKeys.map((key) => [key, "*"])) }] });
  }
  /** Gives an existing token a new value; the old one stops working. */
  rollToken(id: string) { return this.request<string>("PUT", `${this.account}/tokens/${id}/value`, {}); }

  // Cloudflare Access.
  async accessTeamDomain(): Promise<string | undefined> {
    try { return (await this.request<{ auth_domain?: string }>("GET", `${this.account}/access/organizations`)).auth_domain || undefined; }
    catch (error) { if (error instanceof CloudflareError && error.missing) return undefined; throw error; }
  }
  async accessApplication(domain: string): Promise<AccessApplication | undefined> {
    const applications = await this.request<AccessApplication[]>("GET", `${this.account}/access/apps?domain=${encodeURIComponent(domain)}&exact=true&per_page=1000`);
    return applications.find((application) => application.domain === domain && application.type === "self_hosted");
  }
  async accessPolicy(name: string): Promise<string | undefined> {
    const policies = await this.request<Array<{ id: string; name: string }>>("GET", `${this.account}/access/policies?per_page=1000`);
    return policies.find((policy) => policy.name === name)?.id;
  }
  async createAccessPolicy(name: string, decision: "allow" | "bypass", include: unknown[]) {
    return (await this.request<{ id: string }>("POST", `${this.account}/access/policies`, { name, decision, include })).id;
  }
  createAccessApplication(name: string, domain: string, policyId: string) {
    return this.request<AccessApplication>("POST", `${this.account}/access/apps`, { type: "self_hosted", name, domain,
      destinations: [{ type: "public", uri: domain }], session_duration: "24h", policies: [{ id: policyId, precedence: 1 }] });
  }

  /** The plain-text variables a deployed Worker carries and the names of its secrets; undefined when it does not exist. */
  async workerSettings(script: string): Promise<{ vars: Record<string, string>; secrets: string[] } | undefined> {
    try {
      const { bindings = [] } = await this.request<{ bindings?: Array<{ type: string; name: string; text?: string }> }>("GET", `${this.account}/workers/scripts/${script}/settings`);
      return { vars: Object.fromEntries(bindings.filter((binding) => binding.type === "plain_text").map((binding) => [binding.name, binding.text ?? ""])),
        secrets: bindings.filter((binding) => binding.type === "secret_text").map((binding) => binding.name) };
    } catch (error) { if (error instanceof CloudflareError && (error.missing || error.codes.includes(10007))) return undefined; throw error; }
  }
}

/** A resource key that limits a token to one bucket (default jurisdiction). */
export const bucketResource = (accountId: string, bucket: string) => `com.cloudflare.edge.r2.bucket.${accountId}_default_${bucket}`;
export const r2Endpoint = (accountId: string) => `https://${accountId}.r2.cloudflarestorage.com`;
