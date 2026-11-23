import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DurableStore } from "../src/store.js";
import { EnvironmentManager } from "../src/environments.js";
import { sshKeyId } from "../src/ssh.js";
import { connectSshTunnel } from "../src/ssh-transport.js";
import { alice, bob, mauFixture, root } from "./fixtures/mau.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});
const fixture = () => mauFixture(cleanup);

it("owner-scoped durable allocation publishes verified bootstrap once and binds a private Host", async () => {
  const f = await fixture();
  expect((await f.api("/options", undefined, "bob")).data.environments).toEqual(
    [],
  );
  expect((await f.api(f.path, { profileId: "cloud" }, "bob")).status).toBe(404);
  expect(
    (await f.api(f.path, { profileId: "cloud", command: "evil" })).status,
  ).toBe(400);
  // The fixed instructions are the environment profile's: none before an environment, then readable by the owner only.
  const instructions = `/agents/${f.agent.id}/instructions`;
  expect((await f.api(instructions)).data).toEqual({ text: "", shared: "environment_profile" });
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  const ready = await f.settled();
  expect(ready.state).toBe("ready");
  expect((await f.api(instructions)).data).toEqual({ text: "Work carefully.\nAnswer in the owner's language.", shared: "environment_profile" });
  expect((await f.api(instructions, undefined, "bob")).status).toBe(404);
  expect(f.creates).toBe(1);
  await f.api(f.path, { profileId: "cloud" });
  expect(f.creates).toBe(1);
  const files = [...f.cloud.values()][0]!.files,
    dir = "/home/user/.agent-host-service/";
  const marker = JSON.parse(String(files.get(dir + "ready.json")));
  expect(marker.configSha256).toBe(
    createHash("sha256")
      .update(String(files.get(dir + "host.json")))
      .digest("hex"),
  );
  expect(marker.tokenSha256).toBe(
    createHash("sha256")
      .update(String(files.get(dir + "token")))
      .digest("hex"),
  );
  const setup = (await f.api(`/agents/${f.agent.id}`)).data;
  expect(setup.host.runtimeId).toBe("personal");
  // Bootstrap binds the Host and adds no channel connection.
  expect(setup.connections).toEqual([]);
  expect(setup.environment.operationId).toBe(ready.operationId);
  expect(JSON.stringify(setup)).not.toContain(String(files.get(dir + "token")));
  expect(JSON.stringify(setup)).not.toContain("private-traffic-token");
  expect(
    statSync(
      join(
        f.directory,
        "mau",
        "agents",
        f.agent.id,
        "environments", ready.operationId,
        "environment-token",
      ),
    ).mode & 0o777,
  ).toBe(0o600);
  const checks = (await f.api(`/agents/${f.agent.id}/check`, {}, "alice", "/_agent-router/v1")).data
    .checks;
  expect(checks[0].status).toBe("verified");
  expect((await f.api(f.path + "/pause", {})).status).toBe(202);
  expect((await f.settled()).state).toBe("paused");
  await f.api(f.path + "/resume", {});
  expect((await f.settled()).state).toBe("ready");
  expect(f.creates).toBe(1);
  await f.api(f.path + "/destroy", {});
  expect((await f.settled()).state).toBe("deleted");
  expect(f.cloud.size).toBe(0);
  expect((await f.api(f.path + "/resume", {})).status).toBe(409);
});
it("creates a profile's environments with the variables the profile names, and refuses names a shell could not carry", async () => {
  const env = { HTTPS_PROXY: "http://proxy.example:7890", no_proxy: "localhost,127.0.0.1" };
  const f = await mauFixture(cleanup, { profile: { env } });
  const asked: unknown[] = [], create = f.provider.create;
  f.provider.create = (input) => { asked.push(input); return create(input); };
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");
  expect(asked).toMatchObject([{ template: "tools", env, metadata: { "mau-operation": expect.any(String) } }]);
  for (const bad of [{ "A=B": "x" }, { "1A": "x" }, { A: "x\0y" }]) await expect(mauFixture(cleanup, { profile: { env: bad } })).rejects.toThrow();
  // A profile without variables asks for none.
  const plain = await mauFixture(cleanup);
  const plainCreate = plain.provider.create;
  plain.provider.create = (input) => { asked.push(input); return plainCreate(input); };
  expect((await plain.api(plain.path, { profileId: "cloud" })).status).toBe(202);
  await plain.settled();
  expect(asked[1]).not.toHaveProperty("env");
});

