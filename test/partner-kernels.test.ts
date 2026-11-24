import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DurableStore } from "../src/store.js";
import { privateFile } from "../src/files.js";
import { KERNEL_KEPT, OTHER_KERNELS, incoming } from "../src/partner-text.js";
import { codexAccount } from "../src/environments.js";
import { alice, mauFixture } from "./fixtures/mau.js";
import { partnersFixture, type PartnersFixture, type Turn } from "./fixtures/partners.js";

// An environment can offer more than one kernel: each is a runtime of the same Host in the same working directory.
// A partner recruited into it runs on the kernel the recruit names. The Host here is the scripted fixture; its
// second runtime takes no native tool output, as the Claude runtime of Agent Host reports.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const claude = { kernel: "claude", model: "claude-main", capabilities: { features: { "input.nativeItems": { status: "unsupported" } } } };
const claudeDiscovery = { id: "claude", kernel: "claude", model: "claude-main",
  allowedSettings: { model: { values: ["claude-main", "claude-small"] }, effort: { values: ["low", "high", "max"] } },
  native: { models: [{ value: "claude-main", displayName: "Main", supportedEffortLevels: ["low", "high", "max"] },
    { value: "claude-small", displayName: "Small", supportedEffortLevels: ["low"] }] } };
const otherKernels = [{ kernel: "claude", runtimeId: "claude" }];
/** The fixture's partner ("helper", on Codex) in an environment that also offers Claude. */
async function mixed(options: Parameters<typeof partnersFixture>[1] = {}) {
  const f = await partnersFixture(cleanup, { runtimes: { claude }, profile: { otherKernels }, ...options });
  f.discovery("claude", claudeDiscovery);
  return f;
}
/** An owner turn of a partner that stays open, and the partners tool called as that turn. */
async function ownerTurn(f: PartnersFixture, agentId: string, index = 0) {
  await f.say(agentId, "Work with my partners");
  const turn = await f.turnOf(agentId, index), admission = await f.admission(turn);
  let calls = 0;
  return { turn, call: (input: Record<string, unknown>) => f.mau.partners.execute(admission, input, `${turn.runId}-direct-${++calls}`) as Promise<any> };
}
const operation = async (f: PartnersFixture) => (await f.api(f.path)).data.operationId as string;

