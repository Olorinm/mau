// `mau local`: the whole product on this machine. The server is the same program a deployment runs (`dist/main.js`),
// started in local mode: one owner, signed in with a token in a private file, on a loopback address only; partner
// environments are containers of the local Docker engine.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PROFILE, renderProduct } from "../deploy/render.js";
import { DeployError, Source, inspectCodexAuth } from "../deploy/source.js";
import { Directory } from "../deploy/state.js";
import { systemRuntime, type Runtime } from "../deploy/effects.js";
import { privateFile } from "../files.js";
import { mau } from "./client.js";
import { fail, text, type Command, type Invocation } from "./command.js";
import { configDirectory, writeSession } from "./session.js";

/** The namespace of a local Mau's one owner. */
export const LOCAL_SERVER = "localhost";
const HOST = "127.0.0.1", PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];
/** The local directory of `mau local` when `--dir` names none. */
export const localDirectory = (env: Record<string, string | undefined>, home: string) => join(configDirectory(env, home), "local");

/** The proxy a sandbox reaches the internet through. A container's own loopback address is never this machine. */
function sandboxProxy(value: string) {
  let url: URL | undefined;
  try { url = new URL(value); } catch { url = undefined; }
  if (!url || !["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) || !url.hostname) throw new DeployError("invalid_sandbox_proxy", "it is not an http, https or socks5 URL");
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new DeployError("sandbox_proxy_is_loopback", `inside a container ${url.hostname} is the container itself`,
    "Name the address a container reaches this machine at, for example http://host.docker.internal:PORT (Docker Desktop) or the address of the engine's gateway.");
  return value;
}

/** Whether nothing listens on the port yet. */
const portFree = (port: number) => new Promise<boolean>((done) => {
  const probe = createServer();
  probe.once("error", () => done(false));
  probe.listen(port, HOST, () => probe.close(() => done(true)));
});

/** Checks this machine, then writes the local directory: `config/`, `state/` and `token`. A failed check leaves everything as it was. */
async function prepare(options: Invocation["options"], runtime: Runtime, note: Invocation["note"]) {
  const { env, home, effects } = runtime, source = new Source(runtime);
  if (Number(runtime.nodeVersion.split(".")[0]) < 24) throw new DeployError("node_24_required", `this is Node.js ${runtime.nodeVersion}`, "Install Node.js 24 or later.");
  const port = Number(text(options.port) ?? "8790");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DeployError("invalid_port", "--port is a TCP port number");
  source.assertCheckout("local");
  if (source.staleArchives(source.pin()).length || !existsSync(source.startHost) || !existsSync(source.officialSkills))
    throw new DeployError("platform_archives_missing", "the pinned Agent Kit packages are not installed in this checkout", "node scripts/bootstrap.mjs && npm run build");
  const docker = await effects.run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 30_000 });
  if (docker.code !== 0) throw new DeployError("docker_engine_unreachable", docker.stderr.trim().slice(-300), "Start Docker (or another Docker-compatible engine); each partner's environment is a container.");

  const path = resolve(text(options.dir) ?? localDirectory(env, home)), directory = new Directory(path), state = join(path, "state"), tokenFile = join(path, "token");
  const existing = directory.configFiles();
  // The owner's Codex sign-in on this machine is the one partners use; a copy that is already there serves without it.
  const given = text(options["codex-auth"]), from = given ?? join(home, ".codex", "auth.json"), signIn = existsSync(from) ? readFileSync(from) : undefined;
  if (signIn ? !inspectCodexAuth(signIn).ok : given || !existing.has("cloud/codex-auth.json"))
    throw signIn ? new DeployError("codex_auth_invalid", `${from}: ${inspectCodexAuth(signIn).detail}`, "codex login")
      : new DeployError("codex_sign_in_required", `${from} does not exist; partners use this sign-in for their model`, "codex login");
  // The proxy is kept in the profile, so a later start without the option goes on with it; an empty value removes it.
  const stored = existing.has("mau.json") ? (JSON.parse(existing.get("mau.json")!.toString("utf8")) as { environments?: { profiles?: Array<{ id: string; env?: Record<string, string> }> } })
    .environments?.profiles?.find((profile) => profile.id === PROFILE)?.env?.HTTPS_PROXY : undefined;
  const asked = text(options["sandbox-proxy"]), proxy = asked === undefined ? stored : asked ? sandboxProxy(asked) : undefined;
  if (!await portFree(port)) throw new DeployError("port_in_use", `something already listens on ${HOST}:${port}`, "Stop it (another `mau local`?), or choose another port with --port.");

  const hostProxy = PROXY_VARIABLES.find((name) => env[name]);
  if (!proxy && hostProxy) note(`This machine uses a proxy (${hostProxy}) and partner environments were given none: if they cannot reach the internet, start with --sandbox-proxy URL.`);
  for (const made of [path, directory.config, state]) { mkdirSync(made, { recursive: true, mode: 0o700 }); chmodSync(made, 0o700); }
  const owner = `@owner:${LOCAL_SERVER}`;
  const rendered = renderProduct(source, { owner, provider: { id: "local", kind: "docker" }, startHost: readFileSync(source.startHost), officialSkills: readFileSync(source.officialSkills),
    ...(proxy ? { env: { ...Object.fromEntries(PROXY_VARIABLES.map((name) => [name, proxy])), NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1" } } : {}) }, existing);
  for (const [key, bytes] of [["mau.json", Buffer.from(JSON.stringify(rendered.mau, null, 2) + "\n")] as const, ...rendered.files, ...(signIn ? [["cloud/codex-auth.json", signIn] as const] : [])])
    if (!existing.get(key)?.equals(bytes)) privateFile(join(directory.config, ...key.split("/")), bytes);
  if (!existsSync(tokenFile)) privateFile(tokenFile, randomBytes(32).toString("base64url") + "\n");
  chmodSync(tokenFile, 0o600);

  const webRoot = source.path("web", "dist");
  return { source, path, port, owner, tokenFile, proxy, url: `http://${HOST}:${port}`, config: join(directory.config, "mau.json"), state,
    webRoot: existsSync(join(webRoot, "index.html")) ? webRoot : undefined };
}

/** Runs Mau on this machine until the signal: prints one JSON document when it is ready, and the server's log on stderr. */
async function local({ options, note, signal }: Invocation, runtime: Runtime = systemRuntime()) {
  const prepared = await prepare(options, runtime, note).catch((error: unknown) => {
    if (error instanceof DeployError) return fail(error.code, { ...(error.detail ? { detail: error.detail } : {}), ...(error.fix ? { fix: error.fix } : {}) });
    throw error;
  });
  const { source, url, owner, tokenFile } = prepared;
  // The server gets this process's environment without any service setting of another Mau, then its own.
  const inherited = Object.fromEntries(Object.entries(runtime.env).filter(([name]) => !/^(?:AGENT|MAU|MATRIX)_/.test(name)));
  const server = spawn(process.execPath, [source.path("dist", "main.js")], { cwd: source.root, stdio: ["ignore", "pipe", "pipe"], env: { ...inherited,
    MAU_CONFIG_FILE: prepared.config, MAU_STATE: prepared.state, MAU_LOCAL_TOKEN_FILE: tokenFile, HOST, PORT: String(prepared.port),
    MATRIX_SERVER_NAME: LOCAL_SERVER, AGENT_SERVICE_URL: `${url}/_agent-router/v1`, ...(prepared.webRoot ? { MAU_WEB_ROOT: prepared.webRoot } : {}) } });
  let log = "";
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (chunk: Buffer) => { log = (log + chunk).slice(-2000); process.stderr.write(chunk); });
  let over = false;
  const exited = new Promise<number>((done) => { server.once("error", () => done(127)); server.once("exit", (code) => done(code ?? 1)); }).finally(() => { over = true; });
  // The terminal's interrupt reaches the server as well; a signal sent to this process alone is passed on. A server
  // that has not stopped after 20 seconds is killed. Environments are left as they are.
  const stop = () => { server.kill("SIGTERM"); setTimeout(() => server.kill("SIGKILL"), 20_000).unref(); };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();

  const token = readFileSync(tokenFile, "utf8").trim(), account = async () => {
    try {
      const response = await fetch(url + mau + "/account", { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(5000) });
      return response.ok && (await response.json() as { owner?: unknown }).owner === owner;
    } catch { return false; }
  };
  for (const deadline = Date.now() + 120_000; !await account();) {
    if (signal.aborted) { await exited; return; }
    if (over || Date.now() > deadline) {
      stop(); await exited;
      return fail("local_server_did_not_start", { detail: log.trim().split("\n").slice(-5).join("\n") });
    }
    await delay(250);
  }
  writeSession({ url, owner, login: "local", tokenFile }, runtime.env, runtime.home);
  process.stdout.write(JSON.stringify({ url, owner, dir: prepared.path,
    // The console takes the token from the fragment, which a browser never sends to a server.
    ...(prepared.webRoot ? { console: `${url}/#token=${token}` } : {}),
    ...(prepared.proxy ? { sandboxProxy: prepared.proxy } : {}),
    next: [`mau partner create helper --profile ${PROFILE}`, 'mau chat send helper "hello"', "mau --help", "mau deploy --hostname HOSTNAME --owner-email EMAIL"],
    stop: "Interrupt this command (Ctrl-C). Partner environments stay as they are: containers keep their files." }, null, 2) + "\n");
  const code = await exited;
  if (!signal.aborted) fail("local_server_exited", { exitCode: code, detail: log.trim().split("\n").slice(-5).join("\n") });
}

export const localCommands: Command[] = [
  { path: ["local"], summary: "Run Mau on this machine until interrupted: one owner, partners in local Docker containers, no Cloudflare. Prints one JSON document when it is ready and signs this CLI in to it.",
    options: {
      dir: { type: "string", value: "DIR", help: "The private directory with its configuration, state and owner token (default: ~/.config/mau/local)." },
      port: { type: "string", value: "PORT", help: "The port on 127.0.0.1 (default: 8790)." },
      "codex-auth": { type: "string", value: "FILE", help: "The owner's Codex sign-in (default: ~/.codex/auth.json)." },
      "sandbox-proxy": { type: "string", value: "URL", help: "The proxy new partner environments reach the internet through, as a container sees it; remembered, and an empty value removes it." },
    },
    run: invocation => local(invocation) },
];