it("Mau creates the Router identity under the same owner and Router no longer exposes provisioning", async () => {
  const f = await fixture();
  expect((await f.api("/info")).data).toEqual({ login: "edge", logoutUrl: "/cdn-cgi/access/logout" });
  const denied = await f.api("/agents", { name: "other", profileId: "cloud" }, "bob");
  expect(denied.status).toBe(403);
  expect(f.service.agents(bob)).toHaveLength(0);
  const created = await f.api("/agents", { name: "helper", profileId: "cloud" });
  expect(created.status).toBe(202);
  expect(created.data.agent.id).toBe(f.agent.id);
  expect(created.data.agent.owner).toBe(alice);
  expect((await f.settled()).state).toBe("ready");
  expect(f.service.agents(alice)).toHaveLength(1);
  for (const path of ["/setup", `/agents/${f.agent.id}/setup/environment`])
    expect((await f.api(path, undefined, "alice", "/_agent-router/v1")).status).toBe(404);
  expect((await f.api("/connection-options", undefined, "alice", "/_agent-router/v1")).data)
    .not.toHaveProperty("environments");
  const issued = f.service.issue(f.agent.id, "worker");
  expect((await f.api(f.path + "/pause", {}, issued.token)).status).toBe(401);
  expect(f.pauses).toBe(0);
});
it("lost creation response reconciles by operation metadata without buying a second environment", async () => {
  const f = await fixture();
  f.loseCreate();
  await f.api(f.path, { profileId: "cloud" });
  const failed = await f.settled();
  expect(failed.state).toBe("needs_action");
  expect(JSON.stringify(failed)).not.toContain("private-cloud-key");
  await f.api(f.path, { profileId: "cloud" });
  expect(f.creates).toBe(1);
  await f.api(f.path + "/reconcile", {});
  expect((await f.settled()).state).toBe("ready");
  expect(f.creates).toBe(1);
});
it("active or uncertain runs prevent pause before any cloud mutation and leave the worker usable", async () => {
  const f = await fixture();
  await f.api(f.path, { profileId: "cloud" });
  await f.settled();
  const runtime = await f.service.runtime(f.agent.id);
  runtime.store.set("communication_runs", "fixture-run", {
    phase: "unknown",
  });
  await f.api(f.path + "/pause", {});
  const state = await f.settled();
  expect(state.state).toBe("ready");
  expect(state.error).toBe("agent_has_active_or_unknown_run");
  expect(f.pauses).toBe(0);
});
it("missing environments never silently create a replacement", async () => {
  const f = await fixture();
  await f.api(f.path, { profileId: "cloud" });
  await f.settled();
  f.cloud.clear();
  await f.api(f.path + "/resume", {});
  const state = await f.settled();
  expect(state.error).toBe("environment_missing_explicit_replacement_required");
  expect(f.creates).toBe(1);
});

it("concurrent requests allocate once and changing account assignments preserves existing execution bindings", async () => {
  const f = await fixture();
  const requests = await Promise.all([
    f.api(f.path, { profileId: "cloud" }),
    f.api(f.path, { profileId: "cloud" }),
  ]);
  expect(requests.every((r) => r.status === 202)).toBe(true);
  expect(requests[0]!.data.operationId).toBe(requests[1]!.data.operationId);
  expect((await f.settled()).state).toBe("ready");
  const profile = f.mau.environments.options.profiles[0]!;
  profile.owners.push(bob);
  profile.label = "Renamed display label";
  profile.instructions = "Revised instructions";
  profile.lifetimeSeconds = 7200;
  await f.api(f.path + "/resume", {});
  expect((await f.settled()).state).toBe("ready");
  expect(f.creates).toBe(1);
  // The Host endpoint is execution identity; changing it must not reach the old environment.
  profile.port = 37421;
  await f.api(f.path + "/resume", {});
  expect((await f.settled()).error).toBe("environment_profile_changed");
});
it("retrying setup with the same name reuses the Agent after an environment failure", async () => {
  const f = await fixture();
  const hostConfigFile = f.mau.environments.options.profiles[0]!.hostConfigFile;
  f.mau.environments.options.profiles[0]!.hostConfigFile = join(f.directory, "missing.json");
  expect((await f.api("/agents", { name: "helper", profileId: "cloud" })).status).toBe(500);
  f.mau.environments.options.profiles[0]!.hostConfigFile = hostConfigFile;
  const retried = await f.api("/agents", { name: "helper", profileId: "cloud" });
  expect(retried.status).toBe(202);
  expect(retried.data.agent.id).toBe(f.agent.id);
  expect((await f.settled()).state).toBe("ready");
  expect(f.service.agents(alice)).toHaveLength(1);
});
it("malformed and oversized request bodies are client errors", async () => {
  const f = await fixture();
  const post = (body: string) => fetch(f.base + root + f.path, { method: "POST", body,
    headers: { authorization: "Bearer alice", "content-type": "application/json" } });
  const malformed = await post("{");
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ error: "invalid_request" });
  const oversized = await post(JSON.stringify({ profileId: "x".repeat(20_000) }));
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toEqual({ error: "request_too_large" });
});
it("renewal failure stays visible and requires reconciliation without replacing the environment", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const f = await fixture();
    await f.api(f.path, { profileId: "cloud" });
    await f.settled();
    const renew = vi
      .spyOn(f.provider, "setTimeout")
      .mockRejectedValue(new Error("private-cloud-error"));
    // Transient request failures keep the environment usable.
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await f.settled()).state).toBe("ready");
    await vi.advanceTimersByTimeAsync(30_000);
    const failed = await f.settled();
    expect(renew).toHaveBeenCalledTimes(3);
    expect(failed.state).toBe("needs_action");
    expect(JSON.stringify(failed)).not.toContain("private-cloud-error");
    renew.mockRestore();
    await f.api(f.path + "/reconcile", {});
    expect((await f.settled()).state).toBe("ready");
    expect(f.creates).toBe(1);
  } finally {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.useRealTimers();
  }
});
it("a confirmed stopped environment needs action at the first renewal", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const f = await fixture();
    await f.api(f.path, { profileId: "cloud" });
    await f.settled();
    [...f.cloud.values()][0]!.state = "paused";
    await vi.advanceTimersByTimeAsync(30_000);
    const failed = await f.settled();
    expect(failed.state).toBe("needs_action");
    expect(failed.error).toBe("environment_not_running_resume_required");
  } finally {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.useRealTimers();
  }
});
it("a lifecycle request waits for a running renewal instead of failing", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const f = await fixture();
    await f.api(f.path, { profileId: "cloud" });
    await f.settled();
    let release!: () => void;
    const renew = vi.spyOn(f.provider, "setTimeout")
      .mockImplementation(() => new Promise<void>((r) => { release = r; }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renew).toHaveBeenCalledOnce();
    const pause = f.api(f.path + "/pause", {});
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await pause).status).toBe(202);
    expect((await f.settled()).state).toBe("paused");
  } finally {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.useRealTimers();
  }
});

