import { ApiError, request } from "./http";

/** Router/Matrix account session. Mau never issues a second identity. */
export interface Session { token: string; owner: string; homeserver?: string }
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

/** Revoke a password-login device; a pasted token belongs to whoever issued it. */
export async function logout(session: Session) {
  if (session.homeserver)
    await request(session.homeserver + "/_matrix/client/v3/logout", { token: session.token, body: {} }).catch(() => undefined);
  clearSession();
}
