import { ApiError, request } from "./http";

/**
 * The owner's console session. The only login is the edge identity (Cloudflare Access): the console holds no token,
 * so `token` is always empty, requests carry no bearer and Cloudflare adds the JWT from the Access cookie.
 */
export interface Session { token: ""; owner: string; edge: EdgeLogin }
export interface EdgeLogin { logoutUrl: string; email?: string; expiresAt?: string }
/** `/_mau/v1/info`. Only `login:"edge"` opens the console. */
export type MauInfo = { login?: string; logoutUrl?: string };
export type Boot =
  | { mode: "edge"; session: Session }
  | { mode: "edge-denied"; email?: string; logoutUrl: string }
  | { mode: "edge-failed"; code: string };

/** Only a same-origin path is followed for the Access logout. */
const logoutPath = (value: unknown) => typeof value === "string" && /^\/[^/\\]/.test(value) ? value : "/cdn-cgi/access/logout";

/**
 * Console boot (agent-router ADR 0005 18.3): the account is read with the same-origin Access cookie only. A service
 * without an edge identity has no web login (`web_login_unavailable`); a failed request offers a retry.
 */
export async function bootSession(): Promise<Boot> {
  let info: MauInfo;
  try { info = await request<MauInfo>("/_mau/v1/info"); }
  catch (error) { return { mode: "edge-failed", code: error instanceof ApiError ? error.code : "request_failed" }; }
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
/** "重新登录": keep unsent composer text per chat in sessionStorage, then reload so Access signs the owner in again. */
export function reloadForAccess() {
  globalThis.dispatchEvent(new Event(beforeAccessReloadEvent));
  location.reload();
}
export function saveReloadDrafts(drafts: Record<string, string>, storage: Storage = sessionStorage) {
  const kept = Object.fromEntries(Object.entries(drafts).filter(([, text]) => text.trim()));
  if (Object.keys(kept).length) storage.setItem(draftsKey, JSON.stringify(kept));
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

/** Sign out through the edge: Access ends its session at the logout URL. */
export function logout(session: Session) {
  location.assign(session.edge.logoutUrl);
}
