import express from "express";
import { rateLimit } from "express-rate-limit";
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { z } from "zod";
import { createRouter, RouterError, type ServiceConfig, type ServiceDependencies } from "@agent-router/server";
import { EnvironmentManager, environmentOptionsSchema, type Environments } from "./environments.js";

const optionsSchema = z.object({
  environments: environmentOptionsSchema,
  connectionsFile: z.string().min(1).optional(),
  publicHomeserver: z.url().optional(),
}).strict();
export const apiRoot = "/_mau/v1";

/** One product process composes independent components; it shares Router accounts, never duplicates them. */
export function createMau(config: ServiceConfig, optionsFile: string, dependencies: {
  router?: Omit<ServiceDependencies, "configure">;
  environments?: () => Promise<Environments>;
} = {}) {
  const base = dirname(resolve(optionsFile));
  const options = optionsSchema.parse(JSON.parse(readFileSync(optionsFile, "utf8")));
  const publicHomeserver = new URL(options.publicHomeserver ?? `https://${config.serverName}`);
  if (!["https:", "http:"].includes(publicHomeserver.protocol) || publicHomeserver.username ||
      publicHomeserver.password || publicHomeserver.search || publicHomeserver.hash || publicHomeserver.pathname !== "/")
    throw new Error("invalid_public_homeserver_url");
  let environments: EnvironmentManager;
  const router = createRouter({ ...config, stateDir: join(config.stateDir, "router") }, {
    ...(dependencies.router ? { dependencies: dependencies.router } : {}),
    connections: options.connectionsFile ? resolve(base, options.connectionsFile) : {},
    hosts: {
      assertReady: (id, binding) => environments.assertReady(id, binding),
      host: (id, binding) => environments.host(id, binding),
      http: (id, binding) => environments.http(id, binding),
    },
  });
  environments = new EnvironmentManager(router.connections, router.service, options.environments,
    base, join(config.stateDir, "mau"), dependencies.environments);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustedProxies ?? false);
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
  product.get("/options", (_req, res) => res.json({
    environments: environments.profiles(res.locals.owner).map(({ id, label, kernel }) => ({ id, label, kernel })),
  }));
  const summary = (owner: string, id: string) => ({
    ...router.connections.summary(router.service.owned(id, owner)),
    environment: environments.summary(owner, id),
  });
  product.get("/agents", (_req, res) => res.json({ data: router.service.agents(res.locals.owner).map(a => summary(a.owner, a.id)) }));
  product.post("/agents", async (req, res) => {
    const input = z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), profileId: z.string().min(1).max(48) }).strict().parse(req.body);
    if (!environments.profiles(res.locals.owner).some(p => p.id === input.profileId)) throw new RouterError("environment_profile_not_assigned", 403);
    const agent = await router.service.create(res.locals.owner, input.name);
    await environments.begin(res.locals.owner, agent.id, input.profileId);
    res.status(202).json(summary(res.locals.owner, agent.id));
  });
  product.get("/agents/:id", (req, res) => res.json(summary(res.locals.owner, String(req.params.id))));
  product.get("/agents/:id/environment", (req, res) => res.json(environments.summary(res.locals.owner, String(req.params.id)) ?? { state: "unconfigured", busy: false }));
  product.post("/agents/:id/environment", async (req, res) => {
    const { profileId } = z.object({ profileId: z.string().min(1).max(48) }).strict().parse(req.body);
    res.status(202).json(await environments.begin(res.locals.owner, String(req.params.id), profileId));
  });
  product.post("/agents/:id/environment/:action", (req, res) => {
    z.object({}).strict().parse(req.body);
    const action = z.enum(["pause", "resume", "destroy", "reconcile"]).parse(req.params.action);
    res.status(202).json(environments.action(res.locals.owner, String(req.params.id), action));
  });
  product.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(apiRoot, product);
  app.use(router.app);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof RouterError ? error.status : error instanceof z.ZodError ? 400 : 500)
      .json({ error: error instanceof RouterError ? error.message : error instanceof z.ZodError ? "invalid_request" : "operation_failed" });
  });
  return { app, router, environments, start: () => router.start(),
    close: async () => { await environments.close(); await router.close(); } };
}
