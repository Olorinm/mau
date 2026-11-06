import { afterEach, expect, it, vi } from "vitest";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DurableStore } from "../src/store.js";
import { alice, mauFixture, root } from "./fixtures/mau.js";
import { startFailure } from "../src/app.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});
const remove = (f: Awaited<ReturnType<typeof mauFixture>>, id: string, owner = "alice") =>
  fetch(`${f.base}${root}/agents/${id}`, { method: "DELETE", headers: { authorization: "Bearer " + owner } })
    .then(async (response) => ({ status: response.status, data: response.status === 204 ? null : await response.json() as any }));
const captureStderr = () => {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => { lines.push(String(chunk)); return true; });
  return lines;
};
const environments = (f: Awaited<ReturnType<typeof mauFixture>>) => (f.mau.environments as any).store as DurableStore;
const rule = (agentId: string, id: string, extra: Record<string, unknown> = {}) => ({ id, owner: "@alice:example.test", agentId, status: "active", version: 1, ...extra });

it("deletes an employee with its environment, memory, schedules and product records, leaving other employees and the workspace", async () => {
  const f = await mauFixture(cleanup);
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");
  const kept = await f.service.create("@alice:example.test", "kept");
  f.mau.facts.mutate("@alice:example.test", f.agent.id, { action: "add", content: "prefers tea", target: "memory" });
  f.mau.facts.mutate("@alice:example.test", kept.id, { action: "add", content: "prefers coffee", target: "memory" });
  const schedules = f.mau.proactive.store;
  schedules.set("rules", "r1", rule(f.agent.id, "r1"));
  schedules.set("rules", "r2", rule(kept.id, "r2"));
  schedules.set("triggers", "t1", { id: "t1", status: "completed", rule: { id: "r1" } });
  schedules.set("daily_budgets", "r1:2026-11-05", 2);
  const business = new DurableStore(join(f.directory, "business-tools.sqlite"), "example.test");
  business.set("connector_approvals", `${f.agent.id}:op:run:call`, { state: "pending" });
  business.set("employee_memory_pending", "p1", { agentId: f.agent.id });
  business.set("employee_memory_pending", "p2", { agentId: kept.id });
  business.close();

  expect((await remove(f, f.agent.id, "bob")).status).toBe(404);
  expect(f.cloud.size).toBe(1);
  expect((await remove(f, f.agent.id)).status).toBe(204);

  expect(f.cloud.size).toBe(0);
  expect((await f.api("/agents")).data.data.map((a: any) => a.agent.name)).toEqual(["kept"]);
  expect((await f.api(`/agents/${f.agent.id}`)).status).toBe(404);
  expect(existsSync(join(f.directory, "mau", "agents", f.agent.id))).toBe(false);
  expect(readdirSync(join(f.directory, "mau", "memories"))).toHaveLength(1);
  expect(JSON.stringify(f.mau.facts.read("@alice:example.test", kept.id).files)).toContain("prefers coffee");
  expect(schedules.entries("rules").map((r) => r.id)).toEqual(["r2"]);
  expect(schedules.entries("triggers")).toHaveLength(0);
  expect(schedules.entries("daily_budgets")).toHaveLength(0);
  const after = new DurableStore(join(f.directory, "business-tools.sqlite"), "example.test");
  expect(after.entries("connector_approvals")).toHaveLength(0);
  expect(after.entries("employee_memory_pending").map((r) => r.id)).toEqual(["p2"]);
  after.close();
  // A new employee may reuse the name and gets a fresh identity and environment.
  const again = await f.api("/agents", { name: "helper", profileId: "cloud" });
  expect(again.status).toBe(202);
  expect(again.data.agent.id).not.toBe(f.agent.id);
});

it("keeps the employee when a schedule run is in flight or the cloud refuses to destroy its environment", async () => {
  const f = await mauFixture(cleanup);
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  await f.settled();
  f.mau.proactive.store.set("triggers", "t1", { id: "t1", status: "running", rule: { id: "r1" } });
  f.mau.proactive.store.set("rules", "r1", rule(f.agent.id, "r1", { activeRun: "t1" }));
  expect(await remove(f, f.agent.id)).toEqual({ status: 409, data: { error: "proactive_run_active" } });
  expect(f.cloud.size).toBe(1);
  f.mau.proactive.store.set("triggers", "t1", { id: "t1", status: "completed", rule: { id: "r1" } });
  const destroy = f.provider.destroy;
  f.provider.destroy = async () => { throw new Error("cloud_unavailable"); };
  const logged = captureStderr();
  expect(await remove(f, f.agent.id)).toEqual({ status: 502, data: { error: "environment_delete_failed" } });
  expect(logged.join("")).toContain('"event":"mau.environment_delete_failed"');
  expect(logged.join("")).toContain('"message":"cloud_unavailable"');
  expect(f.service.agent(f.agent.id).status).toBe("active");
  expect((await f.api(f.path)).data.state).toBe("needs_action");
  expect(f.mau.proactive.store.get<any>("rules", "r1").status).toBe("paused");
  f.provider.destroy = destroy;
  expect((await remove(f, f.agent.id)).status).toBe(204);
  expect(f.cloud.size).toBe(0);
});

