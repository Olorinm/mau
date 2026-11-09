import { afterEach, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as skills from "../src/agent-skills.js";
import type { ConnectedApps } from "../src/connected-apps.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const connections = [{ id: "google-gmail", kind: "google", settings: { product: "gmail" } }, { id: "coco-browser", kind: "browser" },
  { id: "work-feishu", kind: "feishu" }, { id: "drive", kind: "google", settings: { product: "drive" } }];

it("plans the guide of each assigned connection whose CLI tools the connector offers", () => {
  const plan = skills.planSkills(connections, ["google-gmail", "coco-browser", "work-feishu", "drive"],
    ["google_gmail__gws_read", "google_gmail__gws_write", "google_gmail__get_thread", "coco_browser__open", "drive__gws_read"]);
  expect(plan.commands).toEqual(["gws"]);
  expect(plan.skills.map(s => s.name)).toEqual(["google-gmail"]);
  const document = plan.skills[0]!.content;
  expect(document).toMatch(/^---\nname: google-gmail\ndescription: "Gmail of the owner's Google account/);
  expect(document).toContain("Installed by Mau"); expect(document).toContain("gws gmail +triage");
  // Without its CLI tools (no gws binary, not authorized), a guide would point at a missing command.
  expect(skills.planSkills(connections, ["google-gmail"], ["google_gmail__get_thread"]).skills).toEqual([]);
});

/** A local stand-in for the environment: the installer runs with node against temporary directories. */
function sandbox(relay: boolean) {
  const root = mkdtempSync(join(tmpdir(), "mau-skills-")); roots.push(root);
  const codex = join(root, "home/user/.codex"), bin = join(root, "usr/local/bin"), client = join(root, "relay-cli.js");
  mkdirSync(codex, { recursive: true }); mkdirSync(bin, { recursive: true });
  if (relay) writeFileSync(client, "");
  const files = {
    directory: root,
    writeFile: async (path: string, data: Uint8Array) => {
      // Point the installer at the temporary directories instead of the environment's.
      const plan = JSON.parse(new TextDecoder().decode(data));
      writeFileSync(join(root, "plan.json"), JSON.stringify({ ...plan, skillsDirectory: join(codex, "skills"), binDirectory: bin, relayClient: client }));
      expect(path.startsWith("/tmp/mau-agent-skills-")).toBe(true);
    },
    exec: async (argv: string[]) => ({ exitCode: 0, stdout: execFileSync(argv[0]!, [argv[1]!, argv[2]!, join(root, "plan.json")], { encoding: "utf8" }) }),
    readFile: async () => new Uint8Array(),
  };
  return { root, codex, bin, files };
}

it("installs skills and relay commands, keeps unmanaged files, removes stale managed ones and repeats only on change", async () => {
  let tools = ["google_gmail__gws_read", "google_gmail__gws_write", "work_feishu__cli_read", "work_feishu__cli_write"];
  let calls = 0;
  const apps = { reader: () => async () => { calls++; return { status: "completed", tools: tools.map(name => ({ name })) }; },
    connections: () => ["google-gmail", "work-feishu"] } as unknown as ConnectedApps;
  const box = sandbox(true);
  writeFileSync(join(box.bin, "lark-cli"), "#!/bin/sh\necho the owner's own CLI\n");
  const manager = new skills.AgentSkills(apps, () => connections);
  const first = await manager.sync("agent", "owner", "binding", async () => box.files);
  expect(first).toMatchObject({ skills: ["google-gmail", "feishu"], commands: ["gws", "lark-cli:kept-unmanaged"] });
  const gws = readFileSync(join(box.bin, "gws"), "utf8");
  expect(gws).toContain(`exec node ${JSON.stringify(join(box.root, "relay-cli.js"))} gws "$@"`);
  expect(statSync(join(box.bin, "gws")).mode & 0o777).toBe(0o755);
  expect(readFileSync(join(box.bin, "lark-cli"), "utf8")).toContain("owner's own CLI");
  expect(readFileSync(join(box.codex, "skills/feishu/SKILL.md"), "utf8")).toContain("lark-cli skills read lark-shared");
  // Within the check interval nothing is read again; afterwards an unchanged plan installs nothing.
  expect(await manager.sync("agent", "owner", "binding", async () => box.files)).toBeUndefined();
  expect(calls).toBe(1);
  const later = new skills.AgentSkills(apps, () => connections);
  tools = ["google_gmail__gws_read", "google_gmail__gws_write"];
  writeFileSync(join(box.codex, "skills/feishu/SKILL.md"), readFileSync(join(box.codex, "skills/feishu/SKILL.md")));
  const second = await later.sync("agent", "owner", "binding", async () => box.files);
  expect(second).toMatchObject({ skills: ["google-gmail"], removed: ["feishu"] });
  expect(existsSync(join(box.codex, "skills/feishu"))).toBe(false);
  expect(existsSync(join(box.bin, "gws"))).toBe(true);
});

it("leaves commands out when the environment's Agent Host has no relay client", async () => {
  const apps = { reader: () => async () => ({ status: "completed", tools: [{ name: "google_gmail__gws_read" }] }),
    connections: () => ["google-gmail"] } as unknown as ConnectedApps;
  const box = sandbox(false);
  const result = await new skills.AgentSkills(apps, () => connections).sync("agent", "owner", "binding", async () => box.files);
  expect(result).toMatchObject({ skills: ["google-gmail"], commands: [], relay: "relay_client_missing" });
  expect(existsSync(join(box.bin, "gws"))).toBe(false);
});

/** The browser guide ships with Agent Connectors' agent-browser connector; a stand-in keeps this test independent of the pinned release. */
const browserGuide = (kind: string) => kind === "browser" ? { name: "agent-browser", description: "The owner's remote browser through the official agent-browser CLI, for tests.",
  command: "agent-browser", connector: "browser", body: "# Browser\n\nRun `agent-browser skills get core`.\n" } : undefined;

it("installs the agent-browser guide and Mau's browser client for an assigned browser connection", async () => {
  expect(skills.planSkills(connections, ["coco-browser"], ["coco_browser__agent_browser_read"], browserGuide))
    .toMatchObject({ skills: [{ name: "agent-browser" }], commands: ["agent-browser"] });
  expect(skills.planSkills(connections, ["coco-browser"], ["coco_browser__handoff_start"], browserGuide).commands).toEqual([]);
  let tools = ["coco_browser__agent_browser_read", "coco_browser__agent_browser_write"];
  const apps = { reader: () => async () => ({ status: "completed", tools: tools.map(name => ({ name })) }), connections: () => ["coco-browser"] } as unknown as ConnectedApps;
  const box = sandbox(true);
  const result = await new skills.AgentSkills(apps, () => connections, browserGuide).sync("agent", "owner", "binding", async () => box.files);
  expect(result).toMatchObject({ skills: ["agent-browser"], commands: ["agent-browser"] });
  expect(readFileSync(join(box.bin, "agent-browser"), "utf8")).toBe(skills.BROWSER_CLIENT);
  expect(statSync(join(box.bin, "agent-browser")).mode & 0o777).toBe(0o755);
  expect(readFileSync(join(box.codex, "skills/agent-browser/SKILL.md"), "utf8")).toContain("Installed by Mau");
  // Unassigned later: the managed command and guide are removed.
  tools = [];
  const later = await new skills.AgentSkills(apps, () => connections, browserGuide).sync("agent", "owner", "binding", async () => box.files);
  expect(later).toMatchObject({ removed: ["agent-browser", "agent-browser"] });
  expect(existsSync(join(box.bin, "agent-browser"))).toBe(false);
});

it("the browser client forwards the shell's arguments and directory, retries uploads on the write tool and prints saved files", async () => {
  const root = mkdtempSync(join(tmpdir(), "mau-browser-client-")); roots.push(root);
  const client = join(root, "agent-browser"); writeFileSync(client, skills.BROWSER_CLIENT, { mode: 0o755 });
  const received: any[] = [];
  const server = createServer((req, res) => {
    let body = ""; req.on("data", chunk => body += chunk); req.on("end", () => {
      const request = JSON.parse(body); received.push(request);
      const input = request.input, reply = (value: unknown) => res.end(JSON.stringify({ result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] } }));
      if (input.action === "tools") return reply({ status: "completed", tools: [{ name: "coco_browser__agent_browser_read" }, { name: "coco_browser__agent_browser_write" }, { name: "google_gmail__gws_read" }] });
      const [command] = input.arguments.args;
      if (input.name.endsWith("_read") && command === "upload") return reply({ status: "failed", error: "agent_browser_command_requires_write_tool" });
      if (command === "upload") return reply({ status: "completed", result: { exitCode: 0, output: "✓ Uploaded cv.pdf" } });
      if (command === "click") return reply({ status: "failed", error: "agent_browser_failed", detail: { exitCode: 1, output: "✗ Element not found: #x" } });
      return reply({ status: "completed", result: { exitCode: 0, output: "✓ Screenshot saved to page.png", files: [{ path: "/workspace/browser_downloads/1234abcd-page.png", name: "page.png" }] } });
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const port = (server.address() as { port: number }).port;
    const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>(done => {
      execFile(process.execPath, [client, ...args], { cwd: root, env: { PATH: process.env.PATH, AGENT_HOST_RELAY_URL: `http://127.0.0.1:${port}`, CODEX_THREAD_ID: "thread", CODEX_TOOL_CALL_ID: "call" } },
        (error, stdout, stderr) => done({ code: error ? (error as any).code ?? 1 : 0, stdout, stderr }));
    });
    expect(await run(["screenshot", "page.png"])).toEqual({ code: 0, stdout: "✓ Screenshot saved to page.png\nsaved: /workspace/browser_downloads/1234abcd-page.png\n", stderr: "" });
    expect(received[1]).toEqual({ threadId: "thread", callId: "call", tool: "connected_apps",
      input: { action: "call", name: "coco_browser__agent_browser_read", arguments: { args: ["screenshot", "page.png"], cwd: realpathSync(root) } } });
    received.length = 0;
    expect(await run(["upload", "@e3", "cv.pdf"])).toMatchObject({ code: 0, stdout: "✓ Uploaded cv.pdf\n" });
    expect(received.map(r => r.input.name)).toEqual([undefined, "coco_browser__agent_browser_read", "coco_browser__agent_browser_write"]);
    expect(await run(["click", "#x"])).toEqual({ code: 1, stdout: "", stderr: "✗ Element not found: #x\n" });
  } finally { server.close(); }
});
