import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Request, Response } from "express";
import { loadConfig, startConfigured, type Started } from "@olorinm/agent-connectors";
import { RouterError } from "@agent-router/server";
import { DurableStore } from "./store.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Flow = { nonce: string; expires: number };

/** Product composition of the public connector runtime; only the OAuth callback is public. */
export class ConnectorRuntime {
  private running: Started | undefined;
  constructor(private readonly file: string, private readonly endpoint: string, private readonly publicOrigin: string,
    private readonly store: DurableStore) {}
  async start() {
    if (this.running) return;
    const config = loadConfig(this.file), url = new URL(this.endpoint);
    if (config.listen.host !== "127.0.0.1" || url.origin !== `http://127.0.0.1:${config.listen.port}` ||
      config.oauthRedirectUrl !== this.publicOrigin + "/oauth/callback") throw new Error("connector_runtime_configuration_mismatch");
    this.running = await startConfigured(resolve(this.file));
  }
  async close() { await this.running?.close(); this.running = undefined; }
  bind(authorizationUrl: string, res: Response) {
    const states = new URL(authorizationUrl).searchParams.getAll("state");
    if (states.length !== 1 || !states[0] || states[0].length > 256) throw new RouterError("connector_consent_state_invalid", 502);
    const id = hash(states[0]), nonce = randomBytes(32).toString("base64url"), now = Date.now();
    for (const entry of this.store.entries<Flow>("connector_oauth"))
      if (entry.value.expires <= now) this.store.delete("connector_oauth", entry.id);
    this.store.set("connector_oauth", id, { nonce: hash(nonce), expires: now + 600_000 });
    res.cookie("mau_oauth_" + id.slice(0, 20), nonce, this.cookieOptions());
  }
  private cookieOptions() { return { httpOnly: true, secure: this.publicOrigin.startsWith("https:"), sameSite: "lax" as const, path: "/oauth/callback", maxAge: 600_000 }; }
  async callback(req: Request, res: Response) {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    if (!this.running) throw new RouterError("connector_service_not_configured", 503);
    if (req.headers.origin) throw new RouterError("oauth_origin_refused", 403);
    const query = new URL(req.originalUrl, this.publicOrigin).searchParams;
    const state = query.get("state"), code = query.get("code");
    if (!state || state.length > 256 || query.getAll("state").length !== 1 || query.getAll("code").length > 1 ||
      query.getAll("error").length > 1 || (code && code.length > 4096) || (!code && !query.has("error")) || (code && query.has("error")))
      throw new RouterError("oauth_callback_invalid", 400);
    const id = hash(state), cookieName = "mau_oauth_" + id.slice(0, 20), flow = this.store.get<Flow>("connector_oauth", id);
    const cookies = (req.headers.cookie ?? "").split(";").map(c => c.trim()).filter(c => c.startsWith(cookieName + "="));
    if (!flow || flow.expires <= Date.now() || cookies.length !== 1 || hash(cookies[0]!.slice(cookieName.length + 1)) !== flow.nonce)
      throw new RouterError("oauth_browser_mismatch_or_expired", 403);
    this.store.delete("connector_oauth", id);
    res.clearCookie(cookieName, { ...this.cookieOptions(), maxAge: undefined });
    let outcome = code ? "connected" : "cancelled";
    try { await this.running.service.oauthCallback(state, code ?? undefined, AbortSignal.timeout(60_000)); }
    catch { outcome = "failed"; }
    // The UI checks authoritative account state after return; a query flag is never proof of authorization.
    res.redirect(303, "/?view=connectors&oauth=" + outcome);
  }
}
