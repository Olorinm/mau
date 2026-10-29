import express from "express";
import { rateLimit } from "express-rate-limit";
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { z } from "zod";
import type { Server } from "node:http";
import { attachSsh, sshKeyId } from "./ssh.js";
import { webConsole } from "./web.js";
import { createRouter, RouterError, type ServiceConfig, type ServiceDependencies } from "@agent-router/server";
import { EnvironmentManager, environmentOptionsSchema, type Environments } from "./environments.js";
import { validateArtifactPath, type WorkspaceBackend } from "@olorinm/agent-environment/workspace";

import { BusinessTools, businessToolsSchema } from "./business-tools.js";
import { DurableStore } from "./store.js";
import { ConnectorAccounts, connectorAccountsSchema } from "./connector-accounts.js";

const optionsSchema = z.object({
  environments: environmentOptionsSchema,
  businessTools: businessToolsSchema,
  connectorAccounts: connectorAccountsSchema,
  connectionsFile: z.string().min(1).optional(),
  publicHomeserver: z.url().optional(),
}).strict();
export const apiRoot = "/_mau/v1";

/** One product process composes independent components; it shares Router accounts, never duplicates them. */
export function createMau(config: ServiceConfig, optionsFile: string, dependencies: {
  router?: Omit<ServiceDependencies, "configure">;
  environments?: () => Promise<Environments>;
  workspaces?: () => Promise<WorkspaceBackend>;
} = {}, serving: { webRoot?: string } = {}) {
  const base = dirname(resolve(optionsFile));
  const options = optionsSchema.parse(JSON.parse(readFileSync(optionsFile, "utf8")));
  const publicHomeserver = new URL(options.publicHomeserver ?? `https://${config.serverName}`);
  if (!["https:", "http:"].includes(publicHomeserver.protocol) || publicHomeserver.username ||
      publicHomeserver.password || publicHomeserver.search || publicHomeserver.hash || publicHomeserver.pathname !== "/")
    throw new Error("invalid_public_homeserver_url");
  let environments: EnvironmentManager;
  const businessStore = new DurableStore(join(config.stateDir, "business-tools.sqlite"), config.serverName);
  const business = new BusinessTools(options.businessTools, base, businessStore);
  const connectorAccounts = new ConnectorAccounts(options.connectorAccounts, base);
  const router = createRouter({ ...config, stateDir: join(config.stateDir, "router") }, {
    ...(dependencies.router ? { dependencies: dependencies.router } : {}),
    connections: options.connectionsFile ? resolve(base, options.connectionsFile) : {},
    hosts: {
      assertReady: (id, binding) => environments.assertReady(id, binding),
      wake: (id, binding) => environments.wake(id, binding),
      host: (id, binding) => business.host(id, router.service.agent(id).owner, binding, environments.http(id, binding)),
      http: (id, binding) => environments.http(id, binding),
    },
  });
  environments = new EnvironmentManager(router.connections, router.service, options.environments,
    base, join(config.stateDir, "mau"), dependencies.environments, dependencies.workspaces);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustedProxies ?? false);
  // The console only reads its own files; product and Router routes keep their own handlers.
  if (serving.webRoot) app.use(webConsole(serving.webRoot, publicHomeserver.origin));
  const product = express.Router();
  product.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: "draft-8", legacyHeaders: false }));
  product.use(express.json({ limit: "16kb" }));
  product.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  // Login needs the public account endpoint, never the internal Matrix service address.
  product.get("/info", (_req, res) => res.json({ homeserver: publicHomeserver.origin }));
  product.use(async (req, res, next) => {
    res.locals.owner = await router.service.authenticate(req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? "");
    next();
  });
  product.get("/account", (_req, res) => res.json({ owner: res.locals.owner }));
  product.get("/connector-accounts", async (_req, res) => res.json(await connectorAccounts.list(res.locals.owner)));
  product.post("/connector-accounts/:id/:action", async (req, res) => {
    z.object({}).strict().parse(req.body);
    const action = z.enum(["check", "connect", "disconnect"]).parse(req.params.action);
    res.json(await connectorAccounts.action(res.locals.owner, String(req.params.id), action));
  });
  product.get("/connectors", (_req, res) => res.json({ data: business.inventory(res.locals.owner) }));
  product.post("/connectors/:agentId/check", async (req, res) => {
    z.object({}).strict().parse(req.body);
    const id = String(req.params.agentId);
    router.service.owned(id, res.locals.owner);
    if (!business.inventory(res.locals.owner).some(item => item.agentId === id)) throw new RouterError("connector_not_configured", 404);
    try { res.json(await business.check(res.locals.owner, id)); }
    catch { throw new RouterError("connector_check_failed", 502); }
  });
  product.get("/options", (_req, res) => res.json({
    environments: environments.profiles(res.locals.owner).map(({ id, label, kernel, workspace }) => ({ id, label, kernel, workspace: workspace === true })),
  }));
  const filePath = z.string().min(1).max(1023).refine(value => {
    try { validateArtifactPath(value); return true; } catch { return false; }
  });
  product.get("/workspaces", (_req, res) => res.json({ data: environments.workspaces.list(res.locals.owner) }));
  product.post("/workspaces", (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(100) }).strict().parse(req.body);
    res.status(201).json(environments.workspaces.create(res.locals.owner, name));
  });
  product.get("/workspaces/:id", (req, res) => res.json(environments.workspaces.view(
    environments.workspaces.owned(res.locals.owner, String(req.params.id)))));
  product.get("/workspaces/:id/files", async (req, res) => {
    const { prefix } = z.object({ prefix: filePath.optional() }).strict().parse(req.query);
    res.json({ data: await environments.workspaces.files(res.locals.owner, String(req.params.id), prefix) });
  });
  product.put("/workspaces/:id/file", express.raw({ type: "application/octet-stream", limit: "16mb" }), async (req, res) => {
    const { path } = z.object({ path: filePath }).strict().parse(req.query);
    if (!Buffer.isBuffer(req.body)) throw new RouterError("binary_body_required", 400);
    res.json(await environments.workspaces.put(res.locals.owner, String(req.params.id), path, req.body));
  });
  product.delete("/workspaces/:id/file", async (req, res) => {
    const { path } = z.object({ path: filePath }).strict().parse(req.query);
    res.json({ deleted: await environments.workspaces.remove(res.locals.owner, String(req.params.id), path) });
  });
  product.get("/workspaces/:id/download", async (req, res) => {
    const { path } = z.object({ path: filePath }).strict().parse(req.query);
    res.json(await environments.workspaces.download(res.locals.owner, String(req.params.id), path));
  });
  const summary = (owner: string, id: string) => ({
    ...router.connections.summary(router.service.owned(id, owner)),
    environment: environments.summary(owner, id),
  });
  product.get("/agents", (_req, res) => res.json({ data: router.service.agents(res.locals.owner).map(a => summary(a.owner, a.id)) }));
  product.post("/agents", async (req, res) => {
    const input = z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), profileId: z.string().min(1).max(48), workspaceId: z.uuid().optional() }).strict().parse(req.body);
    const profile = environments.profiles(res.locals.owner).find(p => p.id === input.profileId);
    if (!profile) throw new RouterError("environment_profile_not_assigned", 403);
    if (input.workspaceId && !profile.workspace) throw new RouterError("environment_workspace_not_supported", 409);
    if (input.workspaceId) environments.workspaces.owned(res.locals.owner, input.workspaceId);
    const agent = await router.service.create(res.locals.owner, input.name);
    await environments.begin(res.locals.owner, agent.id, input.profileId, input.workspaceId);
    res.status(202).json(summary(res.locals.owner, agent.id));
  });
  product.get("/agents/:id", (req, res) => res.json(summary(res.locals.owner, String(req.params.id))));
  product.post("/agents/:id/ssh", async (req, res) => {
    const { publicKey } = z.object({ publicKey: z.string().max(128) }).strict().parse(req.body);
    sshKeyId(publicKey);
    res.json(await environments.prepareSsh(res.locals.owner, String(req.params.id), publicKey));
  });
  product.get("/agents/:id/environment", (req, res) => res.json(environments.summary(res.locals.owner, String(req.params.id)) ?? { state: "unconfigured", busy: false }));
  product.post("/agents/:id/environment", async (req, res) => {
    const { profileId, workspaceId } = z.object({ profileId: z.string().min(1).max(48), workspaceId: z.uuid().optional() }).strict().parse(req.body);
    res.status(202).json(await environments.begin(res.locals.owner, String(req.params.id), profileId, workspaceId));
  });
  product.post("/agents/:id/environment/replace", async (req, res) => {
    const input = z.object({ profileId: z.string().min(1).max(48), expectedOperationId: z.uuid() }).strict().parse(req.body);
    res.status(202).json(await environments.replace(res.locals.owner, String(req.params.id), input.profileId, input.expectedOperationId));
  });
  product.post("/agents/:id/environment/rollback", async (req, res) => {
    const input = z.object({ expectedOperationId: z.uuid() }).strict().parse(req.body);
    res.status(202).json(await environments.rollbackReplacement(res.locals.owner, String(req.params.id), input.expectedOperationId));
  });
  product.post("/agents/:id/environment/:action", async (req, res) => {
    z.object({}).strict().parse(req.body);
    const action = z.enum(["pause", "resume", "destroy", "reconcile"]).parse(req.params.action);
    res.status(202).json(await environments.action(res.locals.owner, String(req.params.id), action));
  });
  product.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(apiRoot, product);
  app.use(router.app);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Body parser rejections (malformed JSON, oversized bodies) are client errors.
    const parser = error instanceof Error && "type" in error && "status" in error &&
      typeof error.status === "number" && error.status >= 400 && error.status < 500 ? error.status : undefined;
    res.status(error instanceof RouterError ? error.status : error instanceof z.ZodError ? 400 : parser ?? 500)
      .json({ error: error instanceof RouterError ? error.message : error instanceof z.ZodError ? "invalid_request"
        : parser === 413 ? "request_too_large" : parser ? "invalid_request" : "operation_failed" });
  });
  const sshServers = new Set<() => void>();
  return { app, router, environments, start: () => router.start(),
    attach: (server: Server) => { sshServers.add(attachSsh(server, token => router.service.authenticate(token),
      (owner, agentId, keyId) => environments.connectSsh(owner, agentId, keyId))); },
    close: async () => { for (const close of sshServers) close(); await environments.close(); await router.close(); businessStore.close(); } };
}
