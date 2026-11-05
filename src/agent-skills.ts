import { createHash } from "node:crypto";
import { connectorGuide, type ConnectorGuide } from "@olorinm/agent-connectors/guides";
import type { ConnectedApps } from "./connected-apps.js";
import type { SandboxFiles } from "./browser-relay.js";

/**
 * Installs, in an Agent's environment, the guide of each assigned connector as a Codex skill and
 * a shell command (`gws`, `lark-cli`) that relays to the connector through Agent Host. The
 * Agent then knows its connectors from the start and uses their official CLIs; credentials
 * and approvals stay with Mau and the connector service.
 */
export const SKILLS_DIRECTORY = "/home/user/.codex/skills";
export const RELAY_CLIENT = "/opt/agent-host/node_modules/@olorinm/agent-host/dist/service/relay-cli.js";
const MARKER = "Installed by Mau";
// Connector tool prefix behind each CLI command (see agent-host-relay).
const prefixes: Record<string, string> = { gws: "gws", "lark-cli": "cli" };

export interface ConnectionSummary { id: string; kind: string; settings?: Record<string, unknown> }
export interface SkillPlan { skills: Array<{ name: string; content: string }>; commands: string[] }

export function skillDocument(guide: ConnectorGuide) {
  return `---\nname: ${guide.name}\ndescription: ${JSON.stringify(guide.description)}\n---\n\n<!-- ${MARKER}; regenerated from the connector's guide. -->\n\n${guide.body}`;
}

/** Guides of the Agent's connections whose CLI tools the connector actually offers right now. */
export function planSkills(connections: ConnectionSummary[], assigned: string[], tools: string[]): SkillPlan {
  const skills: SkillPlan["skills"] = [], commands = new Set<string>();
  for (const id of assigned) {
    const connection = connections.find(c => c.id === id);
    const product = typeof connection?.settings?.product === "string" ? connection.settings.product : undefined;
    const guide = connection && connectorGuide(connection.kind, product);
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
for (const command of ["gws", "lark-cli"]) {
  const file = path.join(plan.binDirectory, command), managed = fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(marker);
  if (plan.commands.includes(command) && available) {
    if (fs.existsSync(file) && !managed) { result.commands.push(command + ":kept-unmanaged"); continue; }
    const script = "#!/bin/sh\\n# " + marker + ": runs " + command + " through the owner's connector in Mau (agent-host-relay).\\nexec node " + JSON.stringify(relay) + " " + command + " \\"$@\\"\\n";
    const tmp = atomic(file, script, 0o755); fs.chmodSync(tmp, 0o755); fs.renameSync(tmp, file); result.commands.push(command);
  } else if (managed) { fs.rmSync(file, { force: true }); result.removed.push(command); }
}
if (!available) result.relay = "relay_client_missing";
console.log(JSON.stringify(result));
`;

export class AgentSkills {
  private readonly synced = new Map<string, string>();
  private readonly checked = new Map<string, number>();
  constructor(private readonly apps: ConnectedApps, private readonly connections: () => ConnectionSummary[]) {}
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
    const plan = planSkills(this.connections(), this.apps.connections(agentId, owner), tools);
    const payload = JSON.stringify({ ...plan, skillsDirectory: SKILLS_DIRECTORY, binDirectory: "/usr/local/bin", relayClient: RELAY_CLIENT });
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