it("a Codex partner recruits a Claude partner into its environment; the message runs on the other runtime and its result returns", async () => {
  const f = await mixed(), seen: Record<string, any> = {};
  f.respond(async (turn: Turn) => {
    if (f.name(turn.agentId) === "writer") return "The draft is in notes/letter.md.";
    if (turn.delivered?.results) return "The writer drafted the letter.";
    seen.roster = await turn.call("partners", { action: "roster", guide: true });
    seen.recruit = await turn.call("partners", { action: "recruit", name: "writer", duty: "Writes the weekly letter", kernel: "claude", model: "claude-small",
      intent: "relay", message: "Draft this week's letter in notes/letter.md." });
    return "I asked writer to draft it.";
  });
  await f.say(f.agent.id, "Have this week's letter drafted");
  const hub = await f.turnOf(f.agent.id), writer = await f.until(() => f.partner("writer"), "recruit"), work = await f.turnOf(writer.id);
  const operationId = await operation(f);
  // The roster lists the environment's kernels; what the other one offers stands beside the recruiter's own choices.
  expect(seen.roster.recruit).toEqual({ kernels: ["codex", "claude"],
    models: [{ id: "large", label: "Large", efforts: ["low", "high"] }, { id: "small", label: "Small", efforts: ["low"] }], efforts: ["low", "high"],
    yours: { kernel: "codex", model: "large", effort: "default" },
    otherKernels: [{ kernel: "claude", models: [{ id: "claude-main", label: "Main", efforts: ["low", "high", "max"] }, { id: "claude-small", label: "Small", efforts: ["low"] }],
      efforts: ["low", "high", "max"], default: { model: "claude-main", effort: "default" } }],
    otherKernelsNote: OTHER_KERNELS });
  expect(seen.recruit).toMatchObject({ status: "recruited", partner: { name: "writer", kernel: "claude", model: "claude-small", effort: "default" }, message: { status: "sent" } });
  // The same sandbox, Host and working directory: no cloud request, the same binding, another runtime.
  expect([f.creates, f.cloud.size]).toEqual([1, 1]);
  const host = (agentId: string) => f.mau.router.connections.configuration(f.service.agent(agentId))!.host!;
  expect(host(writer.id)).toMatchObject({ binding: operationId, runtimeId: "claude", instanceName: "channel-host" });
  expect(host(f.agent.id)).toMatchObject({ binding: operationId, runtimeId: "personal" });
  expect((await f.mau.environments.files(writer.id, operationId)).directory).toBe((await f.mau.environments.files(f.agent.id, operationId)).directory);
  expect([hub.body.runtimeId, work.body.runtimeId]).toEqual(["personal", "claude"]);
  // A runtime without native tool output is given the message as text behind Router's notice, with the partner's
  // model selection, the product tools and its memory, and Mau records the input as delivered, not as a person's.
  const record = f.record(seen.recruit.message.messageId);
  expect(work.body.toolOutput).toBeUndefined();
  expect(work.body.input).toBe(JSON.stringify({ from: { partner: "helper" }, ...incoming(record) }));
  expect(work.body.settings).toEqual({ model: "claude-small" });
  expect(work.body.tools.map((tool: { name: string }) => tool.name)).toEqual(["channel", "partners", "memory", "session_search", "proactive_work"]);
  expect(work.body.instructions).toContain("Name: writer\nDuty: Writes the weekly letter"); expect(work.body.instructions).toContain("<MEMORY.md>");
  expect(f.store(store => store.get<{ inputRole: string }>("business_turn_inputs", `${writer.id}:${operationId}:${work.runId}`))).toMatchObject({ inputRole: "tool" });
  // The result returns to the recruiter on its own kernel, and names what the partner's turn was submitted with.
  const back = await f.turnOf(f.agent.id, 1);
  expect(back.body.runtimeId).toBe("personal");
  expect(back.body.toolOutput).toMatchObject({ namespace: "mau", name: "partners" });
  expect(back.delivered!.results![0]).toMatchObject({ requested: { kernel: "claude", model: "claude-small", effort: "default" }, answer: "The draft is in notes/letter.md." });
  await f.until(async () => (await f.answers(f.agent.id)).length === 2, "answer to the owner");
  // What the owner's console is given beside the text written for the models.
  const shown = async (agentId: string) => (await f.events(agentId)).flatMap((event: any) => event.display ? [event.display] : []);
  expect(await shown(writer.id)).toEqual([{ partnerMessage: { id: record.id, intent: "relay", from: { id: f.agent.id, name: "helper" }, text: "Draft this week's letter in notes/letter.md." } }]);
  expect(await shown(f.agent.id)).toEqual([{ partnerResults: [{ messageId: record.id, partner: { id: writer.id, name: "writer" }, intent: "relay", status: "completed",
    answer: "The draft is in notes/letter.md.", durationMs: expect.any(Number) }] }]);
  // Each partner is listed with its own kernel, and its settings are those of its own runtime.
  expect((await f.api("/partners")).data.data).toMatchObject([{ name: "helper", kernel: "codex" },
    { name: "writer", kernel: "claude", model: "claude-small", sharesEnvironmentOf: f.agent.id, recruitedBy: { id: f.agent.id, name: "helper" } }]);
  expect((await f.api(`/agents/${writer.id}`)).data).toMatchObject({ kernel: "claude", host: { runtimeId: "claude" }, environment: { sharedFrom: f.agent.id, state: "ready" } });
  expect((await f.api(`/agents/${f.agent.id}`)).data).toMatchObject({ kernel: "codex", host: { runtimeId: "personal" } });
  expect((await f.api(`/agents/${writer.id}/model-settings`)).data).toMatchObject({ kernel: "claude", defaultModel: "claude-main", selection: { model: "claude-small" },
    models: [{ id: "claude-main" }, { id: "claude-small" }] });
  expect((await f.api("/options")).data.environments).toEqual([{ id: "cloud", label: "Cloud", kernel: "codex", kernels: ["codex", "claude"] }]);
  // Background observers are told each partner's runtime and kernel; the relay of native wake-ups takes the Codex ones.
  expect(f.mau.environments.readyBindings()).toEqual([{ agentId: f.agent.id, operationId, kernel: "codex", runtimeId: "personal" },
    { agentId: writer.id, operationId, kernel: "claude", runtimeId: "claude" }]);
}, 90_000);

