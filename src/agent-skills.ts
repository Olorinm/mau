import { createHash } from "node:crypto";
import { connectorGuide, type ConnectorGuide } from "@olorinm/agent-connectors/guides";
import type { ConnectedApps } from "./connected-apps.js";
import type { SandboxFiles } from "./browser-relay.js";
import { sessionShell, shellRelay } from "./kernels.js";

/**
 * How an Agent learns the connectors assigned to it. Each connector ships a guide written around its official CLI.
 *
 * For a kernel whose shell commands relay through Agent Host (Codex), the guide is installed in the environment as a
 * Codex skill, with a shell command (`gws`, `lark-cli`, `agent-browser`) that relays to the connector: the Agent
 * knows its connectors from the start and uses their CLIs. For every other kernel the same guides come with the
 * `connected_apps` tool itself (`toolGuides`), which runs the same commands. Credentials and approvals stay with Mau
 * and the connector service either way.
 */
const SKILLS_DIRECTORY = "/home/user/.codex/skills";
const RELAY_CLIENT = "/opt/agent-host/node_modules/@olorinm/agent-host/dist/service/relay-cli.js";
const MARKER = "Installed by Mau";
// Connector tool prefix behind each CLI command (`<prefix>_read` / `<prefix>_write`; see agent-host-relay).
const prefixes: Record<string, string> = { gws: "gws", "lark-cli": "cli", "agent-browser": "agent_browser" };
const COMMANDS = Object.keys(prefixes);
/** Installed in every environment: it also opens the pages the environment serves, which needs no connection. */
const ALWAYS = ["agent-browser"];

/**
 * `agent-browser` in the sandbox. Like agent-host-relay it forwards the shell command's arguments to the connector
 * through Agent Host's /v1/relay, retrying a command the connector classifies as a write on the write tool, which
 * asks the owner. It also passes its directory, so upload paths resolve as in a shell, and prints saved file paths.
 *
 * The owner's browser runs outside the environment and cannot reach what the environment serves. A page of the
 * environment itself (localhost) therefore goes to the unmodified agent-browser CLI the environment's start script
 * installs with its own Chromium, with the same arguments: the command that opens a page decides by its address, and
 * the commands after it follow until another page has opened. That browser needs no connection and no relay, so the
 * command is installed in every environment, whatever the kernel and whether or not a browser is connected.
 */
