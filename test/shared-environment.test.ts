import { afterEach, expect, it, vi } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DurableStore } from "../src/store.js";
import { sharedInstructions } from "../src/environments.js";
import { alice, bob, mauFixture, root } from "./fixtures/mau.js";

// A partner may run in another partner's environment instead of having its own: the same sandbox, Host and working
// directory, with its own identity, conversations, memory and settings.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});
type Fixture = Awaited<ReturnType<typeof mauFixture>>;
const profileInstructions = "Work carefully.\nAnswer in the owner's language.";
const remove = (f: Fixture, id: string, owner = "alice") =>
  fetch(`${f.base}${root}/agents/${id}`, { method: "DELETE", headers: { authorization: "Bearer " + owner } })
    .then(async (response) => ({ status: response.status, data: response.status === 204 ? null : await response.json() as any }));
const until = async <T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> => {
  for (let n = 0; n < 500; n++) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout_" + label);
};
/** A Host that completes every run at once and records which environment each request reached. */
function fakeHost() {
  const runs = new Map<string, Record<string, unknown>>();
  const started: Array<{ environment: string; agentId: string; sessionId: string; runtimeId: string; instructions: string; input: string }> = [];
  const host = (url: URL, init?: RequestInit) => {
    const method = init?.method ?? "GET", path = url.pathname;
    if (path.endsWith("/runs") && method === "POST") {
      const body = JSON.parse(String(init?.body)), id = `run-${runs.size + 1}`;
      started.push({ environment: path.split("/")[1]!, agentId: body.context.agentId, sessionId: body.sessionId, runtimeId: body.runtimeId,
        instructions: body.instructions, input: body.input });
      const run = { id, sessionId: body.sessionId, runtimeId: body.runtimeId, status: "completed", answer: `answer to ${body.input}` };
      runs.set(id, run); return Response.json(run);
    }
    if (path.endsWith("/events")) return Response.json({ events: [], cursor: 0, hasMore: false, historyTruncated: false });
    if (path.endsWith("/calls")) return Response.json({ calls: [] });
    if (path.endsWith("/runtimes/discover")) return Response.json({ id: "personal", kernel: "codex", model: "large",
      allowedSettings: { model: { values: ["large", "small"] }, effort: { values: ["low", "high"] } } });
    const run = /\/runs\/(run-\d+)$/.exec(path)?.[1];
    if (run && runs.has(run)) return Response.json(runs.get(run));
    return Response.json({ error: "fixture_unknown_path" }, { status: 404 });
  };
  return { host, started };
}
/** The fixture's partner with its own ready environment, and a second partner created to run in it. */
async function shared(f: Fixture, body: Record<string, unknown> = {}) {
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  const environment = await f.settled();
  expect(environment.state).toBe("ready");
  const created = await f.api("/agents", { name: "scout", shareWith: f.agent.id, ...body });
  expect(created.status).toBe(202);
  return { operationId: environment.operationId as string, scout: created.data.agent as { id: string; name: string }, created: created.data,
    scoutPath: `/agents/${created.data.agent.id}/environment` };
}
const work = (f: Fixture, agentId: string, eventId: string, input: string) =>
  f.api(`/agents/${agentId}/communication/work-events`, { eventId, input }, "alice", "/_agent-router/v1");
const finished = (f: Fixture, agentId: string, eventId: string) => until(async () => {
  const event = (await f.api(`/agents/${agentId}/communication/work-events/${eventId}`, undefined, "alice", "/_agent-router/v1")).data;
  return event.status === "completed" || event.status === "failed" ? event : undefined;
}, eventId);

