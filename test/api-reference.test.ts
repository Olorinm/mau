import { afterEach, expect, it, vi } from "vitest";
import { apiRoot, mauApiReference } from "../src/api-reference.js";
import { mauFixture } from "./fixtures/mau.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });

interface Layer { route?: { path: string; methods: Record<string, boolean> }; handle: { stack?: Layer[] } }
const routes = (stack: Layer[], prefix = "") => stack.flatMap(layer => layer.route
  ? Object.keys(layer.route.methods).map(method => `${method.toUpperCase()} ${prefix}${layer.route!.path}`) : []);

it("lists exactly the routes the service registers", async () => {
  const f = await mauFixture(cleanup);
  const stack = (f.mau.app as unknown as { router: { stack: Layer[] } }).router.stack;
  // The product router is the mounted router that has `/info`; Router's own app is mounted after it.
  const product = stack.map(layer => layer.handle.stack).find(nested => nested?.some(layer => layer.route?.path === "/info"))!;
  const registered = [...routes(stack), ...routes(product, apiRoot),
    // The SSH tunnel is an HTTP upgrade the server handles before express (`attachSsh`).
    `GET ${apiRoot}/agents/:id/ssh/:keyId`];
  expect(registered.length).toBeGreaterThan(50);
  expect(routes(stack)).toEqual(["GET /oauth/callback"]);
  const listed = mauApiReference.map(route => `${route.method} ${route.path}`);
  expect(new Set(listed).size).toBe(listed.length);
  expect([...listed].sort()).toEqual([...registered].sort());
  for (const route of mauApiReference) expect(route.summary, route.path).toMatch(/^[A-Z].*\.$/);
  // Bodies are JSON Schema of what the route parses.
  const body = (method: string, path: string) => mauApiReference.find(route => route.method === method && route.path === apiRoot + path)!.body;
  expect(body("PUT", "/agents/:id/connectors")).toMatchObject({ type: "object", properties: { connections: { type: "array" } }, required: ["connections"], additionalProperties: false });
  expect(body("POST", "/agents")).toMatchObject({ anyOf: [{ required: ["name", "profileId"] }, { required: ["name", "shareWith"] }] });
  expect(body("GET", "/agents")).toBeUndefined();
});

it("serves the reference to a signed-in owner and says when Router's part is missing", async () => {
  const f = await mauFixture(cleanup);
  expect((await fetch(f.base + apiRoot + "/reference")).status).toBe(401);
  const { status, data } = await f.api("/reference");
  expect(status).toBe(200);
  expect(data.routes.slice(0, mauApiReference.length)).toEqual(JSON.parse(JSON.stringify(mauApiReference)));
  // Router's routes follow when the installed Router package publishes its table; otherwise the answer says so.
  const router = (await import("@agent-router/server") as { routerApiReference?: unknown[] }).routerApiReference;
  expect(data.routes.length).toBe(mauApiReference.length + (router?.length ?? 0));
  expect(data.routerReference).toBe(router ? undefined : "unavailable");
});