it("an idle environment sleeps and only deliverable work wakes it through Router's binding hook", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const f = await fixture();
    f.mau.environments.options.profiles[0]!.idlePauseSeconds = 600;
    await f.api(f.path, { profileId: "cloud" });
    const { operationId } = await f.settled();
    // Backdate the last Host request instead of moving the clock under Router's leases.
    const idle = () => (f.mau.environments as any).activity.set(f.agent.id, Date.now() - 601_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await f.settled()).state).toBe("ready");
    idle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await f.settled()).state).toBe("sleeping");
    expect(f.pauses).toBe(1);
    const hosts = f.mau.router.connections.hosts!;
    expect(() => hosts.assertReady(f.agent.id, operationId)).toThrow("environment_not_ready");
    hosts.wake!(f.agent.id, "another-binding");
    expect((await f.settled()).state).toBe("sleeping");
    hosts.wake!(f.agent.id, operationId);
    expect((await f.settled()).state).toBe("ready");
    expect(f.creates).toBe(1);
    // An explicit pause is the owner's decision; new messages do not override it.
    idle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await f.settled()).state).toBe("sleeping");
    await f.api(f.path + "/pause", {});
    expect((await f.settled()).state).toBe("paused");
    hosts.wake!(f.agent.id, operationId);
    expect((await f.settled()).state).toBe("paused");
    expect(f.pauses).toBe(2);
  } finally {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.useRealTimers();
  }
});
it("background observers read without extending the idle window; native work explicitly keeps it awake", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const f = await fixture();
    f.mau.environments.options.profiles[0]!.idlePauseSeconds = 600;
    await f.api(f.path, { profileId: "cloud" });
    const { operationId } = await f.settled();
    const environments = f.mau.environments as any, idle = () => environments.activity.set(f.agent.id, Date.now() - 601_000);
    expect(f.mau.environments.readyBindings()).toEqual([expect.objectContaining({ agentId: f.agent.id, operationId })]);
    idle();
    await f.mau.environments.http(f.agent.id, operationId, false, { activity: false }).request("/v1/health");
    expect(Date.now() - environments.activity.get(f.agent.id)).toBeGreaterThan(600_000);
    f.mau.environments.touch(f.agent.id);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await f.settled()).state).toBe("ready");
    idle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await f.settled()).state).toBe("sleeping");
    expect(f.mau.environments.readyBindings()).toEqual([]);
    // Touching a sleeping environment neither wakes it nor fakes activity.
    f.mau.environments.touch(f.agent.id);
    await expect(f.mau.environments.http(f.agent.id, operationId, false, { activity: false }).request("/v1/health")).rejects.toThrow("environment_not_ready");
    expect((await f.settled()).state).toBe("sleeping");
  } finally {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.useRealTimers();
  }
});
it("active or unresolved runs keep an idle environment awake without recording an error", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const f = await fixture();
    f.mau.environments.options.profiles[0]!.idlePauseSeconds = 600;
    await f.api(f.path, { profileId: "cloud" });
    await f.settled();
    const runtime = await f.service.runtime(f.agent.id);
    runtime.store.set("communication_runs", "fixture-run", { phase: "unknown" });
    (f.mau.environments as any).activity.set(f.agent.id, Date.now() - 601_000);
    await vi.advanceTimersByTimeAsync(30_000);
    const state = await f.settled();
    expect(state.state).toBe("ready");
    expect(state.error).toBeUndefined();
    expect(f.pauses).toBe(0);
  } finally {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.useRealTimers();
  }
});
it("a second coordinator cannot acquire the same journal and a stale owner cannot mutate cloud resources", async () => {
  const f = await fixture();
  expect(() => new EnvironmentManager(f.mau.router.connections, f.service,
    f.mau.environments.options, f.directory, join(f.directory, "mau"), async () => ({ provider: () => f.provider })))
    .toThrow("environment_coordinator_already_running");
  await f.api(f.path, { profileId: "cloud" });
  await f.settled();
  const journal = new DurableStore(
    join(f.directory, "mau", "environments.sqlite"),
    "example.test",
  );
  try {
    journal.set("meta", "lease", {
      owner: "replacement-coordinator",
      expires: Date.now() + 60000,
    });
  } finally {
    journal.close();
  }
  expect((await f.api(f.path + "/pause", {})).status).toBe(503);
  expect(f.pauses).toBe(0);
  expect(f.creates).toBe(1);
});

