// Local mode: Mau on its owner's machine, signed in with one token instead of Cloudflare Access. The server side is
// tested in process; `mau local` is run as the built CLI from a checkout, with a stand-in for the Docker engine.
import { afterEach, expect, it } from "vitest";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createMau } from "../src/app.js";
import { localLogin } from "../src/local-login.js";
import { connectSshTunnel } from "../src/ssh-transport.js";
import { builtCli, type CliRun } from "./fixtures/edge.js";
import { codexAuth } from "./fixtures/deployment.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = () => { const d = mkdtempSync(join(tmpdir(), "mau-local-test-")); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; };
const token = "local-owner-token-of-the-test-0123456789abc", config = { serverName: "localhost", publicUrl: "http://127.0.0.1:8790/_agent-router/v1", stateDir: "unused" };
const profile = { id: "codex", label: "Codex", owners: ["@owner:localhost"], provider: "local", template: "node24", kernel: "codex", runtimeId: "personal", hostConfigFile: "host.json" };

/** A directory with a token file and the options of a Mau without an edge identity. */
function localFiles(options: Record<string, unknown> = {}) {
  const directory = temporary(), tokenFile = join(directory, "token"), optionsFile = join(directory, "mau.json");
  writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
  writeFileSync(optionsFile, JSON.stringify({ environments: { configFile: "providers.json", profiles: [profile] }, ...options }));
  writeFileSync(join(directory, "host.json"), JSON.stringify({ stateDirectory: "state", runtimes: [{ id: "personal", kernel: "codex", cwd: "/home/user/workspace" }] }));
  return { directory, tokenFile, optionsFile };
}

it("local login needs a loopback address, no edge identity and a private token file, and accepts exactly its token", async () => {
  const f = localFiles(), edgeIdentity = { provider: "cloudflare-access", teamDomain: "https://example-team.cloudflareaccess.com", audiences: ["aud"] };
  for (const host of ["0.0.0.0", "::", "localhost", "192.0.2.1", ""])
    expect(() => localLogin(f.tokenFile, host, config, f.optionsFile), host).toThrow("local_mode_requires_loopback");
  expect(() => localLogin(f.tokenFile, "127.0.0.1", { ...config, edgeIdentity } as Parameters<typeof localLogin>[2], f.optionsFile)).toThrow("local_mode_excludes_edge_identity");
  expect(() => localLogin(f.tokenFile, "127.0.0.1", config, localFiles({ edgeIdentity }).optionsFile)).toThrow("local_mode_excludes_edge_identity");
  chmodSync(f.tokenFile, 0o644);
  expect(() => localLogin(f.tokenFile, "127.0.0.1", config, f.optionsFile)).toThrow("local_token_file_not_private");
  chmodSync(f.tokenFile, 0o600);
  writeFileSync(f.tokenFile, "short\n");
  expect(() => localLogin(f.tokenFile, "127.0.0.1", config, f.optionsFile)).toThrow("local_token_invalid");
  writeFileSync(f.tokenFile, token + "\n");
  for (const host of ["127.0.0.1", "::1"]) {
    const authenticate = localLogin(f.tokenFile, host, config, f.optionsFile);
    expect(await authenticate(token)).toBe("@owner:localhost");
    for (const wrong of ["", token + "x", token.slice(0, -1), token.toUpperCase()]) await expect(authenticate(wrong)).rejects.toThrow("account_session_invalid");
  }
});

it("refuses to start without an edge identity unless the process supplies its own owner login", () => {
  const f = localFiles();
  expect(() => createMau({ ...config, stateDir: join(f.directory, "state") }, f.optionsFile)).toThrow("edge_identity_required");
  expect(() => createMau({ ...config, stateDir: join(f.directory, "state") }, f.optionsFile, { router: {} })).toThrow("edge_identity_required");
});