it("checks a recruit against the kernel it names, carries nothing over to another kernel, and keeps a partner on its kernel", async () => {
  const f = await mixed(), end = f.hold();
  // The recruiter has a selection of its own, which a partner on its kernel inherits.
  expect((await f.api(`/agents/${f.agent.id}/model-settings`, { model: "small", effort: "low" }, "alice", "/_mau/v1", "PUT")).status).toBe(200);
  const { turn, call } = await ownerTurn(f, f.agent.id);
  const refused = async (input: Record<string, unknown>, error: string, more: Record<string, unknown> = {}) =>
    expect(await call({ action: "recruit", name: "writer", duty: "Writes", ...input }), JSON.stringify(input)).toMatchObject({ isError: true, error, ...more });
  await refused({ kernel: "pi" }, "partner_kernel_not_available", { allowed: ["codex", "claude"], instruction: "Use a kernel listed by roster, or leave kernel empty to use your own." });
  await refused({ kernel: "claude", model: "small" }, "partner_model_not_available", { allowed: ["claude-main", "claude-small"] });
  await refused({ kernel: "claude", model: "claude-small", effort: "high" }, "partner_effort_not_available", { allowed: ["low"] });
  await refused({ kernel: "claude", effort: "xhigh" }, "partner_effort_not_available", { allowed: ["low", "high", "max"] });
  expect(f.partner("writer")).toBeUndefined();
  // Another kernel: the recruiter's model and effort are not carried over. Its own kernel: they are.
  expect(await call({ action: "recruit", name: "writer", duty: "Writes", kernel: "claude" })).toMatchObject({ status: "recruited", partner: { kernel: "claude", model: "default", effort: "default" } });
  expect(await call({ action: "recruit", name: "editor", duty: "Edits", kernel: "claude", effort: "max" })).toMatchObject({ status: "recruited", partner: { kernel: "claude", model: "default", effort: "max" } });
  expect(await call({ action: "recruit", name: "clerk", duty: "Files" })).toMatchObject({ status: "recruited", partner: { kernel: "codex", model: "small", effort: "low" } });
  expect(await call({ action: "recruit", name: "scout", duty: "Looks things up", kernel: "codex", model: "large" })).toMatchObject({ partner: { kernel: "codex", model: "large", effort: "low" } });
  // A dismissed partner returns on the kernel it has, and its settings are checked against that kernel.
  expect(await call({ action: "dismiss", name: "writer" })).toMatchObject({ status: "dismissed" });
  expect(await call({ action: "recruit", name: "writer", duty: "Writes", kernel: "codex", model: "large" })).toMatchObject({ isError: true, error: "partner_model_not_available", allowed: ["claude-main", "claude-small"] });
  expect(await call({ action: "recruit", name: "writer", duty: "Writes", kernel: "codex", model: "claude-small" })).toMatchObject({ status: "restored", kernelKept: KERNEL_KEPT,
    partner: { kernel: "claude", model: "claude-small" } });
  expect(await call({ action: "recruit", name: "writer", duty: "Writes" })).toMatchObject({ isError: true, error: "partner_name_taken" });
  end(turn);
  // A Claude partner's own roster describes its kernel, and a recruit that names none stays on it.
  const writer = f.partner("writer"), second = await ownerTurn(f, writer.id);
  const roster = await second.call({ action: "roster", guide: true });
  expect(roster.recruit).toMatchObject({ kernels: ["claude", "codex"], yours: { kernel: "claude", model: "claude-small", effort: "default" },
    models: [{ id: "claude-main" }, { id: "claude-small" }], otherKernels: [{ kernel: "codex", models: [{ id: "large" }, { id: "small" }], default: { model: "large", effort: "default" } }] });
  expect(roster.partners.find((partner: { name: string }) => partner.name === "clerk")).toMatchObject({ kernel: "codex", model: "small", recruitedBy: "helper" });
  expect(await second.call({ action: "recruit", name: "proof", duty: "Proofreads" })).toMatchObject({ status: "recruited", partner: { kernel: "claude", model: "claude-small" } });
  expect((await f.api(`/agents/${f.partner("proof").id}`)).data).toMatchObject({ kernel: "claude", environment: { sharedFrom: f.agent.id } });
  end(second.turn);
}, 90_000);

