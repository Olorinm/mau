import { afterEach, expect, it, vi } from "vitest";
import { mauFixture } from "./fixtures/mau.js";
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });
it("has no business-data connector endpoints", async () => {
  const f = await mauFixture(cleanup);
  expect((await f.api("/connectors")).status).toBe(404);
  expect((await f.api(`/connectors/${f.agent.id}/check`, {})).status).toBe(404);
});