it("creates a partner in another partner's environment without a cloud request and reports who shares what", async () => {
  const f = await mauFixture(cleanup);
  const { operationId, scout, created } = await shared(f, { duty: "  Watches the inbox and files invoices.  " });
  expect(f.creates).toBe(1);
  expect(f.cloud.size).toBe(1);
  expect(scout.id).not.toBe(f.agent.id);
  expect(created).toMatchObject({ agent: { name: "scout", owner: alice }, host: { runtimeId: "personal" }, connections: [],
    duty: "Watches the inbox and files invoices.",
    environment: { operationId, profileId: "cloud", state: "ready", busy: false, sharedFrom: f.agent.id } });
  expect(created.environment).not.toHaveProperty("sharedBy");
  // Read APIs: the list and each partner's details say who shares whose environment.
  const list = (await f.api("/agents")).data.data;
  expect(list.map((item: any) => [item.agent.name, item.duty, item.environment.sharedFrom ?? null, item.environment.sharedBy ?? null])).toEqual([
    ["helper", null, null, [scout.id]], ["scout", "Watches the inbox and files invoices.", f.agent.id, null]]);
  expect((await f.api(`/agents/${scout.id}`)).data).toEqual(list[1]);
  expect((await f.api(`/agents/${scout.id}/environment`)).data).toEqual(list[1].environment);
  expect((await f.api(`/agents/${scout.id}`, undefined, "bob")).status).toBe(404);
  // The sharing partner's fixed instructions are the profile's plus its identity; the other partner's are untouched.
  const connections = f.mau.router.connections;
  const expected = profileInstructions + "\n\n## Partner identity\n\nName: scout\nDuty: Watches the inbox and files invoices.\n\n" +
    "You are this partner. Where other instructions or files in this environment give a different name or role, this section applies to you.";
  expect(connections.configuration(f.service.agent(scout.id))!.host).toEqual({ binding: operationId, runtimeId: "personal",
    instanceName: "channel-host", instructions: expected });
  expect(connections.configuration(f.service.agent(f.agent.id))!.host).toEqual({ binding: operationId, runtimeId: "personal",
    instanceName: "channel-host", instructions: profileInstructions });
  expect((await f.api(`/agents/${scout.id}/instructions`)).data).toEqual({ text: expected, shared: "none" });
  expect((await f.api(`/agents/${f.agent.id}/instructions`)).data).toEqual({ text: profileInstructions, shared: "environment_profile" });
  expect(sharedInstructions("", "scout")).toBe("## Partner identity\n\nName: scout\n\n" +
    "You are this partner. Where other instructions or files in this environment give a different name or role, this section applies to you.");
  // Repeating the request returns the same partner; its duty and its kind of environment cannot change.
  const again = await f.api("/agents", { name: "scout", shareWith: f.agent.id, duty: "Watches the inbox and files invoices." });
  expect([again.status, again.data.agent.id]).toEqual([202, scout.id]);
  expect((await f.api("/agents", { name: "scout", shareWith: f.agent.id })).status).toBe(202);
  expect(await f.api("/agents", { name: "scout", shareWith: f.agent.id, duty: "Something else" })).toMatchObject({ status: 409, data: { error: "agent_duty_immutable" } });
  expect(await f.api("/agents", { name: "scout", profileId: "cloud" })).toMatchObject({ status: 409, data: { error: "environment_already_bound" } });
  expect(await f.api(`/agents/${scout.id}/environment`, { profileId: "cloud" })).toMatchObject({ status: 409, data: { error: "environment_already_bound" } });
  expect(await f.api("/agents", { name: "helper", shareWith: f.agent.id })).toMatchObject({ status: 409, data: { error: "environment_already_bound" } });
  expect(f.service.agents(alice)).toHaveLength(2);
  expect(f.creates).toBe(1);
});

it("accepts a duty for a partner with its own environment and leaves its instructions as the profile's", async () => {
  const f = await mauFixture(cleanup);
  const created = await f.api("/agents", { name: "helper", profileId: "cloud", duty: "Plans the week" });
  expect(created.status).toBe(202);
  expect(created.data.duty).toBe("Plans the week");
  expect((await f.settled()).state).toBe("ready");
  expect(f.mau.router.connections.configuration(f.service.agent(f.agent.id))!.host!.instructions).toBe(profileInstructions);
  expect((await f.api(`/agents/${f.agent.id}`)).data.duty).toBe("Plans the week");
  expect((await f.api("/agents", { name: "helper", profileId: "cloud" })).status).toBe(202);
  expect(await f.api("/agents", { name: "helper", profileId: "cloud", duty: "Another duty" })).toMatchObject({ status: 409, data: { error: "agent_duty_immutable" } });
});