export const BROWSER_CLIENT = `#!/usr/bin/env node
// ${MARKER}: agent-browser for pages of this environment (its own browser) and for other sites (the owner's remote browser, through Agent Host's relay).
"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const fail = (message, code = 2) => { process.stderr.write(message + "\\n"); process.exit(code); };
const url = process.env.AGENT_HOST_RELAY_URL || "http://127.0.0.1:37420";
// Pages this environment serves open in the environment's own browser: the official CLI, installed by its start script.
const LOCAL = process.env.MAU_LOCAL_BROWSER || "/opt/local-browser/agent-browser";
// Relay identities are defined by the installed Host, shared with lark-cli and gws.
const hostRequire = require("node:module").createRequire(${JSON.stringify(RELAY_CLIENT)});
let identity;
try {
  const { relayIdentity } = hostRequire("@olorinm/agent-host/relay-session");
  identity = relayIdentity(process.env);
} catch (error) {
  if (!["MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"].includes(error.code)) fail(error.message);
  if (process.env.CODEX_THREAD_ID && process.env.CODEX_TOOL_CALL_ID)
    identity = { threadId: process.env.CODEX_THREAD_ID, callId: process.env.CODEX_TOOL_CALL_ID };
}
const args = process.argv.slice(2);
const valueFlags = new Set("--session --namespace --idle-timeout --headers --executable-path --extension --init-script --enable --cdp --cdp-headers --profile --state --proxy --proxy-bypass --args --user-agent -p --provider --ca-cert --device --session-name --color-scheme --download-path --max-output --allowed-domains --action-policy --confirm-actions --engine --input-mode --screenshot-dir --screenshot-quality --screenshot-format --model --config --restore-check-url --restore-check-text --restore-check-fn".split(" "));
const words = [];
let label = process.env.AGENT_BROWSER_SESSION || "";
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (valueFlags.has(arg)) { const value = args[++i]; if (arg === "--session") label = value || ""; }
  else if (!arg.startsWith("-")) words.push(arg);
}
const key = identity ? [identity.kernel || "codex", identity.threadId, label] : ["local", label];
const session = "mau-" + require("node:crypto").createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 32);
const mark = path.join(os.homedir(), ".agent-browser", "local-" + session);
function served(value) {
  try {
    const target = new URL(/^[a-z][a-z0-9+.-]*:\\/\\//i.test(value) ? value : "http://" + value), host = target.hostname.toLowerCase();
    return /^https?:$/.test(target.protocol) && (host === "localhost" || host.endsWith(".localhost") || (require("node:net").isIPv4(host) && host.startsWith("127.")) || host === "[::1]" || host === "0.0.0.0");
  } catch { return false; }
}
function opened() {
  return ["open", "goto", "navigate"].includes(words[0]) ? words[1] : words[0] === "tab" && words[1] === "new" ? words[2] : undefined;
}
/** Where the commands that name no page go from now on. Only a page that did open moves them. */
function remember(local) {
  try {
    if (local) { fs.mkdirSync(path.dirname(mark), { recursive: true }); fs.writeFileSync(mark, ""); } else fs.rmSync(mark, { force: true });
  } catch {}
}
function runHere(args, target) {
  if (!fs.existsSync(LOCAL)) fail("The browser for pages of this environment is not installed here. It is installed in the background after the environment's first start; try again in a few minutes.", 75);
  const run = require("node:child_process").spawnSync(LOCAL, args, { stdio: "inherit", env: { ...process.env, AGENT_BROWSER_SESSION: session } });
  if (run.error) fail(run.error.message, 1);
  if (run.status === 0 && target !== undefined) remember(true);
  if (run.status === 0 && words[0] === "close") remember(false);
  process.exit(run.status === null ? 1 : run.status);
}
async function relay(input) {
  const response = await fetch(new URL("/v1/relay", url), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...identity, tool: "connected_apps", input }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail("relay refused: " + (body.error || response.status));
  if (!body.result?.success) fail(body.result?.contentItems?.map(item => item.text).join(" ") || "connector call failed", 1);
  const text = ((body.result && body.result.contentItems) || []).map((item) => item.text || "").join("");
  try { return JSON.parse(text); } catch { return text; }
}
async function main() {
  if (!args.length) fail("usage: agent-browser <command> [args...]; start with: agent-browser skills get core");
  const target = opened();
  if (words[0] === "skills" || args.includes("--help") || args.includes("--version")) runHere(args);
  if (target === undefined ? fs.existsSync(mark) : served(target)) runHere(args, target);
  const LOCAL_HINT = " A page this environment serves opens here without it: agent-browser open http://localhost:PORT";
  if (!identity) fail("Other sites open in the owner's browser in Mau, which this shell does not reach: use the connected_apps tool for them." + LOCAL_HINT);
  const catalog = JSON.stringify(await relay({ action: "tools" }));
  const names = [...new Set([...catalog.matchAll(/"name":"([A-Za-z0-9_-]+__agent_browser)_read"/g)].map((match) => match[1]))];
  if (!names.length) fail("No browser for other sites is connected for this Agent. Ask the owner to connect a browser in Mau." + LOCAL_HINT);
  if (names.length > 1) fail("agent-browser has several browser connections (" + names.join(", ") + "); this command supports one.");
  const call = (mode) => relay({ action: "call", name: names[0] + "_" + mode, arguments: { args, cwd: process.cwd() } });
  let outcome = await call("read");
  // upload is a write: the connector refuses it on the read tool and the owner approves it on the write tool.
  if (outcome?.status === "failed" && outcome.error === "agent_browser_command_requires_write_tool") outcome = await call("write");
  if (typeof outcome === "string") { if (target !== undefined) remember(false); process.stdout.write(outcome.endsWith("\\n") ? outcome : outcome + "\\n"); return; }
  if (outcome && outcome.status && outcome.status !== "completed") {
    const detail = outcome.detail && typeof outcome.detail === "object" ? outcome.detail : undefined;
    if (detail && typeof detail.output === "string") process.stderr.write(detail.output + "\\n");
    else process.stderr.write((outcome.error || outcome.status) + (outcome.detail ? " " + JSON.stringify(outcome.detail) : "") + "\\n");
    process.exitCode = detail && Number.isInteger(detail.exitCode) && detail.exitCode > 0 ? detail.exitCode : 1;
    return;
  }
  if (target !== undefined) remember(false);
  const result = (outcome && outcome.result) || outcome || {};
  const output = typeof result.output === "string" ? result.output : JSON.stringify(result, null, 2);
  if (output) process.stdout.write(output.endsWith("\\n") ? output : output + "\\n");
  for (const file of Array.isArray(result.files) ? result.files : []) process.stdout.write("saved: " + file.path + "\\n");
}
main().catch((error) => fail(error instanceof Error ? error.message : String(error), 1));
`;