it("SSH requires an assigned owner, explicit profile support and a ready environment; active connections protect lifecycle", async () => {
  const f = await fixture();
  const key = "ssh-ed25519 " + Buffer.concat([Buffer.from("AAAAC3NzaC1lZDI1NTE5AAAAIA==", "base64"), Buffer.alloc(32, 7)]).toString("base64");
  const path = `/agents/${f.agent.id}/ssh`;
  expect((await f.api(path, { publicKey: key })).status).toBe(409);
  await f.api(f.path, { profileId: "cloud" }); await f.settled();
  expect((await f.api(path, { publicKey: key })).data.error).toBe("ssh_not_enabled");
  f.mau.environments.options.profiles[0]!.ssh = { port: 37421 };
  expect((await f.api(path, { publicKey: key }, "bob")).status).toBe(404);
  expect((await f.api(path, { publicKey: key + "\ncommand=bad" })).status).toBe(400);
  const exec = f.provider.exec.bind(f.provider);
  const sshCalls: Array<{ argv: string[]; env?: Record<string, string> | undefined }> = [];
  f.provider.exec = async function* (id, argv, options) {
    if (argv[0] === "node" && argv.includes("prepare")) {
      sshCalls.push({ argv, env: options?.env });
      yield { stream: "stdout", text: JSON.stringify({ username: "user", hostKey: key }) };
      options?.onExit?.({ exitCode: 0 }); return;
    }
    yield* exec(id, argv, options);
  };
  const prepared = await f.api(path, { publicKey: key });
  expect(prepared.status).toBe(200);
  expect(prepared.data).toEqual({ username: "user", hostKey: key, keyId: sshKeyId(key) });
  expect(JSON.stringify(prepared.data)).not.toMatch(/private-traffic|Bearer|ssh-token/);
  // SSH preparation passes the token in env only and never writes bridge.mjs or token under the user-owned directory.
  expect(sshCalls).toHaveLength(1);
  expect(sshCalls[0]!.env?.MAU_SSH_TOKEN).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  expect(sshCalls[0]!.argv.join(" ")).not.toContain(sshCalls[0]!.env!.MAU_SSH_TOKEN!);
  expect([...[...f.cloud.values()][0]!.files.keys()].some(file => file.includes("/ssh/"))).toBe(false);
  // Upgrade must repeat authentication and ownership checks, bypassing neither via HTTP Upgrade.
  await expect(connectSshTunnel(new URL(path + "/" + sshKeyId(key), f.base), { Authorization: "Bearer bob" }))
    .rejects.toThrow("ssh_connection_rejected");
  const lease = await f.mau.environments.connectSsh(alice, f.agent.id, sshKeyId(key));
  expect(lease.url.pathname).toBe("/ssh");
  expect(lease.headers["x-environment-access"]).toBe("private-traffic-token");
  expect((await f.api(f.path + "/pause", {})).data.error).toBe("environment_has_active_ssh");
  expect((await f.api(f.path + "/destroy", {})).data.error).toBe("environment_has_active_ssh");
  lease.release(); lease.release();
  expect((await f.api(f.path + "/pause", {})).status).toBe(202);
  expect((await f.settled()).state).toBe("paused");
  expect((await f.api(path, { publicKey: key })).data.error).toBe("environment_not_ready");
});