it("refuses a kernel the profile offers when the environment's Host does not have its runtime, before anything is created", async () => {
  // The profile and its Host configuration name the runtime; the running Host does not have it (it was not restarted).
  const f = await partnersFixture(cleanup, { runtimes: {}, profile: { otherKernels },
    hostConfigRuntimes: [{ id: "personal", kernel: "codex", cwd: "/home/user/workspace" }, { id: "claude", kernel: "claude", cwd: "/home/user/workspace" }] });
  const end = f.hold(), { turn, call } = await ownerTurn(f, f.agent.id);
  expect(await call({ action: "recruit", name: "writer", duty: "Writes", kernel: "claude" })).toMatchObject({ isError: true, error: "partner_kernel_not_available",
    kernel: "claude", reason: "kernel_runtime_unavailable" });
  expect(f.partner("writer")).toBeUndefined();
  expect(f.store(store => store.entries("partner_recruits"))).toEqual([]);
  // The roster still lists the kernel and says that its models cannot be read.
  expect((await call({ action: "roster", guide: true })).recruit.otherKernels).toMatchObject([{ kernel: "claude", models: [], unavailable: expect.stringContaining("could not be read") }]);
  // The owner's API refuses the same way, and names the kernels when one is not offered at all.
  expect(await f.api("/agents", { name: "writer", shareWith: f.agent.id, kernel: "claude" })).toMatchObject({ status: 409, data: { error: "environment_kernel_not_ready", kernel: "claude" } });
  expect(await f.api("/agents", { name: "writer", shareWith: f.agent.id, kernel: "pi" })).toMatchObject({ status: 409, data: { error: "environment_kernel_not_available", kernels: ["codex", "claude"] } });
  expect(f.service.agents(alice).map(agent => agent.name)).toEqual(["helper"]);
  end(turn);
}, 60_000);

it("the owner creates a partner on another kernel of a partner's environment, and its kernel is fixed", async () => {
  const f = await mixed();
  const created = await f.api("/agents", { name: "writer", shareWith: f.agent.id, kernel: "claude", duty: "Writes the weekly letter" });
  expect(created).toMatchObject({ status: 202, data: { kernel: "claude", host: { runtimeId: "claude" }, environment: { sharedFrom: f.agent.id, state: "ready" } } });
  // Repeating the request returns the same partner; naming another kernel for it is refused.
  expect(await f.api("/agents", { name: "writer", shareWith: f.agent.id, kernel: "claude" })).toMatchObject({ status: 202, data: { agent: { id: created.data.agent.id } } });
  expect(await f.api("/agents", { name: "writer", shareWith: f.agent.id })).toMatchObject({ status: 202, data: { kernel: "claude" } });
  expect(await f.api("/agents", { name: "writer", shareWith: f.agent.id, kernel: "codex" })).toMatchObject({ status: 409, data: { error: "environment_already_bound" } });
  // Without a kernel the partner runs on the environment's main one, as before.
  expect(await f.api("/agents", { name: "clerk", shareWith: f.agent.id })).toMatchObject({ status: 202, data: { kernel: "codex", host: { runtimeId: "personal" } } });
  // The owner's message to the Claude partner is an ordinary turn on its runtime.
  f.respond(() => "Noted.");
  await f.say(created.data.agent.id, "Hello");
  const turn = await f.turnOf(created.data.agent.id);
  expect([turn.body.runtimeId, turn.body.input.split("\n")[0], turn.body.toolOutput]).toEqual(["claude", "Hello", undefined]);
  expect(f.creates).toBe(1);
}, 60_000);

