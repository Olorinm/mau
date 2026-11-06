import { ApiError, request } from "./http";
import type { Session } from "./session";

/**
 * The Matrix password and token login of the console. Loaded only through a dynamic import for `login:"matrix"`
 * (agent-router ADR 0005 19.3), so a console without Matrix never contains a Matrix request.
 */
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

/** Revoke the Matrix device of a password login. */
export async function matrixLogout(session: Session) {
  if (session.homeserver) await request(session.homeserver + "/_matrix/client/v3/logout", { token: session.token, body: {} }).catch(() => undefined);
}