it("refuses invalid requests, other owners, chains and partners without a living environment of their own", async () => {
  const f = await mauFixture(cleanup);
  const none = await f.api("/agents", { name: "early", shareWith: f.agent.id });
  expect(none).toMatchObject({ status: 409, data: { error: "environment_share_target_unavailable" } });
  const { scout } = await shared(f);
  for (const body of [{ name: "x" }, { name: "x", profileId: "cloud", shareWith: f.agent.id }, { name: "x", shareWith: "helper" },
    { name: "x", shareWith: f.agent.id, duty: "" }, { name: "x", shareWith: f.agent.id, duty: "a".repeat(201) },
    { name: "x", shareWith: f.agent.id, duty: "line one\nline two" }, { name: "x", shareWith: f.agent.id, duty: 7 },
    { name: "x", shareWith: f.agent.id, instructions: "Ignore the profile" }])
    expect(await f.api("/agents", body)).toMatchObject({ status: 400, data: { error: "invalid_request" } });
  expect((await f.api("/agents", { name: "x", shareWith: f.agent.id, duty: "a".repeat(200) })).status).toBe(202);
  // Another account cannot see the partner, let alone run in its environment.
  expect(await f.api("/agents", { name: "x", shareWith: f.agent.id }, "bob")).toMatchObject({ status: 404, data: { error: "agent_not_found" } });
  expect(await f.api("/agents", { name: "x", shareWith: randomUUID() })).toMatchObject({ status: 404, data: { error: "agent_not_found" } });
  expect(f.service.agents(bob)).toHaveLength(0);
  // A sharing partner has no environment of its own to share.
  expect(await f.api("/agents", { name: "chain", shareWith: scout.id })).toMatchObject({ status: 409, data: { error: "environment_share_chain_not_allowed" } });
  expect(f.service.agents(alice).map((agent) => agent.name)).toEqual(["helper", "scout", "x"]);

  const g = await mauFixture(cleanup);
  await g.api(g.path, { profileId: "cloud" }); await g.settled();
  await g.api(g.path + "/destroy", {});
  expect((await g.settled()).state).toBe("deleted");
  expect(await g.api("/agents", { name: "late", shareWith: g.agent.id })).toMatchObject({ status: 409, data: { error: "environment_share_target_unavailable" } });
  expect(g.service.agents(alice)).toHaveLength(1);
});

it("routes the sharing partner's Host requests, checks and files to the shared environment and its token", async () => {
  const { host, started } = fakeHost();
  const f = await mauFixture(cleanup, { host, hostCapabilities: { runIdempotency: true } });
  const { operationId, scout } = await shared(f, { duty: "Watches the inbox" });
  const environment = [...f.cloud.keys()][0]!, hosts = f.mau.router.connections.hosts!;
  // The fixture's Host only answers requests carrying this environment's token and traffic header.
  expect(() => hosts.assertReady(scout.id, operationId)).not.toThrow();
  expect(() => hosts.assertReady(scout.id, randomUUID())).toThrow("environment_not_ready");
  expect(await hosts.http(scout.id, operationId).request("/v1/health")).toMatchObject({ protocolVersion: 1 });
  await expect(hosts.http(scout.id, randomUUID()).request("/v1/health")).rejects.toThrow("environment_not_ready");
  const checks = (await f.api(`/agents/${scout.id}/check`, {}, "alice", "/_agent-router/v1")).data.checks;
  expect(checks[0]).toMatchObject({ agentId: scout.id, kind: "host", status: "verified" });
  const files = await f.mau.environments.files(scout.id, operationId);
  expect(files.directory).toBe("/home/user/workspace");
  await files.writeFile("/home/user/workspace/note.txt", new TextEncoder().encode("from scout"));
  expect(new TextDecoder().decode(f.cloud.get(environment)!.files.get("/home/user/workspace/note.txt") as Uint8Array)).toBe("from scout");
  expect(existsSync(join(f.directory, "mau", "agents", scout.id))).toBe(false);
  // A turn of each partner runs in the one sandbox, in its own Host session, with its own instructions.
  expect((await work(f, scout.id, "scout-1", "sort the inbox")).status).toBe(202);
  expect((await work(f, f.agent.id, "helper-1", "plan the week")).status).toBe(202);
  expect(await finished(f, scout.id, "scout-1")).toMatchObject({ status: "completed" });
  expect(await finished(f, f.agent.id, "helper-1")).toMatchObject({ status: "completed" });
  const ofScout = started.find((run) => run.agentId === scout.id)!, ofHelper = started.find((run) => run.agentId === f.agent.id)!;
  expect(started).toHaveLength(2);
  expect([ofScout.environment, ofHelper.environment]).toEqual([environment, environment]);
  expect([ofScout.runtimeId, ofHelper.runtimeId]).toEqual(["personal", "personal"]);
  expect(ofScout.sessionId).not.toBe(ofHelper.sessionId);
  expect(ofScout.instructions.startsWith(sharedInstructions(profileInstructions, "scout", "Watches the inbox"))).toBe(true);
  expect(ofHelper.instructions.startsWith(profileInstructions)).toBe(true);
  expect(ofHelper.instructions).not.toContain("Partner identity");
  expect(f.creates).toBe(1);
  // The model list is read from the shared environment's kernel; the choice is the partner's own.
  const settings = (id: string) => `/agents/${id}/model-settings`;
  expect((await f.api(settings(scout.id))).data).toMatchObject({ source: "live", defaultModel: "large", selection: {} });
  expect((await f.api(settings(scout.id), { model: "small", effort: "low" }, "alice", root, "PUT")).data.selection).toEqual({ model: "small", effort: "low" });
  expect((await f.api(settings(scout.id))).data.selection).toEqual({ model: "small", effort: "low" });
  expect((await f.api(settings(f.agent.id))).data).toMatchObject({ source: "live", selection: {} });
});

