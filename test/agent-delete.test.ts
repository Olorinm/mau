import { afterEach, expect, it, vi } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DurableStore } from "../src/store.js";
import { mauFixture, root } from "./fixtures/mau.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});
const remove = (f: Awaited<ReturnType<typeof mauFixture>>, id: string, owner = "alice") =>
  fetch(`${f.base}${root}/agents/${id}`, { method: "DELETE", headers: { authorization: "Bearer " + owner } })
    .then(async (response) => ({ status: response.status, data: response.status === 204 ? null : await response.json() as any }));
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
  expect((await remove(f, f.agent.id)).status).toBe(500);
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
