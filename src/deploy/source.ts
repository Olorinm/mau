// What a deployment is built from: this checkout, the Agent Kit release it pins, the pinned Wrangler beside the
// Worker, and the Cloudflare credentials of whoever runs it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Runtime } from "./effects.js";
import type { Credentials } from "./cloudflare.js";

/** A failure with a stable code, what was seen, and what to do about it. */
export class DeployError extends Error {
  constructor(readonly code: string, readonly detail?: string, readonly fix?: string) { super(code); }
}

export interface Pin { repository: string; version: string; revision: string; integrity: Record<string, string> }
const COMPONENTS = ["host", "router", "connectors", "environment"] as const;

/** What `mau deploy` and `mau local` need of the checkout they run from. */
const CHECKOUT = {
  deploy: ["Dockerfile", "components.json", "cloudflare/src/index.ts", "cloudflare/wrangler.example.jsonc", "examples/mau.json"],
  local: ["components.json", "examples/mau.json", "examples/cloud/host-profile.json", "dist/main.js"],
};
const clone = (command: keyof typeof CHECKOUT) => `git clone https://github.com/Olorinm/mau && cd mau && node scripts/bootstrap.mjs && npm run build && node dist/cli.js ${command}`;

/** The `age` release the environment gateway installs into a sandbox to encrypt its backups (linux/amd64). */
export const AGE = {
  version: "1.3.2",
  url: "https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz",
  archiveSha256: "cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10",
  binarySha256: "eb7dd1b518f0a307c99cd97782623c5321da049154b04acd2d98d21aa7bc9b2c",
  key: "artifacts/age-v1.3.2-linux-amd64",
};

export class Source {
  constructor(private readonly runtime: Runtime) {}
  get root() { return this.runtime.root; }
  path(...parts: string[]) { return join(this.root, ...parts); }
  archive(component: (typeof COMPONENTS)[number]) { return this.path(".packages", `agent-${component}.tgz`); }
  get wranglerBinary() { return this.path("cloudflare", "node_modules", ".bin", "wrangler"); }

  /**
   * A deployment builds the image and the Worker from source, and `mau local` runs the server from it; an installed
   * client archive has neither.
   */
  assertCheckout(command: keyof typeof CHECKOUT = "deploy") {
    for (const file of CHECKOUT[command])
      if (!existsSync(this.path(file))) throw new DeployError(`${command}_requires_source_checkout`, `${file} is not beside this program`, clone(command));
  }
  /** `examples/start-host.sh` of the pinned environment package, as `npm ci` installed it. */
  get startHost() { return this.path("node_modules", "@olorinm", "agent-environment", "cloudflare", "examples", "start-host.sh"); }
  get officialSkills() { return join(this.startHost, "..", "official-skills.tgz"); }
  pin(): Pin { return JSON.parse(readFileSync(this.path("components.json"), "utf8")) as Pin; }
  /** The components whose archive is absent or is not the pinned bytes. */
  staleArchives(pin: Pin) {
    return COMPONENTS.filter((component) => !existsSync(this.archive(component)) ||
      "sha512-" + createHash("sha512").update(readFileSync(this.archive(component))).digest("base64") !== pin.integrity[component]);
  }
  /** The commit of this checkout, marked when files differ from it. */
  async revision(): Promise<string> {
    const git = (args: string[]) => this.runtime.effects.run("git", ["-C", this.root, ...args]);
    const head = await git(["rev-parse", "HEAD"]);
    if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) throw new DeployError("deploy_requires_source_checkout", "this directory is not a git checkout", clone("deploy"));
    return head.stdout.trim() + ((await git(["status", "--porcelain"])).stdout.trim() ? "-dirty" : "");
  }

  /** Runs the pinned Wrangler for one account, without a terminal: it never asks. */
  wrangler(args: string[], accountId?: string, timeoutMs = 120_000) {
    // Secrets go in with --secrets-file; a variable of the same name in this environment would replace the file's value.
    return this.runtime.effects.run(this.wranglerBinary, args, { cwd: this.path("cloudflare"), timeoutMs,
      env: { ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}), WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0",
        R2_ACCESS_KEY_ID: undefined, R2_SECRET_ACCESS_KEY: undefined, CONTROL_TOKEN: undefined, ACCESS_SIGNING_KEY: undefined } });
  }

  /** `CLOUDFLARE_API_TOKEN` when set, otherwise the token of the local `wrangler login`. */
  async credentials(): Promise<Credentials> {
    const fix = `Set CLOUDFLARE_API_TOKEN (permissions: docs/deployment.md), or run: ${this.wranglerBinary} login`;
    const token = this.runtime.env.CLOUDFLARE_API_TOKEN?.trim();
    if (token) return { token, source: "api-token" };
    if (!existsSync(this.wranglerBinary)) throw new DeployError("cloudflare_credentials_required", "CLOUDFLARE_API_TOKEN is not set and Wrangler is not installed yet", `npm --prefix ${this.path("cloudflare")} ci, then: ${fix}`);
    // `wrangler auth token --json` prints { type, token }; an OAuth token is refreshed when it has expired.
    const result = await this.wrangler(["auth", "token", "--json"]);
    let parsed: { type?: string; token?: string } = {};
    try { parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as typeof parsed; } catch { /* reported below */ }
    if (result.code !== 0 || !parsed.token || parsed.type === "api_key") throw new DeployError("cloudflare_credentials_required", "Wrangler is not logged in", fix);
    return { token: parsed.token, source: parsed.type === "oauth" ? "wrangler-login" : "api-token" };
  }
}

/** JSON with `//` and block comments and trailing commas, as Wrangler's example files are written. */
export function parseJsonc(text: string): unknown {
  let out = "", inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!, next = text[i + 1];
    if (inString) { out += c; if (c === "\\") out += text[++i] ?? ""; else if (c === '"') inString = false; }
    else if (c === '"') { inString = true; out += c; }
    else if (c === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; }
    else if (c === "/" && next === "*") { i = text.indexOf("*/", i + 2); if (i < 0) break; i++; }
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** What can be said about a Codex sign-in file without showing any of it. */
export function inspectCodexAuth(bytes: Uint8Array, now = Date.now()): { ok: boolean; detail: string } {
  let auth: { OPENAI_API_KEY?: unknown; tokens?: { access_token?: unknown; refresh_token?: unknown } };
  try { auth = JSON.parse(Buffer.from(bytes).toString("utf8")) as typeof auth; } catch { return { ok: false, detail: "not a JSON document" }; }
  const { access_token: access, refresh_token: refresh } = auth?.tokens ?? {};
  if (typeof access !== "string" || !access) {
    return typeof auth?.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY ? { ok: true, detail: "signed in with an API key" } : { ok: false, detail: "holds no sign-in" };
  }
  let expires: number | undefined;
  try { expires = (JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number }).exp; } catch { /* not a JWT */ }
  const when = typeof expires === "number" ? `access token expires ${new Date(expires * 1000).toISOString()}` : "access token expiry unknown";
  const renewable = typeof refresh === "string" && refresh.length > 0;
  if (typeof expires === "number" && expires * 1000 < now && !renewable) return { ok: false, detail: `${when} and there is no refresh token` };
  return { ok: true, detail: `signed in with ChatGPT; ${when}${renewable ? "; refreshed by Codex when used" : ""}` };
}