it("an environment with one kernel is set up, bound and offered exactly as before", async () => {
  const f = await partnersFixture(cleanup), operationId = await operation(f);
  const instance = [...f.cloud.values()][0]!, directory = "/home/user/.agent-host-service";
  // The Host configuration reaches the sandbox byte for byte, with the hash the Host checks before it starts.
  const config = readFileSync(f.hostConfigFile);
  expect(Buffer.from(instance.files.get(`${directory}/host.json`) as string).equals(config)).toBe(true);
  const token = instance.files.get(`${directory}/token`) as string;
  expect(instance.files.get(`${directory}/ready.json`)).toBe(JSON.stringify({ version: 1, configSha256: sha256(config), tokenSha256: sha256(token) }));
  expect([...instance.files.keys()].sort()).toEqual([`${directory}/host.json`, `${directory}/ready.json`, `${directory}/token`]);
  // What identifies the environment is computed from the same members as before: an existing binding stays valid.
  const journal = new DurableStore(join(f.directory, "mau", "environments.sqlite"), "example.test");
  try {
    expect(journal.get<{ profileHash: string }>("environments", f.agent.id)!.profileHash)
      .toBe(sha256(JSON.stringify(["cloud", "tools", "codex", "personal", directory, 37420])));
  } finally { journal.close(); }
  // Router is given the same Host binding, which its sessions are fingerprinted by.
  const channels = () => readFileSync(join(f.mau.router.connections.agentDirectory(f.agent.id), "channels.json"), "utf8");
  expect(JSON.parse(channels()).agents[0].host).toEqual({ runtimeId: "personal", instanceName: "channel-host",
    instructions: "Work carefully.\nAnswer in the owner's language.", binding: operationId });
  // The roster offers what it offered: one kernel, and no member about other kernels.
  const end = f.hold(), first = await ownerTurn(f, f.agent.id);
  const roster = await first.call({ action: "roster", guide: true });
  expect(Object.keys(roster.recruit)).toEqual(["kernels", "models", "efforts", "yours"]);
  expect(roster.recruit.kernels).toEqual(["codex"]);
  expect(await first.call({ action: "recruit", name: "trip", duty: "Plans the trip" })).toMatchObject({ status: "recruited", partner: { kernel: "codex" } });
  expect(JSON.parse(readFileSync(join(f.mau.router.connections.agentDirectory(f.partner("trip").id), "channels.json"), "utf8")).agents[0].host).toMatchObject({ runtimeId: "personal", binding: operationId });
  end(first.turn);
  await f.until(async () => (await f.answers(f.agent.id)).length === 1, "first answer");
  // Offering another kernel later changes nothing for the partners that exist: the binding, Router's Host scope and
  // the files in the sandbox stay as they are, and the next turn runs in the same session.
  const before = channels(), session = first.turn.body.sessionId;
  writeFileSync(f.hostConfigFile, JSON.stringify({ stateDirectory: "state", runtimes: [{ id: "personal", kernel: "codex", cwd: "/home/user/workspace" },
    { id: "claude", kernel: "claude", cwd: "/home/user/workspace" }] }));
  await f.restart({ nativeWork: { partnerTools: true } });
  expect((await f.api(f.path)).data).toMatchObject({ state: "ready", operationId });
  expect(channels()).toBe(before);
  expect(Buffer.from(instance.files.get(`${directory}/host.json`) as string).equals(config)).toBe(true);
  f.respond(() => "Still here.");
  await f.say(f.agent.id, "Are you there?");
  const next = await f.turnOf(f.agent.id, 1);
  expect([next.body.sessionId, next.body.runtimeId, next.body.instructions]).toEqual([session, "personal", first.turn.body.instructions]);
  expect(JSON.stringify(next.body.tools)).toBe(JSON.stringify(first.turn.body.tools));
}, 90_000);