it("replaces a stopped environment without changing Agent identity and rolls back to its retained files", async () => {
  const f = await fixture();
  await f.api(f.path, { profileId: "cloud" }); const original = await f.settled();
  const oldId = [...f.cloud.keys()][0]!, oldToken = f.cloud.get(oldId)!.files.get("/home/user/.agent-host-service/token");
  f.cloud.get(oldId)!.files.set("/home/user/workspace/keep.txt", "retained");
  const body = { profileId: "cloud", expectedOperationId: original.operationId };
  expect((await f.api(f.path + "/replace", body)).status).toBe(409);
  await f.api(f.path + "/pause", {}); await f.settled();
  expect((await f.api(f.path + "/replace", body, "bob")).status).toBe(404);
  expect((await f.api(f.path + "/replace", { ...body, expectedOperationId: randomUUID() })).status).toBe(409);
  expect((await f.api(f.path + "/replace", { ...body, profileId: "unassigned" })).status).toBe(403);
  expect((await f.api(f.path + "/replace", body)).status).toBe(202);
  const replaced = await f.settled();
  expect(replaced.state).toBe("ready"); expect(replaced.operationId).not.toBe(original.operationId);
  expect(f.service.owned(f.agent.id, alice).matrixId).toBe(f.agent.matrixId);
  expect(f.cloud.get(oldId)!.state).toBe("paused");
  const newId = [...f.cloud.keys()][1]!;
  expect(f.cloud.get(newId)!.files.get("/home/user/.agent-host-service/token")).not.toBe(oldToken);
  await f.api(f.path + "/pause", {}); await f.settled();
  expect((await f.api(f.path + "/replace", { ...body, expectedOperationId: replaced.operationId })).status).toBe(409);
  expect((await f.api(f.path + "/rollback", { expectedOperationId: replaced.operationId }, "bob")).status).toBe(404);
  await f.api(f.path + "/rollback", { expectedOperationId: replaced.operationId });
  expect((await f.settled()).operationId).toBe(original.operationId);
  expect(f.cloud.get(oldId)!.files.get("/home/user/workspace/keep.txt")).toBe("retained");
  expect(f.cloud.get(oldId)!.files.get("/home/user/.agent-host-service/token")).toBe(oldToken);
  expect(f.cloud.get(newId)!.state).toBe("paused");
  await f.api(f.path + "/resume", {}); expect((await f.settled()).state).toBe("ready");
});

it("replacement requires confirmed cloud pause and cannot be replayed after a lost create response", async () => {
  const f = await fixture();
  await f.api(f.path, { profileId: "cloud" }); const old = await f.settled();
  await f.api(f.path + "/pause", {}); await f.settled();
  const id = [...f.cloud.keys()][0]!, body = { profileId: "cloud", expectedOperationId: old.operationId };
  f.cloud.get(id)!.state = "running";
  expect((await f.api(f.path + "/replace", body)).data.error).toBe("environment_stop_unconfirmed");
  f.cloud.get(id)!.state = "paused";
  f.loseCreate(); await f.api(f.path + "/replace", body);
  expect((await f.settled()).state).toBe("needs_action");
  expect((await f.api(f.path + "/replace", body)).status).toBe(409);
  expect(f.creates).toBe(2);
  await f.api(f.path + "/reconcile", {}); expect((await f.settled()).state).toBe("ready");
  expect(f.creates).toBe(2);
});

it("rollback cannot replace a working binding with an expired or unexpectedly running old environment", async () => {
  const f=await fixture();await f.api(f.path,{profileId:"cloud"});const original=await f.settled();
  const oldId=[...f.cloud.keys()][0]!;await f.api(f.path+"/pause",{});await f.settled();
  await f.api(f.path+"/replace",{profileId:"cloud",expectedOperationId:original.operationId});const replacement=await f.settled();
  await f.api(f.path+"/pause",{});await f.settled();
  f.cloud.get(oldId)!.state="running";
  await f.api(f.path+"/rollback",{expectedOperationId:replacement.operationId});
  expect((await f.settled()).error).toBe("previous_environment_stop_unconfirmed");
  f.cloud.delete(oldId);
  await f.api(f.path+"/rollback",{expectedOperationId:replacement.operationId});const rejected=await f.settled();
  expect(rejected.error).toBe("previous_environment_missing");expect(rejected.operationId).toBe(replacement.operationId);
  await f.api(f.path+"/resume",{});expect((await f.settled()).state).toBe("ready");
});

it("keeps real Codex auth.json out of sandboxes when the provider supports gateway-managed credentials", async () => {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const accessToken = `${b64({ alg: "RS256" })}.${b64({ exp: 2_000_000_000, client_id: "app_codex", "https://api.openai.com/auth": { chatgpt_account_id: "acct-owner-1", chatgpt_plan_type: "plus" } })}.real-sig`;
  const realAuth = JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { access_token: accessToken, refresh_token: "rt_super_secret", id_token: accessToken, account_id: "acct-owner-1" },
  });
  const f = await fixture();
  const authPath = join(f.directory, "codex-auth.json");
  writeFileSync(authPath, realAuth, { mode: 0o600 });
  f.mau.environments.options.profiles[0]!.files.push({ source: authPath, destination: "/home/user/.codex/auth.json" });

  const stored: Array<[string, unknown]> = [], created: unknown[] = [], resumed: unknown[] = [];
  const origCreate = f.provider.create.bind(f.provider), origResume = f.provider.resume.bind(f.provider);
  const id = "codex-" + createHash("sha256").update(authPath).digest("hex");
  const meta = { id, service: "openai" as const, mode: "chatgpt" as const, accountId: "acct-owner-1",
    updatedAt: new Date().toISOString(), renewable: true };
  f.provider.getModelCredential = async () => stored.length ? meta : null;
  f.provider.putModelCredential = async (key, input, options) => {
    expect(options?.ifAbsent).toBe(true);
    stored.push([key, input]); return meta;
  };
  let installs = 0;
  f.provider.prepareCodexAuth = async () => { installs++; };
  f.provider.create = (input) => { created.push(input); return origCreate(input); };
  f.provider.resume = (id, seconds, options) => { resumed.push(options); return origResume(id, seconds, options); };

  await f.api(f.path, { profileId: "cloud" }); await f.settled();
  expect(stored).toMatchObject([[id, { accountId: "acct-owner-1", refreshToken: "rt_super_secret" }]]);
  const selection = { modelAccounts: { openai: ["acct-owner-1"] }, modelCredentials: { openai: id }, codexAuthUsers: ["user"] };
  expect(created[0]).toMatchObject(selection);
  const guest = [...f.cloud.values()][0]!;
  expect(guest.files.has("/home/user/.codex/auth.json")).toBe(false);
  expect(installs).toBe(1);
  await f.api(f.path + "/pause", {}); await f.settled();
  await f.api(f.path + "/resume", {}); expect((await f.settled()).state).toBe("ready");
  expect(resumed[0]).toMatchObject(selection);
  expect(stored).toHaveLength(1);
  expect(installs).toBe(1);
});

