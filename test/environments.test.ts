import { afterEach, expect, it, vi } from "vitest";
import { statSync } from "node:fs";
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
const fixture = (workspaceBackend?: any) => mauFixture(cleanup, {}, workspaceBackend);

it("owner-scoped durable allocation publishes verified bootstrap once and binds a private Host", async () => {
  const f = await fixture();
  expect((await f.api("/options", undefined, "bob")).data.environments).toEqual(
    [],
  );
  expect((await f.api(f.path, { profileId: "cloud" }, "bob")).status).toBe(404);
  expect(
    (await f.api(f.path, { profileId: "cloud", command: "evil" })).status,
  ).toBe(400);
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  const ready = await f.settled();
  expect(ready.state).toBe("ready");
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
  expect(setup.connections).toEqual([{ id: "matrix", kind: "matrix" }]);
  const runtime = await f.service.runtime(f.agent.id);
  const room = "!web-chat:example.test";
  runtime.connector.store.set("rooms", room, { members: [alice, f.agent.matrixId], encrypted: false });
  runtime.connector.ingest(room, {
    event_id: "$web-hi", sender: alice, type: "m.room.message",
    content: { msgtype: "m.text", body: "hi" }, origin_server_ts: Date.now() + 1,
  });
  expect(runtime.connector.store.entries<any>("communication_inbox").map(row => row.value))
    .toContainEqual(expect.objectContaining({ connectionId: "matrix", source: expect.objectContaining({ text: "hi" }) }));
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
it("Mau creates the Router identity under the same owner and Router no longer exposes provisioning", async () => {
  const f = await fixture();
  expect((await f.api("/info")).data).toEqual({ homeserver: "https://example.test" });
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
  runtime.connector.store.set("communication_runs", "fixture-run", {
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
    runtime.connector.store.set("communication_runs", "fixture-run", { phase: "unknown" });
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
  f.provider.exec = async function* (id, argv, options) {
    if (argv[0] === "node" && argv[2] === "prepare") {
      yield { stream: "stdout", text: JSON.stringify({ username: "user", hostKey: key }) };
      options?.onExit?.({ exitCode: 0 }); return;
    }
    yield* exec(id, argv, options);
  };
  const prepared = await f.api(path, { publicKey: key });
  expect(prepared.status).toBe(200);
  expect(prepared.data).toEqual({ username: "user", hostKey: key, keyId: sshKeyId(key) });
  expect(JSON.stringify(prepared.data)).not.toMatch(/private-traffic|Bearer|ssh-token/);
  // Upgrade must repeat authentication and ownership checks, bypassing neither via HTTP Upgrade.
  await expect(connectSshTunnel(new URL(path + "/" + sshKeyId(key), f.base), { Authorization: "Bearer bob" }))
    .rejects.toThrow("ssh_connection_rejected");
  const lease = await f.mau.environments.connectSsh(alice, f.agent.id, sshKeyId(key));
  expect(lease.url.pathname).toBe("/ssh");
  expect(lease.headers["e2b-traffic-access-token"]).toBe("private-traffic-token");
  expect((await f.api(f.path + "/pause", {})).data.error).toBe("environment_has_active_ssh");
  expect((await f.api(f.path + "/destroy", {})).data.error).toBe("environment_has_active_ssh");
  lease.release(); lease.release();
  expect((await f.api(f.path + "/pause", {})).status).toBe(202);
  expect((await f.settled()).state).toBe("paused");
  expect((await f.api(path, { publicKey: key })).data.error).toBe("environment_not_ready");
});

function workspaceFixture() {
  const objects = new Map<string, Uint8Array>();
  const key = (owner: string, id: string, path: string) => `${owner}/${id}/${path}`;
  const store = {
    async put(input: any) { objects.set(key(input.tenantId, input.workspaceId, input.path), new Uint8Array(input.body)); return { path: input.path, size: input.body.length }; },
    async stat(owner: string, id: string, path: string) { const value = objects.get(key(owner, id, path)); return value ? { path, size: value.length, contentType: 'application/octet-stream' } : null; },
    async list(owner: string, id: string) { const prefix = key(owner, id, ''); return [...objects].filter(([k]) => k.startsWith(prefix)).map(([k,v]) => ({ path: k.slice(prefix.length), size: v.length })); },
    async delete(owner: string, id: string, path: string) { return objects.delete(key(owner, id, path)); },
    async createSignedReadUrl() { return 'https://storage.fixture/file?signature=private'; },
  };
  return { store, objects,
    prepare: vi.fn(async (owner: string, id: string) => ({ kind: 'volcengine-tos-static', target: { bucket: 'fixture', prefix: `${owner}/${id}/`, mountPath: '/home/user/workspace' }, template: 'shared-template', metadata: { workspace: id } })),
    verify: vi.fn(async () => {}),
  };
}
it('workspaces are owner-scoped, explicitly shared and retained after an Agent is destroyed', async () => {
  const backend = workspaceFixture(), f = await fixture(backend);
  const workspace = (await f.api('/workspaces', { name: 'Team' })).data;
  expect((await f.api('/workspaces', undefined, 'bob')).data.data).toEqual([]);
  expect((await f.api(`/workspaces/${workspace.id}`, undefined, 'bob')).status).toBe(404);
  expect((await f.api(f.path, { profileId: 'cloud', workspaceId: workspace.id })).status).toBe(202);
  expect((await f.settled()).workspaceId).toBe(workspace.id);
  expect(backend.verify).toHaveBeenCalledTimes(1);
  expect(backend.prepare.mock.calls[0]![0]).toMatch(/^[a-f0-9]{64}$/);
  const second = await f.service.create(alice, 'coworker');
  await f.mau.environments.begin(alice, second.id, 'cloud', workspace.id);
  for(let n=0;n<200 && f.mau.environments.summary(alice,second.id)?.busy;n++) await new Promise(r=>setTimeout(r,10));
  expect(f.mau.environments.summary(alice,second.id)?.state).toBe('ready');
  expect(backend.prepare.mock.calls[0]).toEqual(backend.prepare.mock.calls[1]);
  const bytes = Uint8Array.from([0,255,128,10]);
  const url = f.base + root + `/workspaces/${workspace.id}/file?path=${encodeURIComponent('素材/%2f.bin')}`;
  const response = await fetch(url,{method:'PUT',headers:{authorization:'Bearer alice','content-type':'application/octet-stream'},body:bytes});
  expect(response.status).toBe(200);
  expect([...backend.objects.values()][0]).toEqual(bytes);
  expect((await f.api(`/workspaces/${workspace.id}/files`)).data.data).toHaveLength(1);
  expect((await fetch(url,{method:'PUT',headers:{authorization:'Bearer bob','content-type':'application/octet-stream'},body:bytes})).status).toBe(404);
  expect((await f.api(`/workspaces/${workspace.id}/download?path=../secret`)).status).toBe(400);
  await f.api(f.path+'/destroy',{}); expect((await f.settled()).state).toBe('deleted');
  expect((await f.api(`/workspaces/${workspace.id}/files`)).data.data).toHaveLength(1);
});
it('mount failures prevent private bootstrap and are rechecked after recovery and resume', async () => {
  const backend = workspaceFixture(); backend.verify.mockRejectedValueOnce(new Error('secret storage diagnostics'));
  const f = await fixture(backend);
  await f.api(f.path,{profileId:'cloud'});
  const failed = await f.settled(); expect(failed.error).toBe('workspace_mount_unavailable');
  expect([...f.cloud.values()][0]!.files.size).toBe(0);
  const workspaceId = failed.workspaceId;
  await f.api(f.path+'/reconcile',{}); expect((await f.settled()).state).toBe('ready');
  expect(f.creates).toBe(1);
  await f.api(f.path+'/pause',{}); await f.settled();
  const before=backend.verify.mock.calls.length;
  await f.api(f.path+'/resume',{}); expect((await f.settled()).workspaceId).toBe(workspaceId);
  expect(backend.verify.mock.calls.length).toBeGreaterThan(before);
  expect((await f.api('/workspaces')).data.data).toHaveLength(1);
  const other=(await f.api('/workspaces',{name:'Other'})).data;
  expect((await f.api(f.path,{profileId:'cloud',workspaceId:other.id})).status).toBe(409);
});
it('unknown creates keep the original Workspace binding and reconcile without allocating twice', async () => {
  const backend=workspaceFixture(), f=await fixture(backend);f.loseCreate();
  await f.api(f.path,{profileId:'cloud'});const failed=await f.settled();
  await f.api(f.path+'/reconcile',{});const ready=await f.settled();
  expect(ready.state).toBe('ready');expect(ready.workspaceId).toBe(failed.workspaceId);
  expect(f.creates).toBe(1);expect(backend.prepare).toHaveBeenCalledTimes(1);
  expect(backend.verify).toHaveBeenCalledTimes(1);
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
