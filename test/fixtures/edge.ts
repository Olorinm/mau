// A stand-in for the Cloudflare edge in front of Mau, and the built CLI run against it. Cloudflare Access turns the
// credentials a client sends (`cf-access-token`, or a service token's id and secret) into the signed JWT header the
// service verifies; the CLI never has that JWT itself.
import { createServer, request } from "node:http";
import { once } from "node:events";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** The Access token that stands for alice's signed-in session. */
export const aliceToken = "alice-access-token";

export async function edgeProxy(cleanup: Array<() => unknown>, upstream: () => string, jwt: (claims?: Record<string, unknown>) => string) {
  const server = createServer((req, res) => {
    const { "cf-access-token": token, "cf-access-jwt-assertion": _forged, ...headers } = req.headers;
    const target = new URL(req.url ?? "/", upstream());
    const forward = request(target, { method: req.method, headers: { ...headers, ...(token === aliceToken ? { "cf-access-jwt-assertion": jwt() } : {}) } }, answer => {
      res.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(res);
    });
    forward.on("error", () => { res.writeHead(502).end(); });
    req.pipe(forward);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

export interface CliRun { code: number; stdout: string; stderr: string;
  /** stdout as JSON: the result of a command that succeeded. */
  json: any;
  /** The JSON object on the last stderr line: the failure of a command that failed. */
  error: any }
/** Builds the CLI from source into a temporary directory and runs it with its own session directory. */
export function builtCli(cleanup: Array<() => unknown>, environment: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mau-cli-test-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.json"), "--outDir", join(directory, "dist"), "--declaration", "false", "--sourceMap", "false"], { stdio: "pipe" });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module", version: "0.0.0-test" }));
  // No `cloudflared` on PATH and no credentials inherited from the developer's shell.
  const env: Record<string, string> = { PATH: "/nonexistent", HOME: directory, MAU_CONFIG_DIR: join(directory, "config"), ...environment };
  return async (...args: string[]): Promise<CliRun> => {
    const run = await promisify(execFile)(process.execPath, [join(directory, "dist/cli.js"), ...args], { env }).then(
      result => ({ code: 0, ...result }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? -1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
    const parse = (text: string | undefined) => { try { return JSON.parse(text ?? ""); } catch { return undefined; } };
    return { ...run, json: parse(run.stdout), error: run.code === 0 ? undefined : parse(run.stderr.trimEnd().split("\n").at(-1)) };
  };
}