interface ConnectionSummary { id: string; kind: string; settings?: Record<string, unknown> }
interface SkillPlan { skills: Array<{ name: string; content: string }>; commands: string[] }

function skillDocument(guide: ConnectorGuide) {
  return `---\nname: ${guide.name}\ndescription: ${JSON.stringify(guide.description)}\n---\n\n<!-- ${MARKER}; regenerated from the connector's guide. -->\n\n${guide.body}`;
}

type GuideLookup = (kind: string, product?: string) => ConnectorGuide | undefined;

/** Guides of the Agent's connections whose CLI tools the connector actually offers right now. */
export function planSkills(connections: ConnectionSummary[], assigned: string[], tools: string[], guides: GuideLookup = connectorGuide): SkillPlan {
  const skills: SkillPlan["skills"] = [], commands = new Set<string>();
  for (const id of assigned) {
    const connection = connections.find(c => c.id === id);
    const product = typeof connection?.settings?.product === "string" ? connection.settings.product : undefined;
    const guide = connection && guides(connection.kind, product);
    const prefix = guide && prefixes[guide.command];
    if (!guide || !prefix || !tools.includes(`${id.replaceAll("-", "_")}__${prefix}_read`)) continue;
    skills.push({ name: guide.name, content: skillDocument(guide) });
    commands.add(guide.command);
  }
  return { skills, commands: [...commands].sort() };
}

/** What the `connected_apps` catalog says above the guides it carries. */
export const TOOL_GUIDES = "Each guide describes a connection's official command line. That command does not run in your shell here: run it through this tool. " +
  "Take a command from the guide, leave out the command's name, and pass the rest as arguments.args (one string per argument) with action=call and the tool named in read. " +
  "A command the connector classifies as a write is refused there with an error ending in _command_requires_write_tool: call the tool named in write with the same args. Where a guide says to run something in your shell, it means this. " +
  "One exception: a page your own environment serves (localhost) is not reachable through this tool. Open it in your shell with `agent-browser open http://localhost:PORT`; it opens in a browser inside the environment, and `agent-browser snapshot`, `click` and the rest follow there as usual.";
/**
 * The guides of the connections whose CLI tools a catalog offers, for a turn whose kernel has no relay commands: each
 * with the tools that run its command.
 */
export function toolGuides(connections: ConnectionSummary[], tools: string[], guides: GuideLookup = connectorGuide) {
  const found = connections.flatMap(connection => {
    const product = typeof connection.settings?.product === "string" ? connection.settings.product : undefined;
    const guide = guides(connection.kind, product), prefix = guide && prefixes[guide.command];
    const read = `${connection.id.replaceAll("-", "_")}__${prefix}_read`, write = `${connection.id.replaceAll("-", "_")}__${prefix}_write`;
    return guide && prefix && tools.includes(read)
      ? [{ connection: connection.id, command: guide.command, read, ...(tools.includes(write) ? { write } : {}), guide: guide.body }] : [];
  });
  return found.length ? { guidesNote: TOOL_GUIDES, guides: found } : {};
}

