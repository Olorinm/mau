import { afterEach, expect, it, vi } from "vitest";
import { mauFixture } from "./fixtures/mau.js";
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });
it("requires the account and agent owner for connector management and reports missing configuration", async () => {
  const f = await mauFixture(cleanup);
  expect((await f.api("/connectors", undefined, "invalid")).status).toBe(401);
  expect((await f.api("/connectors")).data).toEqual({data:[]});
  expect((await f.api(`/connectors/${f.agent.id}/check`, {}, "bob")).status).toBe(404);
  expect((await f.api(`/connectors/${f.agent.id}/check`, {})).data).toEqual({error:"connector_not_configured"});
});
