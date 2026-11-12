// An Environment provider whose lifecycle is simulated; commands, files and the Host process are real local resources.
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EnvironmentManager } from "@olorinm/agent-environment";

const id = "fixture-cloud-environment";
const children = new Set();
let config, host, exited, state = "missing", metadata = {}, creates = 0;

async function boot() {
  host = spawn(process.execPath, [
    resolve("node_modules/@olorinm/agent-host/dist/service/cli.js"), "serve",
    "--config", join(config.directory, "host.json"),
    "--token-file", join(config.directory, "token"),
    "--ready-file", join(config.directory, "ready.json"),
    "--host", "127.0.0.1", "--port", String(config.port),
  ], { env: { ...process.env, AGENT_HOST_TOKEN: "" }, stdio: ["ignore", "pipe", "pipe"] });
  exited = new Promise(done => host.once("exit", done));
  let log = "";
  host.stdout.on("data", bytes => (log += bytes));
  host.stderr.on("data", bytes => (log += bytes));
  host.once("exit", code => { if (code) process.stderr.write("Fixture Host exited: " + log); });
  state = "running";
}
async function stop() {
  if (host && host.exitCode === null) { host.kill(); await exited; }
  host = undefined;
}
const info = () => ({ provider: "cloud", id, state, template: "fixture", metadata });
const provider = {
  id: "cloud",
  capabilities: { automaticPause: true, pause: true, processMemoryResume: false, persistence: "provider-template" },
  async create(request) { creates++; metadata = request.metadata ?? {}; await boot(); return { provider: "cloud", id }; },
  async info() { return info(); },
  async list(filter = {}) {
    return state !== "missing" && Object.entries(filter).every(([key, value]) => metadata[key] === value) ? [info()] : [];
  },
  async resume() { if (state === "paused") await boot(); return info(); },
  async pause() { await stop(); state = "paused"; },
  async destroy() { await stop(); state = "missing"; },
  async setTimeout() {},
  async *exec(_id, argv, options = {}) {
    const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd ?? config.root, env: { ...process.env, ...options.env } });
    children.add(child);
    const chunks = [];
    for (const stream of ["stdout", "stderr"]) child[stream].on("data", bytes => chunks.push({ stream, text: String(bytes), bytes }));
    const exitCode = await new Promise((done, fail) => { child.once("error", fail); child.once("close", code => done(code ?? 137)); });
    children.delete(child);
    yield* chunks;
    options.onExit?.({ exitCode });
  },
  async httpEndpoint(_id, port) { return { url: "http://127.0.0.1:" + port, headers: {} }; },
  readFile: (_id, path) => readFile(path),
  async writeFile(_id, path, data) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, data); },
  removeFile: (_id, path) => rm(path),
  async listFiles() { return []; },
  hasUncertainExecution: () => false,
  resetExecutionUncertainty() {},
};
export async function loadConfiguration(path) {
  config = JSON.parse(await readFile(path, "utf8"));
  return new EnvironmentManager([provider]);
}
export const count = () => creates;
export const close = async () => {
  await stop();
  for (const child of children) child.kill("SIGKILL");
};
