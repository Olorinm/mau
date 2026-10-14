import { afterEach, expect, it, vi } from "vitest";
import { mauFixture } from "./fixtures/mau.js";
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });

it("keeps Host access inside the authenticated owner's current ready environment", async () => {
  const f = await mauFixture(cleanup);
  const path = `/agents/${f.agent.id}/host/v1/runtimes`;
  expect((await f.api(path)).status).toBe(409);
  expect((await f.api(path, undefined, "bob")).status).toBe(404);
  expect((await f.api(path, undefined, "invalid")).status).toBe(401);
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  expect((await f.settled()).state).toBe("ready");
  expect(await f.api(path)).toEqual({ status: 200, data: { runtimes: [{ id: "personal" }] } });
  const inspected = await f.api(`/agents/${f.agent.id}/host/v1/runtimes/inspect`, { runtimeId: "personal" });
  expect(inspected).toEqual({ status: 200, data: { id: "personal", available: true } });
  expect((await f.api(`/agents/${f.agent.id}/host/v1/private-configuration`)).status).toBe(404);
  expect((await f.api(`/agents/${f.agent.id}/host/v1/runtimes`, {})).status).toBe(404);
  expect(JSON.stringify(inspected)).not.toMatch(/traffic-token|Bearer|service\/token/);
  await f.api(f.path + "/pause", {}); await f.settled();
  expect((await f.api(path)).status).toBe(409);
});