it("fails before creating a managed environment when a configured login cannot be imported", async () => {
  const f = await fixture();
  const source = join(f.directory, "invalid-login.json");
  writeFileSync(source, JSON.stringify({ auth_mode: "unsupported", tokens: { refresh_token: "fixture-only" } }));
  f.mau.environments.options.profiles[0]!.files.push({ source, destination: "/home/user/.codex/auth.json" });
  f.provider.putModelCredential = vi.fn(); f.provider.getModelCredential = vi.fn(); f.provider.prepareCodexAuth = vi.fn();
  await f.api(f.path, { profileId: "cloud" });
  expect((await f.settled()).state).toBe("needs_action");
  expect(f.creates).toBe(0);
  expect(f.provider.putModelCredential).not.toHaveBeenCalled();
});

/** A fixture whose profile offers Antigravity with its settings file and a Gemini API key file among that kernel's files. */
const agyFixture = async (key = "AIza-fixture-owner-key\n") => {
  const f = await mauFixture(cleanup, { runtimes: { agy: { kernel: "agy" } }, profile: { otherKernels: [{ kernel: "agy", runtimeId: "agy" }] } });
  const keyFile = join(f.directory, "gemini-api-key"), settings = join(f.directory, "agy-settings.json");
  writeFileSync(keyFile, key, { mode: 0o600 }); writeFileSync(settings, JSON.stringify({ modelProvider: "gemini" }), { mode: 0o600 });
  f.mau.environments.options.profiles[0]!.otherKernels[0]!.files.push(
    { source: settings, destination: "/home/user/.gemini/antigravity-cli/settings.json" }, { source: keyFile, destination: "/home/user/.gemini/api-key" });
  const created: unknown[] = [], resumed: unknown[] = [];
  const create = f.provider.create.bind(f.provider), resume = f.provider.resume.bind(f.provider);
  f.provider.create = (input) => { created.push(input); return create(input); };
  f.provider.resume = (id, seconds, options) => { resumed.push(options); return resume(id, seconds, options); };
  const text = (value: string | Uint8Array | undefined) => value === undefined ? undefined : Buffer.from(value).toString();
  const guest = () => [...f.cloud.values()][0]!.files;
  return { f, keyFile, settings, created, resumed, text, guest, id: "gemini-" + createHash("sha256").update(keyFile).digest("hex") };
};
/** A provider gateway that holds model credentials: what was stored, in order. */
const holding = (f: Awaited<ReturnType<typeof fixture>>) => {
  const stored: Array<{ id: string; input: unknown; options: unknown }> = [];
  f.provider.putModelCredential = async (id, input, options) => {
    stored.push({ id, input, options });
    return { id, service: input.service, mode: input.mode, renewable: false, updatedAt: new Date().toISOString() };
  };
  return stored;
};

it("hands the Gemini API key of an Antigravity kernel to the gateway and leaves a placeholder in the sandbox", async () => {
  const { f, keyFile, settings, created, resumed, text, guest, id } = await agyFixture();
  const stored = holding(f);
  await f.api(f.path, { profileId: "cloud" }); expect((await f.settled()).state).toBe("ready");
  // Stored under the key file's ID, the surrounding whitespace of the file removed, replacing what was there.
  expect(stored).toEqual([{ id, input: { service: "google", mode: "api_key", apiKey: "AIza-fixture-owner-key" }, options: undefined }]);
  expect(created[0]).toMatchObject({ modelServices: ["openai", "google"], modelCredentials: { google: id } });
  expect(created[0]).not.toHaveProperty("codexAuthUsers");
  expect(created[0]).not.toHaveProperty("modelAccounts");
  // The file the runtime's command reads holds a placeholder; the kernel's other files arrive as they are.
  expect(text(guest().get("/home/user/.gemini/api-key"))).toBe("gateway-managed\n");
  expect(text(guest().get("/home/user/.gemini/antigravity-cli/settings.json"))).toBe(readFileSync(settings, "utf8"));
  expect([...guest().values()].some(value => text(value)!.includes("AIza-fixture-owner-key"))).toBe(false);

  // A rotated key reaches the gateway at the next resume, under the same ID. An environment made before the gateway
  // held the key still has it in its files: the resume replaces it.
  writeFileSync(keyFile, "AIza-fixture-rotated-key\n");
  guest().set("/home/user/.gemini/api-key", "AIza-fixture-owner-key\n");
  await f.api(f.path + "/pause", {}); expect((await f.settled()).state).toBe("paused");
  await f.api(f.path + "/resume", {}); expect((await f.settled()).state).toBe("ready");
  expect(stored).toHaveLength(2);
  expect(stored[1]).toEqual({ id, input: { service: "google", mode: "api_key", apiKey: "AIza-fixture-rotated-key" }, options: undefined });
  expect(resumed[0]).toMatchObject({ modelServices: ["openai", "google"], modelCredentials: { google: id } });
  expect(resumed[0]).not.toHaveProperty("codexAuthUsers");
  expect(text(guest().get("/home/user/.gemini/api-key"))).toBe("gateway-managed\n");
  expect([...guest().values()].some(value => /AIza-fixture-(owner|rotated)-key/.test(text(value)!))).toBe(false);
}, 60_000);