it("sets up an environment with one kernel through the same provider requests and sandbox operations as before", async () => {
  // Recorded on the release before a profile could offer other kernels, for this profile: the requests that create
  // and resume the environment member for member, every command and every file written to the sandbox, in order,
  // and what Router is given for the partner and for one that shares with it.
  const login = { fixture: "not-a-credential" };
  const f = await mauFixture(cleanup), source = join(f.directory, "native-login.json"), log: unknown[][] = [];
  privateFile(source, login);
  f.mau.environments.options.profiles[0]!.files.push({ source, destination: "/home/user/.codex/auth.json" });
  const { create, resume, exec, writeFile } = f.provider, directory = "/home/user/.agent-host-service", requests: unknown[][] = [];
  f.provider.create = async (...args) => { requests.push(["create", ...args]); return create(...args); };
  f.provider.resume = async (...args) => { requests.push(["resume", ...args]); return resume(...args); };
  f.provider.exec = (id, argv, options) => { log.push(["exec", ...argv]); return exec(id, argv, options); };
  f.provider.writeFile = async (id, path, data) => { log.push(["write", path, /token|ready/.test(path) ? "" : sha256(data)]); return writeFile(id, path, data); };
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  const { operationId } = await f.settled();
  expect(log).toEqual([
    ["exec", "mkdir", "-p", "--", directory], ["exec", "chmod", "--", "700", directory],
    ["exec", "mkdir", "-p", "--", "/home/user/.codex"], ["exec", "chmod", "--", "700", "/home/user/.codex"],
    ["write", "/home/user/.codex/auth.json", sha256(readFileSync(source))], ["exec", "chmod", "--", "600", "/home/user/.codex/auth.json"],
    ["write", `${directory}/host.json.upload`, sha256(readFileSync(f.hostConfigFile))], ["write", `${directory}/token.upload`, ""],
    ["exec", "chmod", "--", "600", `${directory}/host.json.upload`, `${directory}/token.upload`],
    ["exec", "mv", "--", `${directory}/host.json.upload`, `${directory}/host.json`], ["exec", "mv", "--", `${directory}/token.upload`, `${directory}/token`],
    ["write", `${directory}/ready.json.upload`, ""], ["exec", "mv", "--", `${directory}/ready.json.upload`, `${directory}/ready.json`]]);
  // A paused environment is resumed with its id and lifetime, and nothing else.
  expect((await f.api(f.path + "/pause", {})).status).toBe(202); expect((await f.settled()).state).toBe("paused");
  expect((await f.api(f.path + "/resume", {})).status).toBe(202); expect((await f.settled()).state).toBe("ready");
  expect(requests).toStrictEqual([["create", { template: "tools", timeoutSeconds: 3600, onTimeout: "kill", metadata: { "mau-operation": operationId } }],
    ["resume", [...f.cloud.keys()][0], 3600]]);
  expect(JSON.stringify(requests[0]![1])).toBe(`{"template":"tools","timeoutSeconds":3600,"onTimeout":"kill","metadata":{"mau-operation":"${operationId}"}}`);
  const scout = (await f.api("/agents", { name: "scout", shareWith: f.agent.id, duty: "Watches the inbox" })).data.agent;
  const channels = (agentId: string) => readFileSync(join(f.mau.router.connections.agentDirectory(agentId), "channels.json"), "utf8");
  expect(channels(f.agent.id)).toBe(JSON.stringify({ agents: [{ agentId: f.agent.id, connections: [], host: { runtimeId: "personal", instanceName: "channel-host",
    instructions: "Work carefully.\nAnswer in the owner's language.", binding: operationId } }] }, null, 2) + "\n");
  expect(channels(scout.id)).toBe(JSON.stringify({ agents: [{ agentId: scout.id, connections: [], host: { binding: operationId, runtimeId: "personal", instanceName: "channel-host",
    instructions: "Work carefully.\nAnswer in the owner's language.\n\n## Partner identity\n\nName: scout\nDuty: Watches the inbox\n\n" +
      "You are this partner. Where other instructions or files in this environment give a different name or role, this section applies to you." } }] }, null, 2) + "\n");
}, 60_000);

it("names the model endpoints of a profile that offers other kernels to the provider, and uploads each kernel's private files", async () => {
  const requests: Array<{ call: string; modelServices: unknown }> = [];
  const observe = (f: Awaited<ReturnType<typeof mauFixture>>) => {
    const { create, resume } = f.provider;
    f.provider.create = async (input) => { requests.push({ call: "create", modelServices: (input as { modelServices?: unknown }).modelServices }); return create(input); };
    f.provider.resume = async (id, seconds, options) => { requests.push({ call: "resume", modelServices: options?.modelServices }); return resume(id, seconds, options); };
  };
  // One kernel names none (the test above pins its requests whole): the provider's default decides.
  const single = await mauFixture(cleanup); observe(single);
  expect((await single.api(single.path, { profileId: "cloud" })).status).toBe(202);
  expect((await single.settled()).state).toBe("ready");
  expect(requests).toEqual([{ call: "create", modelServices: undefined }]);
  requests.length = 0;
  const credentials = join(single.directory, "claude-settings.json");
  privateFile(credentials, { env: { EXAMPLE_MODEL_KEY: "fixture-not-a-credential" } });
  // Other kernels: the services of all the profile's kernels, the main one's included.
  const f = await mauFixture(cleanup, { runtimes: { claude }, profile: { files: [{ source: join(single.directory, "profile.json"), destination: "/home/user/.codex/auth.json" }],
    otherKernels: [{ kernel: "claude", runtimeId: "claude", files: [{ source: credentials, destination: "/home/user/.claude/settings.json" }] }] } });
  observe(f);
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");
  expect(requests).toEqual([{ call: "create", modelServices: ["openai", "anthropic"] }]);
  const files = [...f.cloud.values()][0]!.files;
  expect(Buffer.from(files.get("/home/user/.claude/settings.json") as Uint8Array).toString()).toBe(readFileSync(credentials, "utf8"));
  expect(files.has("/home/user/.codex/auth.json")).toBe(true);
  // A resume names them again, so an environment created before a kernel was offered gets its endpoints at its next start.
  expect((await f.api(f.path + "/pause", {})).status).toBe(202); expect((await f.settled()).state).toBe("paused");
  expect((await f.api(f.path + "/resume", {})).status).toBe(202); expect((await f.settled()).state).toBe("ready");
  expect(requests.at(-1)).toEqual({ call: "resume", modelServices: ["openai", "anthropic"] });
}, 60_000);

