import { createHash } from "node:crypto";
import { connectorGuide, type ConnectorGuide } from "@olorinm/agent-connectors/guides";
import type { ConnectedApps } from "./connected-apps.js";
import type { SandboxFiles } from "./browser-relay.js";
import { shellRelay } from "./kernels.js";

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

/**
 * `agent-browser` in the sandbox. Like agent-host-relay it forwards the shell command's arguments to the connector
 * through Agent Host's /v1/relay, retrying a command the connector classifies as a write on the write tool, which
 * asks the owner. It also passes its directory, so upload paths resolve as in a shell, and prints saved file paths.
 */
export const BROWSER_CLIENT = `#!/usr/bin/env node
// ${MARKER}: runs agent-browser in the owner's remote browser through Mau (Agent Host relay).
"use strict";
const fail = (message, code = 2) => { process.stderr.write(message + "\\n"); process.exit(code); };
const url = process.env.AGENT_HOST_RELAY_URL || "http://127.0.0.1:37420";
async function relay(input) {
  const response = await fetch(new URL("/v1/relay", url), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: process.env.CODEX_THREAD_ID, callId: process.env.CODEX_TOOL_CALL_ID, tool: "connected_apps", input }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail("relay refused: " + (body.error || response.status));
  const text = ((body.result && body.result.contentItems) || []).map((item) => item.text || "").join("");
  try { return JSON.parse(text); } catch { return text; }
}
async function main() {
  const args = process.argv.slice(2);
  if (!args.length) fail("usage: agent-browser <command> [args...]; start with: agent-browser skills get core");
  if (!process.env.CODEX_THREAD_ID || !process.env.CODEX_TOOL_CALL_ID) fail("agent-browser runs through the owner's browser connection in Mau; call it from the Agent's shell.");
  const catalog = JSON.stringify(await relay({ action: "tools" }));
  const names = [...new Set([...catalog.matchAll(/"name":"([A-Za-z0-9_-]+__agent_browser)_read"/g)].map((match) => match[1]))];
  if (!names.length) fail("agent-browser is not connected for this Agent here. Ask the owner to connect a browser in Mau.");
  if (names.length > 1) fail("agent-browser has several browser connections (" + names.join(", ") + "); this command supports one.");
  const call = (mode) => relay({ action: "call", name: names[0] + "_" + mode, arguments: { args, cwd: process.cwd() } });
  let outcome = await call("read");
  // upload is a write: the connector refuses it on the read tool and the owner approves it on the write tool.
  if (/_command_requires_write_tool\\b/.test(JSON.stringify(outcome))) outcome = await call("write");
  if (typeof outcome === "string") { process.stdout.write(outcome.endsWith("\\n") ? outcome : outcome + "\\n"); return; }
  if (outcome && outcome.status && outcome.status !== "completed") {
    const detail = outcome.detail && typeof outcome.detail === "object" ? outcome.detail : undefined;
    if (detail && typeof detail.output === "string") process.stderr.write(detail.output + "\\n");
    else process.stderr.write((outcome.error || outcome.status) + (outcome.detail ? " " + JSON.stringify(outcome.detail) : "") + "\\n");
    process.exitCode = detail && Number.isInteger(detail.exitCode) && detail.exitCode > 0 ? detail.exitCode : 1;
    return;
  }
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
  "A command the connector classifies as a write is refused there with an error ending in _command_requires_write_tool: call the tool named in write with the same args. Where a guide says to run something in your shell, it means this.";
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
let owner;
try { owner = fs.lstatSync(home); } catch (error) {
  if (error && error.code === "ENOENT") { console.log(JSON.stringify({ skipped: "codex_home_missing" })); process.exit(0); }
  throw error;
}
if (!owner.isDirectory()) throw new Error("codex_home_not_directory");
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
if (isRoot && owner.uid === 0) throw new Error("codex_home_owned_by_root");
const result = { skills: [], commands: [], removed: [] };
// Step 1: manage relay commands in binDirectory before dropping privileges.
if (!fs.lstatSync(plan.binDirectory).isDirectory()) throw new Error("bin_directory_invalid");
const relay = plan.relayClient, available = fs.existsSync(relay);
for (const command of plan.known) {
  if (!safeName(command)) throw new Error("command_name_invalid");
  const file = path.join(plan.binDirectory, command), existing = readNoFollow(file);
  const managed = existing !== undefined && existing.includes(marker);
  if (plan.commands.includes(command) && available) {
    if (existing !== undefined && !managed) { result.commands.push(command + ":kept-unmanaged"); continue; }
    const script = plan.clients[command] ?? "#!/bin/sh\\n# " + marker + ": runs " + command + " through the owner's connector in Mau (agent-host-relay).\\nexec node " + JSON.stringify(relay) + " " + command + " \\"$@\\"\\n";
    writeAtomic(file, script, 0o755); result.commands.push(command);
  } else if (managed) { fs.unlinkSync(file); result.removed.push(command); }
}
if (!available) result.relay = "relay_client_missing";
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
    return shellRelay(kernel) ? this.sync(agentId, owner, binding, files) : undefined;
  }
  /** For an Agent on a kernel without relay commands: the guides its `connected_apps` catalog carries, for the tools it lists. */
  toolGuides(kernel: string | undefined) {
    return shellRelay(kernel) ? undefined : (tools: string[]) => toolGuides(this.connections(), tools, this.guides);
  }
  /** Idempotent; repeats only when the plan for this environment binding changes. */
  async sync(agentId: string, owner: string, binding: string, files: () => Promise<SandboxFiles>) {
    const reader = this.apps.reader(agentId, owner);
    if (!reader) return undefined;
    // The catalog read is cheap but not free; check each environment at most every ten minutes.
    const key = `${agentId}:${binding}`, now = Date.now();
    if (now - (this.checked.get(key) ?? 0) < 600_000) return undefined;
    this.checked.set(key, now);
    const catalog = await reader({ action: "tools" }) as { status?: string; tools?: Array<{ name?: unknown }> };
    if (catalog?.status !== "completed") return undefined;
    const tools = (catalog.tools ?? []).map(tool => String(tool.name ?? ""));
    const plan = planSkills(this.connections(), this.apps.connections(agentId, owner), tools, this.guides);
    const payload = JSON.stringify({ ...plan, skillsDirectory: SKILLS_DIRECTORY, binDirectory: "/usr/local/bin", relayClient: RELAY_CLIENT,
      known: COMMANDS, clients: { "agent-browser": BROWSER_CLIENT } });
    const digest = createHash("sha256").update(payload).digest("hex");
    if (this.synced.get(key) === digest) return undefined;
    const sandbox = await files(), encoded = Buffer.from(payload, "utf8").toString("base64"), chunks: string[] = [];
    for (let offset = 0; offset < encoded.length; offset += 32_768) chunks.push(encoded.slice(offset, offset + 32_768));
    const run = await sandbox.exec(["node", "-e", installer, "--", ...chunks]);
    if (run.exitCode !== 0) { this.checked.delete(key); throw new Error("agent_skills_install_failed"); }
    this.synced.set(key, digest);
    return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  }
}
