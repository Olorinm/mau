import { afterEach, expect, it, vi } from "vitest";
import { routerApiReference } from "@agent-router/server";
import { apiRoot, mauApiReference, mauRouteScope, requestScope, tokenScopes } from "../src/api-reference.js";
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
  // Every route says what it needs. A GET reads, except the list of access tokens, which is the owner's alone like
  // the routes that create and revoke them; nothing else of Mau's is.
  const scopes = ["read", "chat", "approve", "manage", "owner"];
  for (const route of mauApiReference) expect(scopes, `${route.method} ${route.path}`).toContain(route.scope);
  const tokenRoutes = ["GET /_mau/v1/tokens", "POST /_mau/v1/tokens", "DELETE /_mau/v1/tokens/:id"];
  expect(mauApiReference.filter(route => route.scope === "owner").map(route => `${route.method} ${route.path}`)).toEqual(tokenRoutes);
  for (const route of mauApiReference) if (route.method === "GET" && route.scope !== "owner") expect(route.scope, route.path).toBe("read");
  for (const route of mauApiReference) if (route.method !== "GET") expect(route.scope, `${route.method} ${route.path}`).not.toBe("read");
  for (const route of routerApiReference) expect(scopes, `${route.method} ${route.path}`).toContain(route.scope);
  expect(tokenScopes).toEqual(["chat", "approve", "manage"]);
  // Bodies are JSON Schema of what the route parses.
  const body = (method: string, path: string) => mauApiReference.find(route => route.method === method && route.path === apiRoot + path)!.body;
  expect(body("PUT", "/agents/:id/connectors")).toMatchObject({ type: "object", properties: { connections: { type: "array" } }, required: ["connections"], additionalProperties: false });
  expect(body("POST", "/agents")).toMatchObject({ anyOf: [{ required: ["name", "profileId"] }, { required: ["name", "shareWith"] }] });
  expect(body("GET", "/agents")).toBeUndefined();
});

it("finds the scope of a concrete request only when it is exactly a listed route", () => {
  const id = "0b54cbb9-6a0f-4f5c-9d0a-3a8f6c1e2d47";
  // Every listed route is found under its own scope, with any value in place of a parameter.
  for (const route of mauApiReference.filter(route => route.path.startsWith(apiRoot)))
    expect(mauRouteScope(route.method, route.path.replace(/:[A-Za-z]+/g, "x-1")), `${route.method} ${route.path}`).toBe(route.scope);
  expect(mauRouteScope("POST", `${apiRoot}/agents/${id}/dismiss`)).toBe("manage");
  expect(mauRouteScope("POST", `${apiRoot}/agents/${id}/memory/pending/p1/approve`)).toBe("approve");
  expect(mauRouteScope("POST", `${apiRoot}/agents/${id}/environment/replace`)).toBe("manage");
  expect(mauRouteScope("DELETE", `${apiRoot}/tokens/0123456789abcdef`)).toBe("owner");
  for (const [method, path] of [["POST", `${apiRoot}/agents/${id}/dismiss/`], ["POST", `${apiRoot}/agents/${id}/DISMISS`], ["POST", `/_MAU/v1/agents/${id}/dismiss`],
    ["POST", `${apiRoot}//agents/${id}/dismiss`], ["POST", `${apiRoot}/agents//dismiss`], ["POST", `${apiRoot}/agents%2F${id}/dismiss`], ["POST", `${apiRoot}/agents/${id}%2Fdismiss`],
    ["POST", `${apiRoot}/agents/${id}/dismiss?x=1`], ["POST", `${apiRoot}/agents/${id}/dismiss\n`], ["POST", ` ${apiRoot}/agents/${id}/dismiss`], ["post", `${apiRoot}/agents/${id}/dismiss`],
    ["PATCH", `${apiRoot}/agents/${id}/dismiss`], ["HEAD", `${apiRoot}/agents`], ["POST", `/agents/${id}/dismiss`], ["POST", `${apiRoot}/agents/${id}/dismiss/extra`],
    ["POST", `http://mau.example${apiRoot}/agents/${id}/dismiss`], ["POST", `${apiRoot}/agents/${id}/unknown`], ["POST", apiRoot], ["POST", ""]] as const)
    expect(mauRouteScope(method, path), `${method} ${JSON.stringify(path)}`).toBeUndefined();
  // A request as it arrives: the query is not part of the route, Router's routes are Router's to classify, and an
  // upgrade under Mau's prefix is the SSH tunnel or nothing.
  const scope = (method: string, originalUrl: string, headers: Record<string, string> = {}) => requestScope({ method, originalUrl, headers });
  expect(scope("POST", `${apiRoot}/agents/${id}/dismiss?x=/memory/pending/p/approve`)).toBe("manage");
  expect(scope("post", `${apiRoot}/agents/${id}/dismiss`)).toBe("manage");
  expect(scope("POST", `/_agent-router/v1/web/chats/dm:${id}/cards/c1/answer`)).toBe("approve");
  expect(scope("POST", `/_agent-router/v1/web/chats/dm:${id}/purge`)).toBe("owner");
  expect(scope("POST", `/_agent-router/v1/web/chats/dm:${id}/purge/`)).toBeUndefined();
  expect(scope("POST", `/_agent-router/v1/WEB/chats/dm:${id}/cards/c1/answer`)).toBeUndefined();
  expect(scope("POST", "/oauth/callback")).toBeUndefined();
  expect(scope("GET", "/oauth/callback")).toBeUndefined();
  expect(scope("GET", `${apiRoot}/agents/${id}/ssh/${"a".repeat(64)}`)).toBe("read");
  expect(scope("GET", `${apiRoot}/agents/${id}/ssh/${"a".repeat(64)}`, { upgrade: "mau-ssh" })).toBe("manage");
  expect(scope("GET", `${apiRoot}/agents/${id}/ssh/${"a".repeat(64)}/`, { upgrade: "mau-ssh" })).toBeUndefined();
  expect(scope("GET", `${apiRoot}/agents`, { upgrade: "websocket" })).toBeUndefined();
  expect(scope("POST", `${apiRoot}/agents/${id}/ssh/${"a".repeat(64)}`, { upgrade: "mau-ssh" })).toBeUndefined();
  expect(requestScope({ headers: {}, originalUrl: `${apiRoot}/agents` })).toBeUndefined();
  expect(requestScope({ headers: {}, method: "POST" })).toBeUndefined();
});

it("serves the reference to a signed-in owner: Mau's routes, then Router's", async () => {
  const f = await mauFixture(cleanup);
  expect((await fetch(f.base + apiRoot + "/reference")).status).toBe(401);
  const { status, data } = await f.api("/reference");
  expect(status).toBe(200);
  expect(Object.keys(data)).toEqual(["routes"]);
  expect(data.routes).toEqual(JSON.parse(JSON.stringify([...mauApiReference, ...routerApiReference])));
  const listed = data.routes.map((route: { method: string; path: string }) => `${route.method} ${route.path}`);
  expect(new Set(listed).size).toBe(listed.length);
  for (const route of ["DELETE /_agent-router/v1/agents/:agentId/connections/:connectionId", "GET /_agent-router/v1/agents/:agentId/connections/:connectionId/access",
    "PUT /_agent-router/v1/agents/:agentId/connections/:connectionId/access", "POST /_agent-router/v1/web/socket-tickets"]) expect(listed).toContain(route);
});
