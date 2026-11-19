import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { RouterError, type ServiceConfig } from "@agent-router/server";

const digest = (value: string) => createHash("sha256").update(value).digest();
/** The one owner of a Mau in local mode. */
export const localOwner = (serverName: string) => `@owner:${serverName}`;

/**
 * Local mode (`MAU_LOCAL_TOKEN_FILE`): Mau on its owner's own machine, without Cloudflare Access. The one owner signs
 * in with the token in a private file, sent as a bearer header. It is refused unless the service listens on a
 * loopback address only and has no edge identity, so it cannot become the login of a service others can reach.
 */
export function localLogin(tokenFile: string, host: string, config: ServiceConfig, optionsFile: string): (token: string) => Promise<string> {
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("local_mode_requires_loopback");
  if (config.edgeIdentity || (JSON.parse(readFileSync(optionsFile, "utf8")) as { edgeIdentity?: unknown }).edgeIdentity !== undefined)
    throw new Error("local_mode_excludes_edge_identity");
  if ((statSync(tokenFile).mode & 0o077) !== 0) throw new Error("local_token_file_not_private");
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error("local_token_invalid");
  const expected = digest(token), owner = localOwner(config.serverName);
  // Digests have one length, so the comparison takes the same time whatever was sent.
  return async sent => {
    if (!timingSafeEqual(digest(sent), expected)) throw new RouterError("account_session_invalid", 401);
    return owner;
  };
}
