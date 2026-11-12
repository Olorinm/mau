import { createHash } from "node:crypto";
import { connectorGuide, type ConnectorGuide } from "@olorinm/agent-connectors/guides";
import type { ConnectedApps } from "./connected-apps.js";
import type { SandboxFiles } from "./browser-relay.js";

/**
 * Installs, in an Agent's environment, the guide of each assigned connector as a Codex skill and
 * a shell command (`gws`, `lark-cli`, `agent-browser`) that relays to the connector through Agent Host. The
 * Agent then knows its connectors from the start and uses their official CLIs; credentials
 * and approvals stay with Mau and the connector service.
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

/** Runs inside the environment as root: write managed skills and commands, remove stale managed ones. */
const installer = `
const fs = require("node:fs"), path = require("node:path");
const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); fs.rmSync(process.argv[1], { force: true });
const marker = ${JSON.stringify(MARKER)}, root = plan.skillsDirectory, home = path.dirname(root);
if (!fs.existsSync(home)) { console.log(JSON.stringify({ skipped: "codex_home_missing" })); process.exit(0); }
const owner = fs.statSync(home);
const own = (p) => fs.chownSync(p, owner.uid, owner.gid);
const atomic = (file, content, mode) => { const tmp = file + ".mau"; fs.writeFileSync(tmp, content, { mode }); return tmp; };
fs.mkdirSync(root, { recursive: true }); own(root);
const wanted = new Set(plan.skills.map((s) => s.name)), result = { skills: [], commands: [], removed: [] };
for (const skill of plan.skills) {
  const dir = path.join(root, skill.name), file = path.join(dir, "SKILL.md");
  if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes(marker)) { result.skills.push(skill.name + ":kept-unmanaged"); continue; }
  fs.mkdirSync(dir, { recursive: true }); own(dir);
  const tmp = atomic(file, skill.content, 0o644); own(tmp); fs.renameSync(tmp, file); result.skills.push(skill.name);
}
for (const name of fs.readdirSync(root)) {
  const file = path.join(root, name, "SKILL.md");
  if (!wanted.has(name) && fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(marker)) { fs.rmSync(path.join(root, name), { recursive: true, force: true }); result.removed.push(name); }
}
const relay = plan.relayClient, available = fs.existsSync(relay);
for (const command of plan.known) {
  const file = path.join(plan.binDirectory, command), managed = fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(marker);
  if (plan.commands.includes(command) && available) {
    if (fs.existsSync(file) && !managed) { result.commands.push(command + ":kept-unmanaged"); continue; }
    const script = plan.clients[command] ?? "#!/bin/sh\\n# " + marker + ": runs " + command + " through the owner's connector in Mau (agent-host-relay).\\nexec node " + JSON.stringify(relay) + " " + command + " \\"$@\\"\\n";
    const tmp = atomic(file, script, 0o755); fs.chmodSync(tmp, 0o755); fs.renameSync(tmp, file); result.commands.push(command);
  } else if (managed) { fs.rmSync(file, { force: true }); result.removed.push(command); }
}
if (!available) result.relay = "relay_client_missing";
console.log(JSON.stringify(result));
`;

export class AgentSkills {
  private readonly synced = new Map<string, string>();
  private readonly checked = new Map<string, number>();
  constructor(private readonly apps: ConnectedApps, private readonly connections: () => ConnectionSummary[], private readonly guides: GuideLookup = connectorGuide) {}
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
    const sandbox = await files(), file = `/tmp/mau-agent-skills-${digest.slice(0, 16)}.json`;
    await sandbox.writeFile(file, new TextEncoder().encode(payload));
    const run = await sandbox.exec(["node", "-e", installer, file]);
    if (run.exitCode !== 0) { this.checked.delete(key); throw new Error("agent_skills_install_failed"); }
    this.synced.set(key, digest);
    return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  }
}