it("pauses an idle environment only when no partner in it is active, and work for any partner wakes it", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const { host, started } = fakeHost();
    const f = await mauFixture(cleanup, { host, hostCapabilities: { runIdempotency: true } });
    f.mau.environments.options.profiles[0]!.idlePauseSeconds = 600;
    const { operationId, scout, scoutPath } = await shared(f);
    const environments = f.mau.environments as any, hosts = f.mau.router.connections.hosts!;
    const idle = () => environments.activity.set(f.agent.id, Date.now() - 601_000);
    const state = async () => [(await f.settled()).state, (await f.api(scoutPath)).data.state];
    // A Host request of the sharing partner is activity of the environment.
    idle();
    await hosts.http(scout.id, operationId).request("/v1/health");
    expect(environments.activity.has(scout.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await state()).toEqual(["ready", "ready"]);
    // So is its native work outside Router runs.
    idle();
    f.mau.environments.touch(scout.id);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await state()).toEqual(["ready", "ready"]);
    // An unresolved run of the sharing partner keeps the environment awake without an error.
    const runtime = await f.service.runtime(scout.id);
    runtime.store.set("communication_runs", "fixture-run", { phase: "unknown" });
    idle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await f.settled()).toMatchObject({ state: "ready" });
    expect((await f.settled()).error).toBeUndefined();
    expect(f.pauses).toBe(0);
    // An explicit pause is refused for the same reason, before the cloud is asked.
    await f.api(f.path + "/pause", {});
    expect(await f.settled()).toMatchObject({ state: "ready", error: "agent_has_active_or_unknown_run" });
    expect(f.pauses).toBe(0);
    runtime.store.delete("communication_runs", "fixture-run");
    // With every partner idle the environment sleeps, for both.
    idle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await state()).toEqual(["sleeping", "sleeping"]);
    expect(f.pauses).toBe(1);
    expect(f.mau.environments.readyBindings()).toEqual([]);
    expect(() => hosts.assertReady(scout.id, operationId)).toThrow("environment_not_ready");
    hosts.wake!(scout.id, randomUUID());
    expect(await state()).toEqual(["sleeping", "sleeping"]);
    // Work arriving for the sharing partner wakes the environment through Router's own binding hook and then runs.
    expect((await work(f, scout.id, "scout-wakes", "anything new?")).status).toBe(202);
    expect(await finished(f, scout.id, "scout-wakes")).toMatchObject({ status: "completed" });
    expect(await state()).toEqual(["ready", "ready"]);
    expect(started.map((run) => run.agentId)).toEqual([scout.id]);
    expect(f.creates).toBe(1);
    // An explicit pause by the partner that has the environment is not undone by messages for the other.
    await f.api(f.path + "/pause", {});
    expect(await state()).toEqual(["paused", "paused"]);
    hosts.wake!(scout.id, operationId);
    expect(await state()).toEqual(["paused", "paused"]);
    await f.api(f.path + "/resume", {});
    expect(await state()).toEqual(["ready", "ready"]);
  } finally {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.useRealTimers();
  }
});