/** Runs inside the environment: installs managed commands as root (when root), then drops privileges to the owner of .codex before touching skills. */
const installer = `
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const plan = JSON.parse(Buffer.from(process.argv.slice(1).join(""), "base64").toString("utf8"));
const marker = ${JSON.stringify(MARKER)}, root = plan.skillsDirectory, home = path.dirname(root);
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
const safeName = (name) => typeof name === "string" && name.length > 0 && name !== "." && name !== ".." && !/[\\\\/\\0]/.test(name);
const readNoFollow = (file) => {
  let fd;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) throw new Error("not_a_regular_file");
    return fs.readFileSync(fd, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
};
const writeAtomic = (file, content, mode) => {
  const tmp = file + ".mau-" + crypto.randomBytes(8).toString("hex");
  let fd;
  try {
    fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
    fs.writeFileSync(fd, content, "utf8");
    fs.fchmodSync(fd, mode);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
};
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const result = { skills: [], commands: [], removed: [] };
// Step 1: manage the commands in binDirectory before dropping privileges. A command of plan.always needs no relay
// client and no connection, and is there whatever the kernel.
if (!fs.lstatSync(plan.binDirectory).isDirectory()) throw new Error("bin_directory_invalid");
const relay = plan.relayClient, available = fs.existsSync(relay);
for (const command of plan.known) {
  if (!safeName(command)) throw new Error("command_name_invalid");
  const file = path.join(plan.binDirectory, command), existing = readNoFollow(file);
  const managed = existing !== undefined && existing.includes(marker);
  const always = plan.always.includes(command);
  if (always || (plan.commands.includes(command) && available)) {
    if (existing !== undefined && !managed) { result.commands.push(command + ":kept-unmanaged"); continue; }
    const script = plan.clients[command] ?? "#!/bin/sh\\n# " + marker + ": runs " + command + " through the owner's connector in Mau (agent-host-relay).\\nexec node " + JSON.stringify(relay) + " " + command + " \\"$@\\"\\n";
    if (existing !== script) writeAtomic(file, script, 0o755);
    result.commands.push(command);
  } else if (managed && !plan.commandsOnly) { fs.unlinkSync(file); result.removed.push(command); }
}
if (!available) result.relay = "relay_client_missing";
if (plan.commandsOnly) { console.log(JSON.stringify(result)); process.exit(0); }
let owner;
try { owner = fs.lstatSync(home); } catch (error) {
  if (error && error.code === "ENOENT") { console.log(JSON.stringify({ ...result, skipped: "codex_home_missing" })); process.exit(0); }
  throw error;
}
if (!owner.isDirectory()) throw new Error("codex_home_not_directory");
if (isRoot && owner.uid === 0) throw new Error("codex_home_owned_by_root");
// Step 2: permanently drop privileges to the .codex owner before touching any user-controlled path.
if (isRoot) {
  if (typeof process.setgroups === "function") process.setgroups([owner.gid]);
  process.setgid(owner.gid);
  process.setuid(owner.uid);
}
try {
  if (!fs.lstatSync(root).isDirectory()) throw new Error("skills_directory_not_directory");
} catch (error) {
  if (error && error.code === "ENOENT") fs.mkdirSync(root, { mode: 0o755 });
  else throw error;
}
const wanted = new Set(plan.skills.map((s) => s.name));
for (const skill of plan.skills) {
  if (!safeName(skill.name)) throw new Error("skill_name_invalid");
  const dir = path.join(root, skill.name), file = path.join(dir, "SKILL.md");
  try {
    if (!fs.lstatSync(dir).isDirectory()) throw new Error("skill_directory_not_directory");
  } catch (error) {
    if (error && error.code === "ENOENT") fs.mkdirSync(dir, { mode: 0o755 });
    else throw error;
  }
  const existing = readNoFollow(file);
  if (existing !== undefined && !existing.includes(marker)) { result.skills.push(skill.name + ":kept-unmanaged"); continue; }
  writeAtomic(file, skill.content, 0o644); result.skills.push(skill.name);
}
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || wanted.has(entry.name)) continue;
  const file = path.join(root, entry.name, "SKILL.md");
  let existing;
  try { existing = readNoFollow(file); } catch { continue; }
  if (existing !== undefined && existing.includes(marker)) { fs.rmSync(path.join(root, entry.name), { recursive: true, force: true }); result.removed.push(entry.name); }
}
console.log(JSON.stringify(result));
`;