it("offers Antigravity beside Codex: its Google model service, its owner's model list, and a partner on the agy runtime", async () => {
  // What Agent Host describes for an agy runtime: an ACP kernel that takes no native tool output and reports no model catalog.
  const agy = { kernel: "agy", model: "gemini-4-neon", capabilities: { features: { "input.nativeItems": { status: "unsupported" } } } };
  const agyDiscovery = { id: "agy", kernel: "agy", model: "gemini-4-neon",
    allowedSettings: { model: { values: ["gemini-4-neon", "gemini-3.8-flash"] }, effort: { values: ["low", "high"] } },
    native: { loadSession: true, sessionCapabilities: { resume: {}, list: {} }, initialization: { agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" } } } };
  const requests: unknown[] = [], seen: Record<string, any> = {};
  const f = await partnersFixture(cleanup, { runtimes: { agy }, profile: { otherKernels: [{ kernel: "agy", runtimeId: "agy" }] } });
  f.discovery("agy", agyDiscovery);
  const { resume } = f.provider;
  f.provider.resume = async (id, seconds, options) => { requests.push(options?.modelServices); return resume(id, seconds, options); };
  f.respond(async (turn: Turn) => {
    if (f.name(turn.agentId) === "gemini") return "Checked with Gemini.";
    if (turn.delivered?.results) return "Gemini checked it.";
    seen.roster = await turn.call("partners", { action: "roster", guide: true });
    seen.refused = await turn.call("partners", { action: "recruit", name: "gemini", duty: "Second opinion", kernel: "agy", model: "large" });
    seen.recruit = await turn.call("partners", { action: "recruit", name: "gemini", duty: "Second opinion", kernel: "agy", model: "gemini-3.8-flash", effort: "low",
      intent: "relay", message: "Review notes/plan.md." });
    return "I asked gemini.";
  });
  await f.say(f.agent.id, "Get a second opinion");
  const partner = await f.until(() => f.partner("gemini"), "recruit"), work = await f.turnOf(partner.id);
  expect(seen.roster.recruit).toMatchObject({ kernels: ["codex", "agy"],
    otherKernels: [{ kernel: "agy", models: [{ id: "gemini-4-neon", label: "gemini-4-neon", efforts: ["low", "high"] }, { id: "gemini-3.8-flash", label: "gemini-3.8-flash", efforts: ["low", "high"] }],
      efforts: ["low", "high"], default: { model: "gemini-4-neon", effort: "default" } }] });
  expect(seen.refused).toMatchObject({ isError: true, error: "partner_model_not_available", allowed: ["gemini-4-neon", "gemini-3.8-flash"] });
  expect(seen.recruit).toMatchObject({ status: "recruited", partner: { name: "gemini", kernel: "agy", model: "gemini-3.8-flash", effort: "low" }, message: { status: "sent" } });
  // The same sandbox and Host, the agy runtime; the message arrives as text, as for any runtime without native tool output.
  expect([f.creates, f.cloud.size]).toEqual([1, 1]);
  expect(work.body.runtimeId).toBe("agy");
  expect(work.body.toolOutput).toBeUndefined();
  expect(JSON.parse(work.body.input).from).toEqual({ partner: "helper" });
  expect(work.body.settings).toEqual({ model: "gemini-3.8-flash", effort: "low" });
  expect((await f.api(`/agents/${partner.id}`)).data).toMatchObject({ kernel: "agy", host: { runtimeId: "agy" }, environment: { sharedFrom: f.agent.id } });
  expect((await f.api("/options")).data.environments).toEqual([{ id: "cloud", label: "Cloud", kernel: "codex", kernels: ["codex", "agy"] }]);
  await f.until(async () => (await f.answers(f.agent.id)).length === 2, "answer to the owner");
  // The provider is told the model services of both kernels when the environment next starts.
  expect((await f.api(f.path + "/pause", {})).status).toBe(202);
  expect((await f.settled()).state).toBe("paused");
  expect((await f.api(f.path + "/resume", {})).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");
  expect(requests.at(-1)).toEqual(["openai", "google"]);
}, 90_000);

it("holds an environment to the ChatGPT account of its Codex sign-in file on create and resume, with an override and an opt-out", async () => {
  const jwt = (account?: string) => `e30.${Buffer.from(JSON.stringify(account ? { "https://api.openai.com/auth": { chatgpt_account_id: account } } : {})).toString("base64url")}.c2ln`;
  expect(codexAccount(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt("account-access"), id_token: jwt("account-id"), account_id: "account-recorded" } }))).toBe("account-access");
  expect(codexAccount(JSON.stringify({ tokens: { access_token: jwt(), id_token: jwt("account-id"), account_id: "account-recorded" } }))).toBe("account-id");
  expect(codexAccount(JSON.stringify({ tokens: { access_token: "opaque", account_id: "account-recorded" } }))).toBe("account-recorded");
  for (const content of ["", "not json", "null", "{}", JSON.stringify({ OPENAI_API_KEY: "fixture-not-a-key" }), JSON.stringify({ auth_mode: "apikey", tokens: { account_id: "account-recorded" } }),
    JSON.stringify({ tokens: { account_id: "not an id" } }), JSON.stringify({ tokens: { account_id: 7 } })]) expect(codexAccount(content), content).toBeUndefined();
  const requests: Array<{ call: string; options: unknown }> = [];
  const run = async (profile: Record<string, unknown>, auth: unknown = { auth_mode: "chatgpt", tokens: { access_token: jwt("account-1"), account_id: "account-1" } }) => {
    requests.length = 0;
    const f = await mauFixture(cleanup, { profile });
    privateFile(join(f.directory, "codex-auth.json"), auth);
    const { create, resume } = f.provider;
    f.provider.create = async (input) => { const { modelServices, modelAccounts } = input as Record<string, unknown>; requests.push({ call: "create", options: { modelServices, modelAccounts } }); return create(input); };
    f.provider.resume = async (id, seconds, options) => { requests.push({ call: "resume", options }); return resume(id, seconds, options); };
    expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202); expect((await f.settled()).state).toBe("ready");
    expect((await f.api(f.path + "/pause", {})).status).toBe(202); expect((await f.settled()).state).toBe("paused");
    expect((await f.api(f.path + "/resume", {})).status).toBe(202); expect((await f.settled()).state).toBe("ready");
    return structuredClone(requests);
  };
  const files = [{ source: "codex-auth.json", destination: "/home/user/.codex/auth.json" }];
  expect(await run({ files })).toEqual([{ call: "create", options: { modelAccounts: { openai: ["account-1"] } } }, { call: "resume", options: { modelAccounts: { openai: ["account-1"] } } }]);
  expect(await run({ files, modelAccounts: { openai: ["account-2", "account-3"] } })).toEqual([{ call: "create", options: { modelAccounts: { openai: ["account-2", "account-3"] } } },
    { call: "resume", options: { modelAccounts: { openai: ["account-2", "account-3"] } } }]);
  expect(await run({ files, modelAccounts: false })).toEqual([{ call: "create", options: {} }, { call: "resume", options: undefined }]);
  // A sign-in file with an API key names no account: the requests are what they were.
  expect(await run({ files }, { OPENAI_API_KEY: "fixture-not-a-key" })).toEqual([{ call: "create", options: {} }, { call: "resume", options: undefined }]);
}, 120_000);

