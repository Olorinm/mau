import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PARTNER_KERNELS, modelServices, sessionShell, shellRelay } from "../src/kernels.js";
import { connectedAppsSchema } from "../src/connected-apps.js";
import { connectorAccountsSchema } from "../src/connector-accounts.js";
import { environmentOptionsSchema } from "../src/environments.js";
import { readModelOptions } from "../src/model-settings.js";

// What Mau knows about each kernel a profile may offer beside its main one.
it("offers codex, claude, agy and dsh as other kernels, each with its model service", () => {
  expect(PARTNER_KERNELS).toEqual(["codex", "claude", "agy", "dsh"]);
  expect(modelServices(["claude", "dsh"])).toEqual(["anthropic", "deepseek"]);
  expect(modelServices(["codex"])).toEqual(["openai"]);
  expect(modelServices(["codex", "claude"])).toEqual(["openai", "anthropic"]);
  expect(modelServices(["codex", "agy"])).toEqual(["openai", "google"]);
  expect(modelServices(["agy", "codex", "claude", "agy"])).toEqual(["google", "openai", "anthropic"]);
  // A kernel that is not known here leaves the provider's default in place.
  expect(modelServices(["codex", "hermes"])).toBeUndefined();
  expect(modelServices(["agy", "constructor"])).toBeUndefined();
});

it("uses Codex command receipts on the default Host and native session IDs on the shared Host", () => {
  expect(shellRelay("codex")).toBe(true);
  for (const kernel of ["codex", "claude", "agy", "dsh", "opencode", "kimi", "hermes", "pi"]) expect(sessionShell(kernel)).toBe(true);
  expect(sessionShell("openclaw")).toBe(false);
  for (const kernel of ["claude", "agy", "hermes", "constructor", undefined]) expect(shellRelay(kernel), String(kernel)).toBe(false);
});

it("accepts agy among a profile's other kernels and refuses a kernel that is not offered this way", () => {
  const profile = (otherKernels: unknown) => ({ configFile: "providers.json", profiles: [{ id: "cloud", label: "Cloud", owners: ["alice"], provider: "cloud", template: "base",
    kernel: "codex", runtimeId: "personal", hostConfigFile: "host.json", otherKernels }] });
  const parsed = environmentOptionsSchema.parse(profile([{ kernel: "claude", runtimeId: "claude" }, { kernel: "agy", runtimeId: "agy" }]));
  expect(parsed.profiles[0]!.otherKernels).toEqual([{ kernel: "claude", runtimeId: "claude", files: [] }, { kernel: "agy", runtimeId: "agy", files: [] }]);
  for (const kernel of ["hermes", "kimi", "gemini", "AGY"]) expect(environmentOptionsSchema.safeParse(profile([{ kernel, runtimeId: "other" }])).success, kernel).toBe(false);
});

it("reads an agy runtime's choices from its owner's allowed list: the kernel reports no model catalog", () => {
  // What Agent Host's discovery returns for an ACP runtime: negotiated capabilities, no `native.models`.
  const discovered = { id: "agy", kernel: "agy", model: "gemini-4-neon",
    allowedSettings: { model: { values: ["gemini-4-neon", "gemini-3.8-flash"] }, effort: { values: ["low", "medium", "high"] } },
    native: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { resume: {}, list: {} },
      initialization: { agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" } } } };
  expect(readModelOptions(discovered)).toEqual({ kernel: "agy", defaultModel: "gemini-4-neon", efforts: ["low", "medium", "high"],
    models: [{ id: "gemini-4-neon", label: "gemini-4-neon", efforts: ["low", "medium", "high"] }, { id: "gemini-3.8-flash", label: "gemini-3.8-flash", efforts: ["low", "medium", "high"] }] });
});

it("the agy example runtime shares the main runtime's directory and never waits for an answer nobody can give", () => {
  const example = JSON.parse(readFileSync(new URL("../examples/cloud/host-agy-partner.json", import.meta.url), "utf8"));
  const [main, agy] = example.runtimes;
  expect([main.kernel, agy.kernel, agy.id]).toEqual(["codex", "agy", "agy"]);
  expect(agy.cwd).toBe(main.cwd);
  // The key comes from a file of the environment, never from this configuration.
  expect(agy.command).toBe("sh");
  expect(agy.args[0]).toBe("-c");
  expect(agy.args[1]).toMatch(/GEMINI_API_KEY="\$\(cat [^ ]+\)" .*exec agy acp --dangerously-skip-permissions\b/);
  // The path Mau recognises as the Gemini API key: the gateway's placeholder when it holds the key, else the key.
  expect(agy.args[1]).toContain('"$(cat /home/user/.gemini/api-key)"');
  expect(agy.env).toBeUndefined();
  // Only what Agent Host accepts in an agy profile.
  expect(Object.keys(agy).filter(key => !["id", "kernel", "cwd", "model", "allowedSettings", "command", "args", "env", "effort", "config"].includes(key))).toEqual([]);
});

it("configures the four partners on three runtimes and opts into employee connector authorization", () => {
  const example = (name: string) => JSON.parse(readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8"));
  const options = example("mau-four-partners.json");
  const profile = environmentOptionsSchema.parse(options.environments)!.profiles[0]!;
  expect(connectedAppsSchema.parse(options.connectedApps)?.authorization).toBe("employee");
  expect(connectorAccountsSchema.safeParse(options.connectorAccounts).success).toBe(true);
  const host = example(profile.hostConfigFile);
  expect(host.sessionRelayTools).toEqual(["connected_apps"]);
  expect(host.runtimes.map((r: { kernel: string; id: string }) => [r.kernel, r.id])).toEqual([
    [profile.kernel, profile.runtimeId], ...profile.otherKernels.map(r => [r.kernel, r.runtimeId]),
  ]);
  const [lead, implementation, advice] = host.runtimes;
  expect([lead.kernel, implementation.kernel, advice.kernel]).toEqual(["claude", "codex", "agy"]);
  expect(implementation.thread).toMatchObject({ sandbox: "workspace-write", approvalPolicy: "on-request" });
  expect(advice.args[1]).toContain("agy acp --dangerously-skip-permissions");
  expect(new Set(host.runtimes.map((r: { cwd: string }) => r.cwd)).size).toBe(1);
  expect(profile.files.slice(-3).map(file => file.destination)).toEqual([
    "/opt/agent-environment/mau-sandbox/SKILL.md", "/opt/agent-environment/official-skills.tgz", "/opt/agent-environment/start.sh",
  ]);
  expect([profile.githubCredentialFile, profile.anthropicCredentialFile]).toEqual(["private/github-token", "private/anthropic-api-key"]);
});
