import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

/** A local stand-in for the environment: the installer runs with node against temporary directories, without touching /tmp. */
function sandbox(relay: boolean) {
  const root = mkdtempSync(join(tmpdir(), "mau-skills-")); roots.push(root);
  const codex = join(root, "home/user/.codex"), bin = join(root, "usr/local/bin"), client = join(root, "relay-cli.js");
  mkdirSync(codex, { recursive: true }); mkdirSync(bin, { recursive: true });
  // In root-run CI the guest workspace still belongs to an unprivileged account.
  if (process.getuid?.() === 0) {
    chmodSync(root, 0o711);
    chownSync(codex, 65534, 65534);
  }
  if (relay) writeFileSync(client, "");
  let writes = 0;
  const official: string[] = [];
  const files = {
    directory: root,
    writeFile: async () => { writes++; throw new Error("unexpected_write_file"); },
    exec: async (argv: string[]) => {
      // The start script's own installer, asked again for the groups this environment's connections cover.
      if (argv[0] === "sh") { official.push(argv[2]!); return { exitCode: 0, stdout: "" }; }
      expect(argv[0]).toBe("node"); expect(argv[1]).toBe("-e"); expect(argv[3]).toBe("--");
      const plan = JSON.parse(Buffer.from(argv.slice(4).join(""), "base64").toString("utf8"));
      const rewritten = Buffer.from(JSON.stringify({ ...plan, skillsDirectory: join(codex, "skills"), binDirectory: bin, relayClient: client }), "utf8").toString("base64");
      return new Promise<{ exitCode: number; stdout: string }>(resolve =>
        execFile(process.execPath, ["-e", argv[2]!, "--", rewritten], (error, stdout) => resolve({ exitCode: error ? 1 : 0, stdout })));
    },
    readFile: async () => new Uint8Array(),
  };
  return { root, codex, bin, files, official, writes: () => writes };
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
  expect(first).toMatchObject({ skills: ["google-gmail", "feishu"], commands: ["gws", "lark-cli:kept-unmanaged", "agent-browser"] });
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

it("asks the start script's installer for only the official skill groups this environment has connections for", async () => {
  const apps = { reader: () => async () => ({ status: "completed", tools: [] }), connections: () => ["google-gmail", "work-feishu"] } as unknown as ConnectedApps;
  const box = sandbox(true);
  const manager = new skills.AgentSkills(apps, () => connections);
  await manager.install("claude", "agent", "owner", "binding", async () => box.files);
  // agent-browser needs no connection; lark and gws do. --prune removes the groups that are not in it.
  expect(box.official.at(-1)).toContain("--prune --only agent-browser gws lark");
  // The same connection set asks once.
  await manager.install("claude", "agent", "owner", "binding", async () => box.files);
  expect(box.official).toHaveLength(1);
});

it("leaves commands out when the environment's Agent Host has no relay client", async () => {
  const apps = { reader: () => async () => ({ status: "completed", tools: [{ name: "google_gmail__gws_read" }] }),
    connections: () => ["google-gmail"] } as unknown as ConnectedApps;
  const box = sandbox(false);
  const result = await new skills.AgentSkills(apps, () => connections).sync("agent", "owner", "binding", async () => box.files);
  expect(result).toMatchObject({ skills: ["google-gmail"], commands: ["agent-browser"], relay: "relay_client_missing" });
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
  // Unassigned later: the guide is removed. The command stays, for the pages the environment serves.
  tools = [];
  const later = await new skills.AgentSkills(apps, () => connections, browserGuide).sync("agent", "owner", "binding", async () => box.files);
  expect(later).toMatchObject({ commands: ["agent-browser"], removed: ["agent-browser"] });
  expect(readFileSync(join(box.bin, "agent-browser"), "utf8")).toBe(skills.BROWSER_CLIENT);
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
      execFile(process.execPath, [client, ...args], { cwd: root, env: { PATH: process.env.PATH, HOME: root, AGENT_HOST_RELAY_URL: `http://127.0.0.1:${port}`, CODEX_THREAD_ID: "thread", CODEX_TOOL_CALL_ID: "call" } },
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

it("the browser client opens pages of the environment in the environment's own browser and everything else in the owner's", async () => {
  const root = mkdtempSync(join(tmpdir(), "mau-browser-route-")); roots.push(root);
  const client = join(root, "agent-browser"); writeFileSync(client, skills.BROWSER_CLIENT, { mode: 0o755 });
  // A stand-in for the official CLI: records its arguments and session, and fails where asked to.
  const local = join(root, "local"), log = join(root, "local.log");
  writeFileSync(local, `#!/bin/sh\necho "$AGENT_BROWSER_SESSION $*" >> ${JSON.stringify(log)}\necho "local: $*"\n[ "$1" = click ] && exit 3\ncase "$*" in *fail*) exit 3;; esac\nexit 0\n`, { mode: 0o755 });
  const remote: string[][] = [];
  const server = createServer((req, res) => {
    let body = ""; req.on("data", chunk => body += chunk); req.on("end", () => {
      const input = JSON.parse(body).input, reply = (value: unknown) => res.end(JSON.stringify({ result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] } }));
      if (input.action === "tools") return reply({ status: "completed", tools: [{ name: "coco_browser__agent_browser_read" }] });
      if (input.arguments.args.includes("https://refused.example/")) return reply({ status: "failed", error: "browser_site_denied" });
      remote.push(input.arguments.args); reply({ status: "completed", result: { exitCode: 0, output: "remote: " + input.arguments.args.join(" ") } });
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const port = (server.address() as { port: number }).port;
    const exec = (args: string[], env: Record<string, string>) => new Promise<{ code: number | null; stdout: string; stderr: string }>(done => {
      execFile(process.execPath, [client, ...args], { cwd: root, env: { PATH: process.env.PATH, HOME: root, ...env } },
        (error, stdout, stderr) => done({ code: error ? (error as any).code ?? 1 : 0, stdout, stderr }));
    });
    const run = async (args: string[], env: Record<string, string> = { CODEX_THREAD_ID: "thread-1", CODEX_TOOL_CALL_ID: "call" }) => {
      const { code, stdout } = await exec(args, { AGENT_HOST_RELAY_URL: `http://127.0.0.1:${port}`, MAU_LOCAL_BROWSER: local, ...env });
      return { code, stdout };
    };
    // Nothing opened yet: the owner's browser, as before.
    expect(await run(["snapshot", "-i"])).toEqual({ code: 0, stdout: "remote: snapshot -i\n" });
    // A page served here goes to the environment's browser with the same arguments, and the commands after it follow.
    expect(await run(["open", "http://localhost:3000/pricing"])).toEqual({ code: 0, stdout: "local: open http://localhost:3000/pricing\n" });
    expect(await run(["snapshot", "-i"])).toEqual({ code: 0, stdout: "local: snapshot -i\n" });
    expect(await run(["click", "@e2"])).toMatchObject({ code: 3 });
    for (const target of ["localhost:5173", "http://127.0.0.1:8080/", "http://[::1]:3000/", "http://app.localhost/", "http://0.0.0.0:3000/"])
      expect(await (await run(["--json", "open", target])).stdout, target).toBe(`local: --json open ${target}\n`);
    expect((await run(["tab", "new", "http://localhost:3000/b"])).stdout).toBe("local: tab new http://localhost:3000/b\n");
    // A page that did not open moves nothing: the commands after it stay with the page that is open.
    expect((await run(["open", "https://refused.example/"])).code).toBe(1);
    expect((await run(["snapshot"])).stdout).toBe("local: snapshot\n");
    expect((await run(["open", "https://example.com/"])).stdout).toBe("remote: open https://example.com/\n");
    expect((await run(["open", "http://localhost:9/fail"])).code).toBe(3);
    expect((await run(["snapshot"])).stdout).toBe("remote: snapshot\n");
    // Another site switches back, and so does closing the environment's browser.
    for (const target of ["https://example.com/", "example.com", "https://localhost.example.com/", "https://notlocalhost/", "https://127.example.test/", "http://10.0.0.5/", "file:///etc/passwd"]) {
      expect((await run(["open", "http://localhost:3000/"])).stdout).toContain("local:");
      expect((await run(["open", target])).stdout, target).toBe(`remote: open ${target}\n`);
      expect((await run(["snapshot"])).stdout).toBe("remote: snapshot\n");
    }
    expect((await run(["open", "http://localhost:3000/"])).stdout).toContain("local:");
    expect((await run(["close"])).stdout).toBe("local: close\n");
    expect((await run(["snapshot"])).stdout).toBe("remote: snapshot\n");
    expect(remote.at(-1)).toEqual(["snapshot"]);
    // Each Codex conversation has its own session there; a partner whose kernel does not relay shares one and needs no relay.
    expect(await run(["open", "http://localhost:3000/"], {})).toEqual({ code: 0, stdout: "local: open http://localhost:3000/\n" });
    expect(await run(["get", "title"], {})).toEqual({ code: 0, stdout: "local: get title\n" });
    expect((await run(["snapshot"])).stdout).toBe("remote: snapshot\n");
    const sessionNames = new Set(readFileSync(log, "utf8").trim().split("\n").map(line => line.split(" ")[0]));
    expect(sessionNames.size).toBe(2);
    for (const name of sessionNames) expect(name).toMatch(/^mau-[a-f0-9]{32}$/);
    expect((await run(["--profile", "test-profile", "open", "http://localhost:3000/"])).stdout).toBe("local: --profile test-profile open http://localhost:3000/\n");
    expect((await run(["skills", "get", "core"], {})).stdout).toBe("local: skills get core\n");
    // The browser is installed in the background after an environment's first start.
    const early = await exec(["open", "http://localhost:3000/"], { MAU_LOCAL_BROWSER: join(root, "missing") });
    expect([early.code, early.stderr]).toEqual([75, expect.stringContaining("try again in a few minutes")]);
  } finally { server.close(); }
});

it("installs nothing for a kernel whose shell does not relay, and gives it the same guides with the tool", async () => {
  let calls = 0;
  const apps = { reader: () => async () => { calls++; return { status: "completed", tools: [{ name: "google_gmail__gws_read" }] }; },
    connections: () => ["google-gmail", "work-feishu"] } as unknown as ConnectedApps;
  const box = sandbox(true), manager = new skills.AgentSkills(apps, () => connections);
  // A run on such a kernel reads no catalog and writes no file: the commands in the shell would not work for it.
  // What a Codex partner of the same environment has there stays as it is.
  await new skills.AgentSkills(apps, () => connections).install("codex", "agent", "owner", "binding", async () => box.files);
  calls = 0;
  expect(await manager.install("claude", "agent", "owner", "binding", async () => box.files)).toMatchObject({ commands: ["agent-browser"], skills: [], removed: [] });
  // Once per environment: a later run, also of another such kernel, writes nothing again.
  expect(await manager.install("agy", "agent", "owner", "binding", async () => box.files)).toBeUndefined();
  expect(await manager.install(undefined, "agent", "owner", "binding", async () => box.files)).toBeUndefined();
  // No catalog is read. Only the command for the environment's own pages is installed, which needs no connection.
  expect([calls, existsSync(join(box.codex, "skills/google-gmail/SKILL.md")), existsSync(join(box.bin, "gws"))]).toEqual([0, true, true]);
  expect(readFileSync(join(box.bin, "agent-browser"), "utf8")).toBe(skills.BROWSER_CLIENT);
  // Its catalog carries the guide of each connection whose CLI tools it lists, with the tools that run the command.
  const guides = manager.toolGuides("claude")!;
  expect(guides(["google_gmail__gws_read", "google_gmail__gws_write", "google_gmail__get_thread", "work_feishu__cli_read", "coco_browser__handoff_start", "drive__gws_read"])).toEqual({
    guidesNote: skills.TOOL_GUIDES,
    guides: [{ connection: "google-gmail", command: "gws", read: "google_gmail__gws_read", write: "google_gmail__gws_write", guide: expect.stringContaining("gws gmail +triage") },
      { connection: "work-feishu", command: "lark-cli", read: "work_feishu__cli_read", guide: expect.stringContaining("lark-cli skills read lark-shared") }] });
  expect(guides(["google_gmail__get_thread"])).toEqual({});
  expect(skills.TOOL_GUIDES).toBe("Each guide describes a connection's official command line. That command does not run in your shell here: run it through this tool. " +
    "Take a command from the guide, leave out the command's name, and pass the rest as arguments.args (one string per argument) with action=call and the tool named in read. " +
    "A command the connector classifies as a write is refused there with an error ending in _command_requires_write_tool: call the tool named in write with the same args. " +
    "Where a guide says to run something in your shell, it means this.");
  // A kernel whose shell relays is installed for, as before, and its catalog carries no guides.
  expect(manager.toolGuides("codex")).toBeUndefined();
  expect(await manager.install("codex", "agent", "owner", "binding", async () => box.files)).toMatchObject({ skills: ["google-gmail"], commands: ["gws", "agent-browser"] });
  expect(existsSync(join(box.bin, "gws"))).toBe(true);
  expect(box.writes()).toBe(0);
});

it("refuses symlinks for .codex, skills directory, skill subdirectories and SKILL.md without modifying targets", async () => {
  const apps = { reader: () => async () => ({ status: "completed", tools: [{ name: "google_gmail__gws_read" }] }),
    connections: () => ["google-gmail"] } as unknown as ConnectedApps;
  // Symlinked skills directory must never be followed or modified.
  const box1 = sandbox(true), victim1 = join(box1.root, "victim"); mkdirSync(victim1);
  symlinkSync(victim1, join(box1.codex, "skills"));
  await expect(new skills.AgentSkills(apps, () => connections).sync("agent", "owner", "b1", async () => box1.files)).rejects.toThrow("agent_skills_install_failed");
  expect(existsSync(join(victim1, "google-gmail"))).toBe(false);
  // Symlinked .codex home directory is refused.
  const box2 = sandbox(true), victim2 = join(box2.root, "victim"); mkdirSync(victim2);
  rmSync(box2.codex, { recursive: true }); symlinkSync(victim2, box2.codex);
  await expect(new skills.AgentSkills(apps, () => connections).sync("agent", "owner", "b2", async () => box2.files)).rejects.toThrow("agent_skills_install_failed");
  expect(existsSync(join(victim2, "skills"))).toBe(false);
  // Symlinked SKILL.md is refused without clobbering target.
  const box3 = sandbox(true), secret = join(box3.root, "secret.txt"); writeFileSync(secret, "keep-me");
  mkdirSync(join(box3.codex, "skills/google-gmail"), { recursive: true });
  symlinkSync(secret, join(box3.codex, "skills/google-gmail/SKILL.md"));
  await expect(new skills.AgentSkills(apps, () => connections).sync("agent", "owner", "b3", async () => box3.files)).rejects.toThrow("agent_skills_install_failed");
  expect(readFileSync(secret, "utf8")).toBe("keep-me");
});

it("installs the same commands once for a shared employee sandbox independently of account assignment", async () => {
  const box = sandbox(true);
  const apps = { employeePermissions: true, reader: () => { throw new Error("no assignment needed for command installation"); } } as unknown as ConnectedApps;
  const manager = new skills.AgentSkills(apps, () => []);
  expect(await manager.install("claude", "lead", "binding-owner", "shared", async () => box.files)).toMatchObject({
    commands: ["gws", "lark-cli", "agent-browser"],
  });
  for (const kernel of ["codex", "agy", "dsh", "openclaw"]) {
    expect(manager.toolGuides(kernel)).toBeUndefined();
    expect(await manager.install(kernel, "employee", "binding-owner", "shared", async () => box.files)).toBeUndefined();
  }
});

it("retires unedited Mau guides only after the official skills arrive and preserves neighboring assets and local edits", async () => {
  const box = sandbox(true), ids = ["coco-browser", "work-feishu", "google-gmail"];
  const old = { reader: () => async () => ({ status: "completed", tools: ["coco_browser__agent_browser_read", "work_feishu__cli_read", "google_gmail__gws_read"].map(name => ({ name })) }),
    connections: () => ids } as unknown as ConnectedApps;
  await new skills.AgentSkills(old, () => connections).sync("agent", "owner", "shared", async () => box.files);
  const dir = (name: string) => join(box.codex, "skills", name);
  const file = (name: string) => join(dir(name), "SKILL.md");
  const original = readFileSync(file("agent-browser"), "utf8");
  const edited = readFileSync(file("feishu"), "utf8") + "Owner's instructions.\n";
  writeFileSync(file("feishu"), edited); writeFileSync(join(dir("agent-browser"), "my-notes.md"), "notes");
  const make = () => new skills.AgentSkills({ employeePermissions: true } as ConnectedApps, () => []);
  const manager = make(), install = (m: skills.AgentSkills) => m.install("codex", "agent", "owner", "shared", async () => box.files);
  expect(await install(manager)).toMatchObject({ awaitingOfficialSkills: true, removed: [] });
  expect(readFileSync(file("agent-browser"), "utf8")).toBe(original);
  for (const name of ["agent-browser", "gws-gmail", "lark-shared"]) {
    const official = join(box.codex, "..", ".agents", "skills", name);
    mkdirSync(official, { recursive: true }); writeFileSync(join(official, ".agent-environment-version"), "release");
    writeFileSync(join(official, "SKILL.md"), "upstream");
  }
  await Promise.all([install(manager), install(make())]);
  expect(await install(manager)).toBeUndefined();
  expect(await install(make())).toMatchObject({ removed: [] });
  expect(existsSync(file("agent-browser"))).toBe(false); expect(existsSync(file("google-gmail"))).toBe(false);
  expect(readFileSync(file("feishu"), "utf8")).toBe(edited);
  expect(readFileSync(join(dir("agent-browser"), "my-notes.md"), "utf8")).toBe("notes");
  const backups = readdirSync(dir("agent-browser")).filter(name => name.startsWith(".mau-retired-"));
  expect(backups).toHaveLength(1); expect(readFileSync(join(dir("agent-browser"), backups[0]!, "guide.md"), "utf8")).toBe(original);
});

it("keeps user skills and skips symlinks at the Codex root, named directory and skill file during employee migration", async () => {
  const box = sandbox(true), root = join(box.codex, "skills"), victim = join(box.root, "custom");
  mkdirSync(victim); writeFileSync(join(victim, "SKILL.md"), "my skill");
  const apps = { employeePermissions: true } as ConnectedApps;
  const install = () => new skills.AgentSkills(apps, () => []).install("codex", "agent", "owner", "shared", async () => box.files);
  symlinkSync(victim, root);
  expect(await install()).toMatchObject({ removed: [] }); expect(lstatSync(root).isSymbolicLink()).toBe(true);
  rmSync(root); mkdirSync(root);
  symlinkSync(victim, join(root, "agent-browser"));
  mkdirSync(join(root, "feishu")); symlinkSync(join(victim, "SKILL.md"), join(root, "feishu/SKILL.md"));
  mkdirSync(join(root, "google-gmail")); writeFileSync(join(root, "google-gmail/SKILL.md"), "custom gmail");
  expect(await install()).toMatchObject({ removed: [] });
  expect(lstatSync(join(root, "agent-browser")).isSymbolicLink()).toBe(true);
  expect(lstatSync(join(root, "feishu/SKILL.md")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(root, "google-gmail/SKILL.md"), "utf8")).toBe("custom gmail");
  renameSync(box.codex, box.codex + "-saved"); symlinkSync(box.codex + "-saved", box.codex);
  expect(await install()).toMatchObject({ removed: [] }); expect(lstatSync(box.codex).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(victim, "SKILL.md"), "utf8")).toBe("my skill");
});