it("refuses a profile whose kernels do not match its Host configuration or repeat", async () => {
  // The other kernel's runtime is missing from the Host configuration, or works in another directory.
  for (const hostConfigRuntimes of [[{ id: "personal", kernel: "codex", cwd: "/home/user/workspace" }],
    [{ id: "personal", kernel: "codex", cwd: "/home/user/workspace" }, { id: "claude", kernel: "claude", cwd: "/home/user/elsewhere" }],
    [{ id: "personal", kernel: "codex", cwd: "/home/user/workspace" }, { id: "claude", kernel: "pi", cwd: "/home/user/workspace" }]]) {
    const f = await mauFixture(cleanup, { profile: { otherKernels }, hostConfigRuntimes });
    expect(await f.api(f.path, { profileId: "cloud" })).toMatchObject({ status: 409, data: { error: "environment_runtime_profile_mismatch" } });
    expect(f.creates).toBe(0);
  }
  await expect(mauFixture(cleanup, { profile: { otherKernels: [{ kernel: "codex", runtimeId: "second" }] } })).rejects.toThrow("duplicate_environment_kernel");
  await expect(mauFixture(cleanup, { profile: { otherKernels: [{ kernel: "claude", runtimeId: "personal" }] } })).rejects.toThrow("duplicate_environment_kernel");
  await expect(mauFixture(cleanup, { profile: { otherKernels: [{ kernel: "hermes", runtimeId: "hermes" }] } })).rejects.toThrow();
}, 60_000);