it("serves a local Mau to the bearer of the token only: product routes, Router's routes, the event socket and the SSH upgrade", async () => {
  const f = localFiles();
  const mau = createMau({ ...config, stateDir: join(f.directory, "state") }, f.optionsFile, { router: { authenticate: localLogin(f.tokenFile, "127.0.0.1", config, f.optionsFile) },
    environments: async () => ({ provider: () => { throw new Error("no_environment_in_this_test"); } }) });
  const server = mau.app.listen(0, "127.0.0.1");
  mau.attach(server);
  await once(server, "listening");
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await mau.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, bearer = { authorization: "Bearer " + token };
  const call = async (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) => {
    const response = await fetch(base + path, { ...init, headers: { "content-type": "application/json", ...headers } });
    return { status: response.status, headers: response.headers, data: await response.json().catch(() => undefined) as any };
  };
  expect((await call("/_mau/v1/info")).data).toEqual({ login: "local" });
  expect(await call("/_mau/v1/account", bearer)).toMatchObject({ status: 200, data: { owner: "@owner:localhost", via: "bearer" } });
  expect((await call("/_mau/v1/options", bearer)).data).toEqual({ environments: [{ id: "codex", label: "Codex", kernel: "codex", kernels: ["codex"] }] });
  expect((await call("/_agent-router/v1/web/me", bearer)).data).toMatchObject({ ownerId: "@owner:localhost", auth: { via: "bearer" } });
  // Nothing a browser sends on its own signs in: no cookie, no Access header, no token in the address.
  for (const headers of [{}, { authorization: "Bearer " + token + "x" }, { cookie: `CF_Authorization=${token}; mau=${token}` }, { "cf-access-jwt-assertion": token },
    { "cf-access-token": token }, { "cf-access-authenticated-user-email": "owner@example.com" }]) {
    for (const path of ["/_mau/v1/account", "/_mau/v1/agents", "/_agent-router/v1/agents", "/_agent-router/v1/web/me", `/_mau/v1/account?token=${token}`])
      expect((await call(path, headers)).status, path).toBe(401);
    expect((await call("/_mau/v1/agents", headers, { method: "POST", body: JSON.stringify({ name: "helper", profileId: "codex" }) })).status).toBe(401);
  }
  // A page of another origin cannot send the bearer header: its preflight is answered without any CORS permission.
  const preflight = await call("/_mau/v1/agents", { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" }, { method: "OPTIONS" });
  expect(preflight.status).toBe(401);
  expect([...preflight.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
  expect([...(await call("/_mau/v1/account", { ...bearer, origin: "https://evil.example" })).headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
  // The event socket opens with a single-use ticket, which only the bearer gets.
  expect((await call("/_agent-router/v1/web/socket-tickets", {}, { method: "POST", body: "{}" })).status).toBe(401);
  const { ticket } = (await call("/_agent-router/v1/web/socket-tickets", bearer, { method: "POST", body: "{}" })).data;
  const open = (query: string) => new Promise<boolean>((resolve) => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/_agent-router/v1/web/socket${query}`);
    socket.addEventListener("open", () => { socket.close(); resolve(true); });
    socket.addEventListener("error", () => resolve(false));
  });
  expect(await open("")).toBe(false);
  expect(await open(`?ticket=${token}`)).toBe(false);
  expect(await open(`?ticket=${ticket}`)).toBe(true);
  expect(await open(`?ticket=${ticket}`)).toBe(false);
  // The SSH upgrade takes the same bearer: without it 401, with it the request fails on the unknown partner instead.
  const ssh = new URL(`${base}/_mau/v1/agents/00000000-0000-4000-8000-000000000000/ssh/${"a".repeat(64)}`);
  await expect(connectSshTunnel(ssh, {})).rejects.toThrow("account_session_invalid");
  await expect(connectSshTunnel(ssh, { Authorization: "Bearer " + token })).rejects.toThrow("ssh_connection_rejected");
});

/**
 * A checkout as `mau local` needs one: the CLI and the server built from this source, with the examples, the pin, the
 * pinned archives and the installed packages of this repository, and a `docker` that answers like a running engine.
 */
function localCheckout() {
  const root = temporary(), bin = join(root, "bin"), home = join(root, "home");
  execFileSync(process.execPath, [join(repository, "node_modules/typescript/bin/tsc"), "-p", join(repository, "tsconfig.json"), "--outDir", join(root, "dist"), "--declaration", "false", "--sourceMap", "false"], { stdio: "pipe" });
  for (const path of ["node_modules", "examples", "components.json", ".packages", "package.json"]) symlinkSync(join(repository, path), join(root, path));
  mkdirSync(bin); mkdirSync(join(home, ".codex"), { recursive: true });
  const docker = (script: string) => writeFileSync(join(bin, "docker"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  docker("echo 29.0.0");
  writeFileSync(join(home, ".codex", "auth.json"), codexAuth());
  const env = (extra: Record<string, string> = {}) => ({ PATH: bin, HOME: home, MAU_CONFIG_DIR: join(root, "config"), ...extra });
  const parse = (text: string | undefined) => { try { return JSON.parse(text ?? ""); } catch { return undefined; } };
  const run = async (args: string[], extra?: Record<string, string>): Promise<CliRun> => {
    const result = await promisify(execFile)(process.execPath, [join(root, "dist/cli.js"), ...args], { env: env(extra) }).then(
      (done) => ({ code: 0, ...done }), (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? -1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
    return { ...result, json: parse(result.stdout), error: result.code === 0 ? undefined : parse(result.stderr.trimEnd().split("\n").at(-1)) };
  };
  /** Starts `mau local` and waits for its one JSON document. */
  const start = async (args: string[], extra?: Record<string, string>) => {
    const child = spawn(process.execPath, [join(root, "dist/cli.js"), "local", ...args], { env: env(extra), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? -1)));
    cleanup.push(async () => { child.kill("SIGKILL"); await exited; });
    for (const deadline = Date.now() + 60_000; parse(stdout) === undefined;) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error("mau_local_did_not_start: " + stderr);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ready: parse(stdout), stderr: () => stderr, stdout: () => stdout, stop: async (signal: NodeJS.Signals) => { child.kill(signal); return exited; } };
  };
  return { root, home, docker, run, start };
}
const freePort = async () => {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return String(port);
};

it("mau local says precisely what this machine lacks, and changes nothing until it has it", async () => {
  // An installed client has no server to run.
  const client = await builtCli(cleanup)("local");
  expect(client).toMatchObject({ code: 1, stdout: "", error: { error: "local_requires_source_checkout", fix: expect.stringContaining("node dist/cli.js local") } });
  const c = localCheckout(), dir = join(c.root, "local"), port = await freePort();
  expect((await c.run(["local", "--dir", dir, "--port", "http"])).error).toMatchObject({ error: "invalid_port" });
  expect((await c.run(["local", "--dir", dir, "--port", port, "--codex-auth", join(c.root, "missing.json")])).error).toMatchObject({ error: "codex_sign_in_required", fix: "codex login" });
  writeFileSync(join(c.root, "empty.json"), "{}");
  expect((await c.run(["local", "--dir", dir, "--port", port, "--codex-auth", join(c.root, "empty.json")])).error).toMatchObject({ error: "codex_auth_invalid", fix: "codex login" });
  for (const proxy of ["http://127.0.0.1:7890", "http://localhost:7890"])
    expect((await c.run(["local", "--dir", dir, "--port", port, "--sandbox-proxy", proxy])).error).toMatchObject({ error: "sandbox_proxy_is_loopback" });
  expect((await c.run(["local", "--dir", dir, "--port", port, "--sandbox-proxy", "proxy.example:7890"])).error).toMatchObject({ error: "invalid_sandbox_proxy" });
  const busy = createServer(); busy.listen(Number(port), "127.0.0.1"); await once(busy, "listening");
  expect((await c.run(["local", "--dir", dir, "--port", port])).error).toMatchObject({ error: "port_in_use", fix: expect.stringContaining("--port") });
  await new Promise<void>((resolve) => busy.close(() => resolve()));
  rmSync(join(c.home, ".codex", "auth.json"));
  expect((await c.run(["local", "--dir", join(c.root, "other"), "--port", port])).error).toMatchObject({ error: "codex_sign_in_required", fix: "codex login" });
  c.docker("echo 'Cannot connect to the Docker daemon' >&2; exit 1");
  expect(await c.run(["local", "--dir", dir, "--port", port])).toMatchObject({ code: 1, stdout: "", error: { error: "docker_engine_unreachable", detail: "Cannot connect to the Docker daemon" } });
  // Nothing was written, and the CLI was signed in to nothing.
  expect(existsSync(dir) || existsSync(join(c.root, "other"))).toBe(false);
  expect((await c.run(["whoami"])).error).toEqual({ error: "login_required" });
}, 120_000);

it("mau local runs the service, signs the CLI in, stops on a signal and goes on with the same state", async () => {
  const c = localCheckout(), dir = join(c.root, "local"), port = await freePort(), url = `http://127.0.0.1:${port}`;
  const first = await c.start(["--dir", dir, "--port", port, "--sandbox-proxy", "http://proxy.example:7890"]);
  expect(first.ready).toEqual({ url, owner: "@owner:localhost", dir, sandboxProxy: "http://proxy.example:7890",
    next: ["mau partner create helper --profile codex", 'mau chat send helper "hello"', "mau --help", "mau deploy --hostname HOSTNAME --owner-email EMAIL"], stop: expect.stringContaining("Ctrl-C") });
  // The directory is private, and holds the configuration a deployment would have without its login and its cloud.
  const secret = readFileSync(join(dir, "token"), "utf8").trim();
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  for (const [path, mode] of [[dir, 0o700], [join(dir, "config"), 0o700], [join(dir, "state"), 0o700], [join(dir, "token"), 0o600], [join(dir, "config", "cloud", "codex-auth.json"), 0o600]] as const)
    expect(statSync(path).mode & 0o777, path).toBe(mode);
  const options = JSON.parse(readFileSync(join(dir, "config", "mau.json"), "utf8"));
  expect(options.edgeIdentity).toBeUndefined();
  expect(options.environments.profiles).toMatchObject([{ id: "codex", provider: "local", owners: ["@owner:localhost"], template: "node24",
    env: { HTTP_PROXY: "http://proxy.example:7890", HTTPS_PROXY: "http://proxy.example:7890", http_proxy: "http://proxy.example:7890", https_proxy: "http://proxy.example:7890", NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1" } }]);
  expect(JSON.parse(readFileSync(join(dir, "config", "providers.json"), "utf8"))).toEqual({ providers: [{ id: "local", kind: "docker" }] });
  expect(readFileSync(join(dir, "config", "cloud", "codex-auth.json"), "utf8")).toBe(codexAuth());
  // Every other command works at once, with the token read from its file and never stored in the session.
  expect(JSON.parse(readFileSync(join(c.root, "config", "session.json"), "utf8"))).toEqual({ url, owner: "@owner:localhost", login: "local", tokenFile: join(dir, "token") });
  expect((await c.run(["whoami"])).json).toMatchObject({ owner: "@owner:localhost", via: "bearer" });
  expect((await c.run(["profiles"])).json).toEqual({ environments: [{ id: "codex", label: "Codex", kernel: "codex", kernels: ["codex"] }] });
  expect((await c.run(["partner", "list"])).json).toEqual({ data: [] });
  expect((await c.run(["api", "GET", "/_agent-router/v1/web/me"])).json.ownerId).toBe("@owner:localhost");
  expect((await c.run(["login", url])).error).toEqual({ error: "local_service_signs_in_with_mau_local", fix: "mau local" });
  const doctor = await c.run(["doctor", "--url", url]);
  expect(doctor.json).toMatchObject({ ok: true });
  expect(doctor.json.checks.map((check: { check: string; ok: boolean | null }) => [check.check, check.ok])).toEqual([["node", true], ["source-checkout", true], ["docker", true],
    ["local-directory", true], ["codex-sign-in", true], ["account", true], ["environment-profile", true]]);
  // The service itself answers only the token; the server's log is on stderr, the one document on stdout.
  expect((await fetch(url + "/_mau/v1/info").then((response) => response.json()))).toEqual({ login: "local" });
  expect((await fetch(url + "/_mau/v1/account")).status).toBe(401);
  expect(first.stderr()).toContain('{"event":"mau.started"}');
  expect(first.stdout()).not.toContain(secret);
  expect(await first.stop("SIGTERM")).toBe(0);
  expect(JSON.parse(first.stdout())).toEqual(first.ready);
  // A stopped service is named as such, by the CLI and by doctor.
  expect((await c.run(["whoami"])).error).toMatchObject({ error: "service_unreachable", fix: "mau local" });
  const down = (await c.run(["doctor", "--url", url]));
  expect(down.code).toBe(1);
  expect(down.json.checks.find((check: { check: string }) => check.check === "account")).toMatchObject({ ok: false, fix: "mau local" });

  // Started again: the same owner token and proxy; an empty --sandbox-proxy removes the proxy, and a machine that
  // has one of its own is told that partner environments were given none.
  const second = await c.start(["--dir", dir, "--port", port]);
  expect(second.ready).toMatchObject({ url, sandboxProxy: "http://proxy.example:7890" });
  expect(readFileSync(join(dir, "token"), "utf8").trim()).toBe(secret);
  expect(second.stderr()).not.toContain("--sandbox-proxy");
  expect(await second.stop("SIGINT")).toBe(0);
  const third = await c.start(["--dir", dir, "--port", port, "--sandbox-proxy", ""], { HTTPS_PROXY: "http://127.0.0.1:7890" });
  expect(third.ready.sandboxProxy).toBeUndefined();
  expect(JSON.parse(readFileSync(join(dir, "config", "mau.json"), "utf8")).environments.profiles[0].env).toBeUndefined();
  expect(third.stderr()).toContain("start with --sandbox-proxy URL");
  expect(await third.stop("SIGTERM")).toBe(0);

  // The server refuses local mode on any other address, whatever started it.
  const exposed = await promisify(execFile)(process.execPath, [join(c.root, "dist/main.js")], { env: { PATH: "/nonexistent", HOME: c.home, HOST: "0.0.0.0", PORT: port, MAU_LOCAL_TOKEN_FILE: join(dir, "token"),
    MAU_CONFIG_FILE: join(dir, "config", "mau.json"), MAU_STATE: join(dir, "state"), MATRIX_SERVER_NAME: "localhost", AGENT_SERVICE_URL: `${url}/_agent-router/v1` } })
    .then(() => "started", (error: { stderr?: string }) => error.stderr ?? "");
  expect(exposed).toContain("local_mode_requires_loopback");
}, 180_000);