it("holds a Codex sign-in and a Gemini API key of one profile side by side", async () => {
  const { f, created, text, guest, id } = await agyFixture();
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const accessToken = `${b64({ alg: "RS256" })}.${b64({ exp: 2_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "acct-owner-1" } })}.real-sig`;
  const authPath = join(f.directory, "codex-auth.json");
  writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: accessToken, refresh_token: "rt_super_secret", account_id: "acct-owner-1" } }), { mode: 0o600 });
  f.mau.environments.options.profiles[0]!.files.push({ source: authPath, destination: "/home/user/.codex/auth.json" });
  const stored = holding(f), codexId = "codex-" + createHash("sha256").update(authPath).digest("hex");
  const put = f.provider.putModelCredential!;
  f.provider.putModelCredential = async (key, input, options) => ({ ...await put(key, input, options), ...(input.service === "openai" ? { accountId: "acct-owner-1" } : {}) });
  f.provider.getModelCredential = async () => null;
  f.provider.prepareCodexAuth = async () => {};
  await f.api(f.path, { profileId: "cloud" }); expect((await f.settled()).state).toBe("ready");
  // Each under its own service and ID; only the sign-in, which the gateway renews, is kept when it is already there.
  expect(stored.map(({ id, input, options }) => [id, (input as { service: string }).service, options])).toEqual([[codexId, "openai", { ifAbsent: true }], [id, "google", undefined]]);
  expect(created[0]).toMatchObject({ modelServices: ["openai", "google"], modelAccounts: { openai: ["acct-owner-1"] },
    modelCredentials: { openai: codexId, google: id }, codexAuthUsers: ["user"] });
  expect(guest().has("/home/user/.codex/auth.json")).toBe(false);
  expect(text(guest().get("/home/user/.gemini/api-key"))).toBe("gateway-managed\n");
}, 60_000);

it("uploads the Gemini API key file as it is when the provider holds no credentials", async () => {
  const { f, keyFile, created, resumed, text, guest } = await agyFixture();
  expect(f.provider.putModelCredential).toBeUndefined();
  await f.api(f.path, { profileId: "cloud" }); expect((await f.settled()).state).toBe("ready");
  expect(created[0]).toMatchObject({ modelServices: ["openai", "google"] });
  expect(created[0]).not.toHaveProperty("modelCredentials");
  expect(text(guest().get("/home/user/.gemini/api-key"))).toBe(readFileSync(keyFile, "utf8"));
  await f.api(f.path + "/pause", {}); expect((await f.settled()).state).toBe("paused");
  await f.api(f.path + "/resume", {}); expect((await f.settled()).state).toBe("ready");
  expect(resumed[0]).not.toHaveProperty("modelCredentials");
  expect(text(guest().get("/home/user/.gemini/api-key"))).toBe("AIza-fixture-owner-key\n");
}, 60_000);

it("creates nothing when a Gemini API key the gateway is to hold cannot be read as one key", async () => {
  for (const key of ["", "\n", "two words\n", "first-key\nsecond-key\n"]) {
    const { f } = await agyFixture(key);
    const stored = holding(f);
    await f.api(f.path, { profileId: "cloud" });
    expect((await f.settled()).state, JSON.stringify(key)).toBe("needs_action");
    expect(f.creates).toBe(0); expect(stored).toEqual([]);
  }
  // One environment has one Google credential, and the key file may not also be uploaded under another name.
  for (const extra of [(other: string) => ({ source: other, destination: "/home/other/.gemini/api-key" }), (_: string, key: string) => ({ source: key, destination: "/home/user/workspace/key-copy" })]) {
    const { f, keyFile } = await agyFixture();
    const other = join(f.directory, "second-gemini-api-key"); writeFileSync(other, "AIza-fixture-second-key\n");
    f.mau.environments.options.profiles[0]!.otherKernels[0]!.files.push(extra(other, keyFile));
    const stored = holding(f);
    await f.api(f.path, { profileId: "cloud" });
    expect((await f.settled()).state).toBe("needs_action");
    expect(f.creates).toBe(0); expect(stored).toEqual([]);
  }
}, 120_000);