it("lets the sharing partner read the environment's state and refuses its lifecycle requests", async () => {
  const f = await mauFixture(cleanup);
  f.mau.environments.options.profiles[0]!.ssh = { port: 37421 };
  const { operationId, scout, scoutPath } = await shared(f);
  const refusal = { status: 409, data: { error: "environment_shared_from_partner", partner: { id: f.agent.id, name: "helper" } } };
  for (const action of ["pause", "resume", "reconcile", "destroy"]) expect(await f.api(`${scoutPath}/${action}`, {})).toEqual(refusal);
  expect(await f.api(scoutPath + "/replace", { profileId: "cloud", expectedOperationId: operationId })).toEqual(refusal);
  expect(await f.api(scoutPath + "/rollback", { expectedOperationId: operationId })).toEqual(refusal);
  const key = "ssh-ed25519 " + Buffer.concat([Buffer.from("AAAAC3NzaC1lZDI1NTE5AAAAIA==", "base64"), Buffer.alloc(32, 7)]).toString("base64");
  expect(await f.api(`/agents/${scout.id}/ssh`, { publicKey: key })).toEqual(refusal);
  expect((await f.api(scoutPath + "/pause", {}, "bob")).status).toBe(404);
  expect(f.pauses).toBe(0);
  expect((await f.api(scoutPath)).data).toMatchObject({ state: "ready", busy: false, sharedFrom: f.agent.id });
  // The partner that has the environment pauses and resumes it for everyone in it.
  expect((await f.api(f.path + "/pause", {})).status).toBe(202);
  expect((await f.settled()).state).toBe("paused");
  expect((await f.api(scoutPath)).data).toMatchObject({ state: "paused", sharedFrom: f.agent.id });
  expect((await f.api(f.path + "/resume", {})).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");
  expect((await f.api(scoutPath)).data.state).toBe("ready");
});

it("refuses to destroy, replace or delete an environment other partners run in", async () => {
  const f = await mauFixture(cleanup);
  const { operationId, scout } = await shared(f);
  f.mau.proactive.store.set("rules", "r1", { id: "r1", owner: alice, agentId: f.agent.id, status: "active", version: 1 });
  const refusal = { status: 409, data: { error: "environment_shared_by_partners", partners: [{ id: scout.id, name: "scout" }] } };
  expect(await f.api(f.path + "/destroy", {})).toEqual(refusal);
  expect(await remove(f, f.agent.id)).toEqual(refusal);
  // Refused before anything was stopped: the schedule is still active and the environment still serves both.
  expect(f.mau.proactive.store.get<any>("rules", "r1").status).toBe("active");
  expect(f.service.agent(f.agent.id).status).toBe("active");
  expect(await f.settled()).toMatchObject({ state: "ready", sharedBy: [scout.id] });
  expect((await f.settled()).error).toBeUndefined();
  expect(f.cloud.size).toBe(1);
  // Replacement needs a stopped environment; it is refused while shared, and so is a rollback.
  await f.api(f.path + "/pause", {});
  expect((await f.settled()).state).toBe("paused");
  expect(await f.api(f.path + "/replace", { profileId: "cloud", expectedOperationId: operationId })).toEqual(refusal);
  expect(await f.api(f.path + "/rollback", { expectedOperationId: operationId })).toEqual(refusal);
  expect(f.creates).toBe(1);
  expect((await f.settled()).operationId).toBe(operationId);
  await f.api(f.path + "/resume", {});
  expect((await f.settled()).state).toBe("ready");
  // Once the sharing partner is gone, the environment can be destroyed with its partner.
  expect((await remove(f, scout.id)).status).toBe(204);
  expect((await remove(f, f.agent.id)).status).toBe(204);
  expect(f.cloud.size).toBe(0);
  expect((await f.api("/agents")).data.data).toEqual([]);
});

it("deletes a sharing partner with its own records and leaves the environment and the other partner alone", async () => {
  const f = await mauFixture(cleanup);
  const { operationId, scout } = await shared(f, { duty: "Watches the inbox" });
  const environment = [...f.cloud.keys()][0]!, token = f.cloud.get(environment)!.files.get("/home/user/.agent-host-service/token");
  f.mau.facts.mutate(alice, scout.id, { action: "add", content: "prefers tea" });
  f.mau.facts.mutate(alice, f.agent.id, { action: "add", content: "prefers coffee" });
  const schedules = f.mau.proactive.store;
  schedules.set("rules", "r1", { id: "r1", owner: alice, agentId: scout.id, status: "active", version: 1 });
  schedules.set("rules", "r2", { id: "r2", owner: alice, agentId: f.agent.id, status: "active", version: 1 });
  const business = new DurableStore(join(f.directory, "business-tools.sqlite"), "example.test");
  business.set("employee_memory_pending", "p1", { agentId: scout.id });
  business.set("employee_memory_pending", "p2", { agentId: f.agent.id });
  business.close();
  const destroy = vi.spyOn(f.provider, "destroy"), pause = vi.spyOn(f.provider, "pause");

  expect((await remove(f, scout.id, "bob")).status).toBe(404);
  expect((await remove(f, scout.id)).status).toBe(204);

  expect(destroy).not.toHaveBeenCalled();
  expect(pause).not.toHaveBeenCalled();
  expect(f.cloud.get(environment)).toMatchObject({ state: "running" });
  expect(f.cloud.get(environment)!.files.get("/home/user/.agent-host-service/token")).toBe(token);
  const kept = await f.settled();
  expect(kept).toMatchObject({ state: "ready", operationId });
  expect(kept).not.toHaveProperty("sharedBy");
  expect(kept.error).toBeUndefined();
  expect((await f.api("/agents")).data.data.map((item: any) => item.agent.name)).toEqual(["helper"]);
  expect((await f.api(`/agents/${scout.id}`)).status).toBe(404);
  expect(await f.mau.router.connections.hosts!.http(f.agent.id, operationId).request("/v1/health")).toMatchObject({ protocolVersion: 1 });
  expect(() => f.mau.router.connections.hosts!.assertReady(scout.id, operationId)).toThrow("environment_not_ready");
  // Its own records are gone, the other partner's remain.
  expect(readdirSync(join(f.directory, "mau", "memories"))).toHaveLength(1);
  expect(JSON.stringify(f.mau.facts.read(alice, f.agent.id).entries)).toContain("prefers coffee");
  expect(schedules.entries("rules").map((rule) => rule.id)).toEqual(["r2"]);
  const after = new DurableStore(join(f.directory, "business-tools.sqlite"), "example.test");
  expect(after.entries("employee_memory_pending").map((record) => record.id)).toEqual(["p2"]);
  after.close();
  const journal = (f.mau.environments as any).store as DurableStore;
  expect(journal.entries("shared_environments")).toEqual([]);
  expect(journal.entries("agent_duties")).toEqual([]);
  expect(journal.entries("environments").map((record) => record.id)).toEqual([f.agent.id]);
  // The name is free again, for either kind of partner.
  const again = await f.api("/agents", { name: "scout", shareWith: f.agent.id });
  expect(again.status).toBe(202);
  expect(again.data.agent.id).not.toBe(scout.id);
  expect(again.data.duty).toBeNull();
});

it("lists every partner of a ready environment for background observers, under the one operation and runtime", async () => {
  const f = await mauFixture(cleanup);
  const { operationId, scout } = await shared(f);
  expect(f.mau.environments.readyBindings()).toEqual([
    { agentId: f.agent.id, operationId, runtimeId: "personal", kernel: "codex" },
    { agentId: scout.id, operationId, runtimeId: "personal", kernel: "codex" }]);
  expect(f.mau.environments.sharedFrom(scout.id)).toBe(f.agent.id);
  expect(f.mau.environments.sharedFrom(f.agent.id)).toBeUndefined();
  expect(f.mau.environments.sharedBy(f.agent.id)).toEqual([scout.id]);
});
