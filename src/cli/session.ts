import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateFile } from "../files.js";

/**
 * The service the CLI is signed in to. A Cloudflare Access login stores no credential: those are read on every run. A
 * local login (`mau local`) names the file with the local service's owner token, which is read on every request.
 */
export type Session = { url: string; owner: string } | { url: string; owner: string; login: "local"; tokenFile: string };
export type LocalSession = Extract<Session, { login: "local" }>;

export const configDirectory = (env: Record<string, string | undefined> = process.env, home = homedir()) => env.MAU_CONFIG_DIR ?? join(home, ".config", "mau");
const sessionFile = (env?: Record<string, string | undefined>, home?: string) => join(configDirectory(env, home), "session.json");
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
/** Whether a service URL is on this machine. Only such a service is given a local token, and only such a URL goes without TLS. */
export const isLoopback = (url: URL) => LOOPBACK.includes(url.hostname);

export function readSession(env?: Record<string, string | undefined>, home?: string): Session | undefined {
  let session: Record<string, unknown>;
  try { session = JSON.parse(readFileSync(sessionFile(env, home), "utf8")) as Record<string, unknown>; } catch { return undefined; }
  const { url, owner, login, tokenFile } = session ?? {};
  if (typeof url !== "string" || typeof owner !== "string" || !URL.canParse(url)) return undefined;
  if (login === undefined) return { url, owner };
  return login === "local" && typeof tokenFile === "string" && isLoopback(new URL(url)) ? { url, owner, login, tokenFile } : undefined;
}
export const writeSession = (session: Session, env?: Record<string, string | undefined>, home?: string) => privateFile(sessionFile(env, home), session);
export const removeSession = () => rmSync(sessionFile(), { force: true });
/** The bearer header of a local login, or nothing when its token file cannot be read. */
export function localHeaders(session: LocalSession): Record<string, string> | undefined {
  let token: string;
  try { token = readFileSync(session.tokenFile, "utf8").trim(); } catch { return undefined; }
  return /^[A-Za-z0-9_-]{32,}$/.test(token) ? { Authorization: "Bearer " + token } : undefined;
}
