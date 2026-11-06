import { ApiError, request } from "./http";

/**
 * Router/Matrix account session. Mau never issues a second identity. With edge login (Cloudflare Access) the console
 * holds no token: `token` is empty, requests carry no bearer and Cloudflare adds the JWT from the Access cookie.
 */
export interface Session { token: string; owner: string; homeserver?: string; edge?: EdgeLogin }
export interface EdgeLogin { logoutUrl: string; email?: string; expiresAt?: string }
/** `/_mau/v1/info`: `login:"edge"` (no login page) or the legacy Matrix password login. */
export type MauInfo = { login: "edge"; logoutUrl: string; matrix: false } | { login?: "matrix"; homeserver: string; matrix?: true };
export type Boot =
  | { mode: "matrix"; session: Session | null }
  | { mode: "edge"; session: Session }
  | { mode: "edge-denied"; email?: string; logoutUrl: string }
  | { mode: "edge-failed"; code: string };
const key = "mau.session";

export function loadSession(storage: Storage = localStorage): Session | null {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "null") as Partial<Session> | null;
    return typeof value?.token === "string" && typeof value.owner === "string"
      ? { token: value.token, owner: value.owner, ...(typeof value.homeserver === "string" ? { homeserver: value.homeserver } : {}) }
      : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session, storage: Storage = localStorage) {
  storage.setItem(key, JSON.stringify(session));
}

export function clearSession(storage: Storage = localStorage) {
  storage.removeItem(key);
}

/** Only a same-origin path is followed for the Access logout. */
const logoutPath = (value: unknown) => typeof value === "string" && /^\/[^/\\]/.test(value) ? value : "/cdn-cgi/access/logout";

/**
 * Console boot (agent-router ADR 0005 18.3). With `login:"edge"` any stored Matrix session is removed and the account is
 * read with the same-origin Access cookie only; otherwise the stored Matrix session (or the login page) is used.
 */
export async function bootSession(storage: Storage = localStorage): Promise<Boot> {
  const info = await request<MauInfo>("/_mau/v1/info").catch(() => undefined);
  if (info?.login !== "edge") return { mode: "matrix", session: loadSession(storage) };
  clearSession(storage);
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

async function verify(token: string, homeserver?: string): Promise<Session> {
  const { owner } = await request<{ owner: string }>("/_mau/v1/account", { token });
  if (typeof owner !== "string") throw new ApiError("invalid_account_response", 200);
  return { token, owner, ...(homeserver ? { homeserver } : {}) };
}

/** Same sequence as `mau login`: public homeserver → Matrix password login → Mau account. */
export async function loginWithPassword(user: string, password: string): Promise<Session> {
  const { homeserver } = await request<{ homeserver: string }>("/_mau/v1/info");
  const origin = new URL(homeserver).origin;
  const login = await request<{ access_token?: unknown }>(origin + "/_matrix/client/v3/login", {
    body: {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: user.trim() },
      password,
      initial_device_display_name: "Mau Web",
    },
  });
  if (typeof login.access_token !== "string") throw new ApiError("invalid_login_response", 200);
  return verify(login.access_token, origin);
}

export function loginWithToken(token: string): Promise<Session> {
  return verify(token.trim());
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

/** Revoke a password-login device; a pasted token belongs to whoever issued it. */
export async function logout(session: Session) {
  if (session.edge) { location.assign(session.edge.logoutUrl); return; }
  if (session.homeserver)
    await request(session.homeserver + "/_matrix/client/v3/logout", { token: session.token, body: {} }).catch(() => undefined);
  clearSession();
}