export class AgentSkills {
  private readonly synced = new Map<string, string>();
  private readonly checked = new Map<string, number>();
  constructor(private readonly apps: ConnectedApps, private readonly connections: () => ConnectionSummary[], private readonly guides: GuideLookup = connectorGuide) {}
  /**
   * Before a run of an Agent on `kernel`: where the kernel's shell commands relay, the guides and commands of
   * `agentId` (the partner that has the environment) are installed in it. For another kernel nothing is installed.
   */
  async install(kernel: string | undefined, agentId: string, owner: string, binding: string, files: () => Promise<SandboxFiles>) {
    // In a shared sandbox the commands are common files. Host and the connector resolve the
    // employee and their current assignment separately on every invocation.
    if (this.apps.employeePermissions) return this.run(`shared:${binding}`, { skills: [], commands: COMMANDS }, true, files);
    return shellRelay(kernel) ? this.sync(agentId, owner, binding, files) : this.run(`${agentId}:${binding}:commands`, { skills: [], commands: [] }, true, files);
  }
  /** For an Agent on a kernel without relay commands: the guides its `connected_apps` catalog carries, for the tools it lists. */
  toolGuides(kernel: string | undefined) {
    return (this.apps.employeePermissions ? sessionShell(kernel) : shellRelay(kernel)) ? undefined : (tools: string[]) => toolGuides(this.connections(), tools, this.guides);
  }
  /** Idempotent; repeats only when the plan for this environment binding changes. */
  async sync(agentId: string, owner: string, binding: string, files: () => Promise<SandboxFiles>) {
    const reader = this.apps.reader(agentId, owner), key = `${agentId}:${binding}`;
    // No connection at all: the commands every environment has, and the skills left as they are.
    if (!reader) return this.run(`${key}:commands`, { skills: [], commands: [] }, true, files);
    // The catalog read is cheap but not free; check each environment at most every ten minutes.
    const now = Date.now();
    if (now - (this.checked.get(key) ?? 0) < 600_000) return undefined;
    this.checked.set(key, now);
    const catalog = await reader({ action: "tools" }) as { status?: string; tools?: Array<{ name?: unknown }> };
    if (catalog?.status !== "completed") return undefined;
    const tools = (catalog.tools ?? []).map(tool => String(tool.name ?? ""));
    const plan = planSkills(this.connections(), this.apps.connections(agentId, owner), tools, this.guides);
    try { return await this.run(key, plan, false, files); }
    catch (error) { this.checked.delete(key); throw error; }
  }
  /**
   * Writes a plan into the environment, once per plan. `commandsOnly` installs the commands every environment has
   * (`agent-browser`, for the pages the environment serves) and touches neither the skills nor the other commands,
   * which belong to the plan of a Codex partner there.
   */
  private async run(key: string, plan: SkillPlan, commandsOnly: boolean, files: () => Promise<SandboxFiles>) {
    const payload = JSON.stringify({ ...plan, commandsOnly, skillsDirectory: SKILLS_DIRECTORY, binDirectory: "/usr/local/bin", relayClient: RELAY_CLIENT,
      known: COMMANDS, always: ALWAYS, clients: { "agent-browser": BROWSER_CLIENT } });
    const digest = createHash("sha256").update(payload).digest("hex");
    if (this.synced.get(key) === digest) return undefined;
    const sandbox = await files(), encoded = Buffer.from(payload, "utf8").toString("base64"), chunks: string[] = [];
    for (let offset = 0; offset < encoded.length; offset += 32_768) chunks.push(encoded.slice(offset, offset + 32_768));
    const run = await sandbox.exec(["node", "-e", installer, "--", ...chunks]);
    if (run.exitCode !== 0) throw new Error("agent_skills_install_failed");
    this.synced.set(key, digest);
    return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  }
}
