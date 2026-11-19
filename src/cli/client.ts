import { readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { privateFile } from "../files.js";
import { CliError, fail, type OptionValues, type Option } from "./command.js";

export const mau = "/_mau/v1", router = "/_agent-router/v1";
const sessionFile = () => join(process.env.MAU_CONFIG_DIR ?? join(homedir(), ".config", "mau"), "session.json");
/** The service the CLI is signed in to. No credential is stored: Cloudflare Access credentials are read on every run. */
interface Session { url: string; owner: string }

/** Options every command takes: where the Cloudflare Access credentials come from. */
export const accessOptions: Record<string, Option> = {
  "access-client-id-file": { type: "string", value: "FILE", help: "Access service token: the file with its client id (or CF_ACCESS_CLIENT_ID[_FILE])." },
  "access-client-secret-file": { type: "string", value: "FILE", help: "Access service token: the file with its client secret (or CF_ACCESS_CLIENT_SECRET[_FILE])." },
  "access-token-file": { type: "string", value: "FILE", help: "The file with an Access token (or CF_ACCESS_TOKEN[_FILE]); otherwise `cloudflared access token` is asked." },
};

/** The one line of a secret file. Secrets are never taken from argument values. */
export function secretFile(path: string | undefined, required: string): string {
  if (!path) return fail(required);
  let value: string;
  try { value = readFileSync(path, "utf8").trim(); } catch { return fail("credential_file_unreadable"); }
  if (!value || value.length > 16384) return fail("invalid_credential_file");
  return value;
}
/** One non-empty line from a file, or from an environment variable (`NAME_FILE` names a file). */
function configured(file: string | undefined, name: string): string | undefined {
  const path = file ?? process.env[name + "_FILE"];
  let value: string | undefined;
  try { value = path ? readFileSync(path, "utf8").trim() : process.env[name]?.trim(); } catch { return fail("credential_file_unreadable"); }
  if (value === undefined || value === "") return undefined;
  if (value.length > 16384 || /[\r\n\0]/.test(value)) return fail("invalid_credential_file");
  return value;
}
/** `https://host`, or `http://` for a loopback host: nothing else carries the owner's credentials. */
export function serviceUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { return fail("invalid_service_url"); }
  if (url.username || url.password || url.hash || url.search || url.pathname !== "/" ||
      !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    return fail("invalid_service_url");
  return url.origin;
}
/**
 * Cloudflare Access credentials (agent-router ADR 0005 18.3): an Access service token (client id and secret), an Access
 * token, or `cloudflared access token -app=URL` after `cloudflared access login URL`. `Origin` is the service's own
 * origin: Router accepts unsafe edge requests only with an allowed Origin (its CSRF guard).
 */
function accessHeaders(url: string, options: OptionValues): Record<string, string> {
  const file = (name: string) => typeof options[name] === "string" ? options[name] : undefined;
  const id = configured(file("access-client-id-file"), "CF_ACCESS_CLIENT_ID"), secret = configured(file("access-client-secret-file"), "CF_ACCESS_CLIENT_SECRET");
  if (!id !== !secret) return fail("access_service_token_requires_client_id_and_secret");
  if (id && secret) return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret, Origin: url };
  let token = configured(file("access-token-file"), "CF_ACCESS_TOKEN");
  if (!token) {
    try { token = execFileSync("cloudflared", ["access", "token", "-app=" + url], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }).trim(); }
    catch { token = undefined; }
  }
  if (!token || /\s/.test(token)) return fail("access_credentials_required");
  return { "cf-access-token": token, Origin: url };
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface Reply { status: number; data: any; headers: Headers }
export interface Partner { id: string; name: string }

export class Client {
  private resolved?: Record<string, string>;
  private constructor(readonly url: string, private readonly options: OptionValues, private readonly signal: AbortSignal) {}

  /** Sign in: the service accepts the Access credentials, and the URL is saved for the following commands. */
  static async login(raw: string, options: OptionValues, signal: AbortSignal) {
    const client = new Client(serviceUrl(raw), options, signal), account = await client.get(mau + "/account");
    if (typeof account?.owner !== "string") return fail("invalid_account_response");
    privateFile(sessionFile(), { url: client.url, owner: account.owner } satisfies Session);
    return { owner: account.owner as string, url: client.url };
  }
  static logout() { rmSync(sessionFile(), { force: true }); }
  static session(options: OptionValues, signal: AbortSignal) {
    let session: Session;
    try { session = JSON.parse(readFileSync(sessionFile(), "utf8")); } catch { return fail("login_required"); }
    if (typeof session?.url !== "string") return fail("login_required");
    return new Client(serviceUrl(session.url), options, signal);
  }

  /** The headers that authenticate the owner, read once per run. */
  headers() { return this.resolved ??= accessHeaders(this.url, this.options); }

  /** One request. An answer that is not JSON, or no answer, is a failure; an HTTP error status is returned. */
  async call(method: Method, path: string, body?: unknown, timeoutMs = 30_000): Promise<Reply> {
    const headers = this.headers();
    let response: Response;
    try {
      response = await fetch(this.url + path, {
        method, redirect: "error", credentials: "omit",
        headers: { Accept: "application/json", ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      if (this.signal.aborted) return fail("interrupted");
      return fail(error instanceof Error && error.name === "TimeoutError" ? "request_timed_out" : "service_unreachable", { method, path });
    }
    if (response.status === 204) return { status: 204, data: null, headers: response.headers };
    const data: unknown = await response.json().catch(() => fail("invalid_response", { httpStatus: response.status, method, path }));
    return { status: response.status, data, headers: response.headers };
  }
  /** The JSON answer, or the server's error as it gave it: its code, its other members, and the HTTP status. */
  async request(method: Method, path: string, body?: unknown, timeoutMs?: number): Promise<any> {
    return this.result(await this.call(method, path, body, timeoutMs));
  }
  result(reply: Reply): any {
    if (reply.status >= 200 && reply.status < 300) return reply.data;
    const { error, ...fields } = reply.data && typeof reply.data === "object" && !Array.isArray(reply.data) ? reply.data as Record<string, unknown> : {};
    throw new CliError(typeof error === "string" && /^[a-z0-9_]+$/.test(error) ? error : "request_failed", { ...fields, httpStatus: reply.status });
  }
  get(path: string, timeoutMs?: number) { return this.request("GET", path, undefined, timeoutMs); }
  post(path: string, body: unknown = {}, timeoutMs?: number) { return this.request("POST", path, body, timeoutMs); }
  put(path: string, body: unknown, timeoutMs?: number) { return this.request("PUT", path, body, timeoutMs); }
  delete(path: string, timeoutMs?: number) { return this.request("DELETE", path, undefined, timeoutMs); }

  /** The owner's partners by name. Names are unique for an owner. */
  async partners(): Promise<Array<Partner & { summary: any }>> {
    const listed = await this.get(mau + "/agents");
    return listed.data.map((summary: any) => ({ id: summary.agent.id, name: summary.agent.name, summary }));
  }
  async partner(name: string): Promise<Partner & { summary: any }> {
    return (await this.partners()).find(partner => partner.name === name) ?? fail("partner_not_found", { name });
  }
  wait(ms: number) { return delay(ms, undefined, { signal: this.signal }).catch(() => fail("interrupted")); }
}
/** Path of one partner under a service root. */
export const agentPath = (root: string, id: string) => `${root}/agents/${encodeURIComponent(id)}`;