it("provisions and rotates an operator-held DeepSeek key without uploading it to the sandbox", async () => {
  const f = await mauFixture(cleanup, { runtimes: { dsh: { kernel: "dsh" } }, profile: { otherKernels: [{ kernel: "dsh", runtimeId: "dsh" }] } });
  const keyFile = join(f.directory, "deepseek-key");
  f.mau.environments.options.profiles[0]!.deepseekCredentialFile = keyFile;
  writeFileSync(keyFile, "fixture-deepseek-first\n");
  const stored = holding(f), create = vi.spyOn(f.provider, "create"), resume = vi.spyOn(f.provider, "resume");
  const id = "deepseek-" + createHash("sha256").update(keyFile).digest("hex");
  const selection = { modelServices: ["openai", "deepseek"], modelCredentials: { deepseek: id } };
  await f.api(f.path, { profileId: "cloud" });
  expect((await f.settled()).state).toBe("ready");
  expect(create.mock.calls[0]?.[0]).toMatchObject(selection);
  await f.api(f.path + "/pause", {});
  expect((await f.settled()).state).toBe("paused");
  writeFileSync(keyFile, "fixture-deepseek-rotated\n");
  await f.api(f.path + "/resume", {});
  expect((await f.settled()).state).toBe("ready");
  expect(resume.mock.calls[0]?.[2]).toMatchObject(selection);
  expect(stored.map(entry => entry.input)).toEqual([
    { service: "deepseek", mode: "api_key", apiKey: "fixture-deepseek-first" },
    { service: "deepseek", mode: "api_key", apiKey: "fixture-deepseek-rotated" },
  ]);
  for (const bytes of [...f.cloud.values()][0]!.files.values())
    expect(Buffer.from(bytes).toString()).not.toContain("fixture-deepseek-");
}, 60_000);

it("rejects a DeepSeek profile whose provider cannot hold its key or whose files expose it", async () => {
  for (const upload of [false, true]) {
    const f = await fixture();
    const profile = f.mau.environments.options.profiles[0]!, source = join(f.directory, "deepseek-key");
    writeFileSync(source, "fixture-deepseek-test");
    profile.deepseekCredentialFile = source;
    if (upload) {
      holding(f);
      profile.files.push({ source, destination: "/home/user/workspace/key" });
    }
    await f.api(f.path, { profileId: "cloud" });
    expect((await f.settled()).state).toBe("needs_action");
    expect(f.creates).toBe(0);
  }
}, 60_000);

it("holds GitHub and Claude credentials in the gateway and removes their selections when the profile changes", async () => {
  const f = await mauFixture(cleanup, { runtimes: { claude: { kernel: "claude" } }, profile: { otherKernels: [{ kernel: "claude", runtimeId: "claude" }] } });
  const profile = f.mau.environments.options.profiles[0]!;
  const github = join(f.directory, "github-key"), anthropic = join(f.directory, "claude-key");
  profile.githubCredentialFile = github;
  profile.anthropicCredentialFile = anthropic;
  writeFileSync(github, "only-at-github-one\n", { mode: 0o600 });
  writeFileSync(anthropic, "only-at-anthropic\n", { mode: 0o600 });
  const stored = holding(f), create = vi.spyOn(f.provider, "create"), resume = vi.spyOn(f.provider, "resume");
  const id = (service: string, file: string) => service + "-" + createHash("sha256").update(file).digest("hex");
  const selection = { modelServices: ["openai", "anthropic"], modelCredentials: { github: id("github", github), anthropic: id("anthropic", anthropic) } };
  await f.api(f.path, { profileId: "cloud" });
  expect((await f.settled()).state).toBe("ready");
  expect(create.mock.calls[0]?.[0]).toMatchObject(selection);
  expect(stored.map(entry => entry.input)).toContainEqual({ service: "github", mode: "token", accessToken: "only-at-github-one" });
  expect(stored.map(entry => entry.input)).toContainEqual({ service: "anthropic", mode: "api_key", apiKey: "only-at-anthropic" });
  await f.api(f.path + "/pause", {}); expect((await f.settled()).state).toBe("paused");
  writeFileSync(github, "only-at-github-two");
  await f.api(f.path + "/resume", {}); expect((await f.settled()).state).toBe("ready");
  expect(resume.mock.calls[0]?.[2]).toMatchObject(selection);
  expect(stored.map(entry => entry.input)).toContainEqual({ service: "github", mode: "token", accessToken: "only-at-github-two" });
  for (const bytes of [...f.cloud.values()][0]!.files.values()) expect(Buffer.from(bytes).toString()).not.toContain("only-at-");
  expect(JSON.stringify([create.mock.calls, resume.mock.calls])).not.toContain("only-at-");
  await f.api(f.path + "/pause", {}); expect((await f.settled()).state).toBe("paused");
  delete profile.githubCredentialFile;
  delete profile.anthropicCredentialFile;
  await f.api(f.path + "/resume", {}); expect((await f.settled()).state).toBe("ready");
  expect(resume.mock.calls.at(-1)?.[2]?.modelCredentials).toEqual({});
}, 60_000);