it("deletes an employee whose environment was already destroyed, even when its provider is no longer configured", async () => {
  const f = await mauFixture(cleanup);
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  await f.settled();
  expect((await f.api(`${f.path}/destroy`, {})).status).toBe(202);
  expect((await f.settled()).state).toBe("deleted");
  f.provider.info = async () => { throw new Error("provider_must_not_be_called"); };
  expect((await remove(f, f.agent.id)).status).toBe(204);
  expect((await f.api("/agents")).data.data).toEqual([]);
});

it("treats retained and retired environments of a removed provider as gone, but never the current one", async () => {
  const f = await mauFixture(cleanup);
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  await f.settled();
  const store = environments(f), current = store.get<any>("environments", f.agent.id);
  const gone = (operationId: string) => ({ ...current, operationId, provider: "volc-shanghai", phase: "paused",
    ref: { provider: "volc-shanghai", id: "released-cluster-sandbox" }, previous: undefined });
  store.set("environments", f.agent.id, { ...current, previous: gone("00000000-0000-4000-8000-000000000001") });
  store.set("retired_environments", "00000000-0000-4000-8000-000000000002", gone("00000000-0000-4000-8000-000000000002"));
  // The current environment's outcome is unknown: retained records are settled, the employee stays.
  const info = f.provider.info;
  f.provider.info = async () => { throw new Error("cloud_timeout"); };
  captureStderr();
  expect((await remove(f, f.agent.id)).status).toBe(502);
  const after = store.get<any>("environments", f.agent.id);
  expect(after.phase).toBe("needs_action");
  expect(after.previous).toMatchObject({ phase: "deleted", error: "provider_not_configured" });
  expect(store.get<any>("retired_environments", "00000000-0000-4000-8000-000000000002"))
    .toMatchObject({ phase: "deleted", error: "provider_not_configured" });
  expect(f.service.agent(f.agent.id).status).toBe("active");
  f.provider.info = info;
  expect((await remove(f, f.agent.id)).status).toBe(204);
  expect(f.cloud.size).toBe(0);

  // A current binding on an unconfigured provider is never assumed gone.
  const g = await mauFixture(cleanup);
  expect((await g.api(g.path, { profileId: "cloud" })).status).toBe(202);
  await g.settled();
  const own = environments(g);
  own.set("environments", g.agent.id, { ...own.get<any>("environments", g.agent.id), provider: "volc-shanghai" });
  expect(await remove(g, g.agent.id)).toEqual({ status: 503, data: { error: "environment_provider_unavailable" } });
  expect(g.service.agent(g.agent.id).status).toBe("active");
});

it("deletes an employee whose sandbox is already missing without rebuilding its channel runtime", async () => {
  const f = await mauFixture(cleanup);
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");
  const connections = f.mau.router.connections, dir = connections.agentDirectory(f.agent.id);
  writeFileSync(join(dir, "feishu-secret"), "fixture-secret\n", { mode: 0o600 });
  writeFileSync(join(dir, "feishu.json"), JSON.stringify({ version: 1, appId: "cli_fixture", appSecretFile: "feishu-secret",
    domain: "feishu", ownerOpenId: "ou_owner" }), { mode: 0o600 });
  await connections.edit(alice, f.agent.id, (config) => {
    config.connections.push({ id: "feishu", kind: "feishu", credentialsFile: join(dir, "feishu.json"), domain: "feishu",
      ownerAddresses: [], peerAddresses: [], groupIds: [] });
  });
  expect(connections.summary(f.service.agent(f.agent.id)).connections.map((c) => c.kind)).toEqual(["matrix", "feishu"]);
  f.cloud.clear();
  // Rebuilding this runtime now throws a plain Error (host_binding_configuration_changed). Before the fix,
  // removeAgent rebuilt it after the cloud step: 500 operation_failed and needs_action/environment_lifecycle_unconfirmed.
  (await f.service.runtime(f.agent.id)).connector.store.set("communication_host", "scope", "stale-scope");
  f.provider.destroy = async () => { throw new Error("destroy_must_not_be_called"); };
  expect((await remove(f, f.agent.id)).status).toBe(204);
  expect((await f.api("/agents")).data.data).toEqual([]);
});

it("logs unexpected request errors and names the cause of a start failure", async () => {
  const f = await mauFixture(cleanup);
  const logged = captureStderr();
  const response = await fetch(`${f.base}${root}/agents/${f.agent.id}/environment`, { headers: { authorization: "Bearer alice" } });
  expect(response.status).toBe(200);
  vi.spyOn(f.mau.environments, "summary").mockImplementation(() => { throw new Error("unexpected_fixture_failure"); });
  const failed = await fetch(`${f.base}${root}/agents/${f.agent.id}/environment`, { headers: { authorization: "Bearer alice" } });
  expect(failed.status).toBe(500);
  expect(await failed.json()).toEqual({ error: "operation_failed" });
  expect(logged).toContain(JSON.stringify({ event: "mau.error", code: "operation_failed", message: "unexpected_fixture_failure" }) + "\n");
  const line = startFailure(Object.assign(new TypeError("router_state_unreadable"), { secret: "private-token" }));
  expect(line).toMatch(/^mau_start_failed: router_state_unreadable \(TypeError, at .+\)$/);
  expect(line).not.toContain("private-token");
  expect(line.split("\n")).toHaveLength(1);
});
