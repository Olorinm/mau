import { ApiError, request } from "./http";

/**
 * The owner's console session. Behind the edge identity (Cloudflare Access) the console holds no token: `token` is
 * empty, requests carry no bearer and Cloudflare adds the JWT from the Access cookie. A service in local mode
 * (`mau local`) has no edge: the console holds its owner token for this tab and sends it as the bearer.
 */
export interface Session { token: string; owner: string; edge?: EdgeLogin }
export interface EdgeLogin { logoutUrl: string; email?: string; expiresAt?: string }
/** `/_mau/v1/info`. `login:"edge"` and `login:"local"` open the console. */
export type MauInfo = { login?: string; logoutUrl?: string };
export type Boot =
  | { mode: "edge" | "local"; session: Session }
  | { mode: "edge-denied"; email?: string; logoutUrl: string }
  | { mode: "edge-failed"; code: string };

/** Only a same-origin path is followed for the Access logout. */
const logoutPath = (value: unknown) => typeof value === "string" && /^\/[^/\\]/.test(value) ? value : "/cdn-cgi/access/logout";

const localTokenKey = "mau.localToken";
/**
 * The local owner token. `mau local` prints the console's address with the token in its fragment, which a browser
 * sends to no server. It is moved to this tab's sessionStorage and taken out of the address at once.
 */
function localToken(storage: Storage): string | undefined {
  const given = new URLSearchParams(location.hash.slice(1)).get("token");
  if (given && /^[A-Za-z0-9_-]{32,}$/.test(given)) {
    storage.setItem(localTokenKey, given);
    history.replaceState(history.state, "", location.pathname + location.search);
  }
  return storage.getItem(localTokenKey) ?? undefined;
}

/**
 * Console boot (agent-router ADR 0005 18.3). Edge: the account is read with the same-origin Access cookie only.
 * Local: with the owner token, and without it the console says where the token comes from (`local_token_required`).
 * A service with neither login has no web login (`web_login_unavailable`); a failed request offers a retry.
 */
export async function bootSession(): Promise<Boot> {
  let info: MauInfo;
  try { info = await request<MauInfo>("/_mau/v1/info"); }
  catch (error) { return { mode: "edge-failed", code: error instanceof ApiError ? error.code : "request_failed" }; }
  if (info.login === "local") {
    const storage = sessionStorage, token = localToken(storage);
    if (!token) return { mode: "edge-failed", code: "local_token_required" };
    try {
      const account = await request<{ owner?: unknown }>("/_mau/v1/account", { token, credentials: "omit" });
      return typeof account.owner === "string" ? { mode: "local", session: { token, owner: account.owner } } : { mode: "edge-failed", code: "invalid_account_response" };
    } catch (error) {
      // A token the service refuses is of another local directory, or of one that was made again.
      if (error instanceof ApiError && error.status === 401) { storage.removeItem(localTokenKey); return { mode: "edge-failed", code: "local_token_required" }; }
      return { mode: "edge-failed", code: error instanceof ApiError ? error.code : "request_failed" };
    }
  }
  if (info.login !== "edge") return { mode: "edge-failed", code: "web_login_unavailable" };
  const logoutUrl = logoutPath(info.logoutUrl);
  try {
    const account = await request<{ owner?: unknown; email?: unknown; expiresAt?: unknown }>("/_mau/v1/account");
    if (typeof account.owner !== "string") return { mode: "edge-failed", code: "invalid_account_response" };
    return { mode: "edge", session: { token: "", owner: account.owner, edge: { logoutUrl,
      ...(typeof account.email === "string" ? { email: account.email } : {}),
      ...(typeof account.expiresAt === "string" ? { expiresAt: account.expiresAt } : {}) } } };
  } catch (error) {
    if (error instanceof ApiError && error.code === "owner_not_configured")
      return { mode: "edge-denied", logoutUrl, ...(error.details.email ? { email: error.details.email } : {}) };
    return { mode: "edge-failed", code: error instanceof ApiError ? error.code : "request_failed" };
  }
}

const draftsKey = "mau.reloadDrafts";
/** Fired before the console reloads to renew an expired Access session; open composers save their text then. */
export const beforeAccessReloadEvent = "mau:before-access-reload";
/** "重新登录": keep unsent composer text per chat in sessionStorage, then reload so the owner is signed in again. */
export function reloadForAccess() {
  globalThis.dispatchEvent(new Event(beforeAccessReloadEvent));
  location.reload();
}
export function saveReloadDrafts(drafts: Record<string, string>, storage: Storage = sessionStorage) {
  const kept = Object.fromEntries(Object.entries(drafts).filter(([, text]) => text.trim()));
  if (Object.keys(kept).length) storage.setItem(draftsKey, JSON.stringify(kept));
}
const replyKeysKey = "mau.reloadReplyKeys";
/** What was sent in a thread and not answered for: the words, and the key they were sent under (`replyInSession`). */
export type ReplyKeys = Record<string, { text: string; key: string }>;
/**
 * Kept with the drafts across the reload: a reply the server may already have taken is sent again under the same key
 * after the owner has signed in again, and so is the same message.
 */
export function saveReloadReplyKeys(keys: ReplyKeys, storage: Storage = sessionStorage) {
  if (Object.keys(keys).length) storage.setItem(replyKeysKey, JSON.stringify(keys));
}
/** Reply keys saved by `reloadForAccess`; `clear` removes them once restored. */
export function reloadReplyKeys(storage: Storage = sessionStorage, clear = false): ReplyKeys {
  try {
    const value = JSON.parse(storage.getItem(replyKeysKey) ?? "{}") as unknown;
    if (clear) storage.removeItem(replyKeysKey);
    return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, { text: string; key: string }] => {
      const item = entry[1] as { text?: unknown; key?: unknown } | null;
      return !!item && typeof item.text === "string" && typeof item.key === "string";
    })) : {};
  } catch { return {}; }
}
/** Drafts saved by `reloadForAccess`; `clear` removes them once restored. */
export function reloadDrafts(storage: Storage = sessionStorage, clear = false): Record<string, string> {
  try {
    const value = JSON.parse(storage.getItem(draftsKey) ?? "{}") as unknown;
    if (clear) storage.removeItem(draftsKey);
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  } catch { return {}; }
}

/** Sign out. Edge: Access ends its session at the logout URL. Local: this tab forgets the owner token. */
export function logout(session: Session) {
  if (session.edge) { location.assign(session.edge.logoutUrl); return; }
  sessionStorage.removeItem(localTokenKey);
  location.reload();
}
