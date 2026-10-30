import express from "express";
import { rateLimit } from "express-rate-limit";
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { z } from "zod";
import type { Server } from "node:http";
import { attachSsh, sshKeyId } from "./ssh.js";
import { webConsole } from "./web.js";
import { createRouter, HttpAgentHost, RouterError, type ServiceConfig, type ServiceDependencies } from "@agent-router/server";
import { EnvironmentManager, environmentOptionsSchema, type Environments } from "./environments.js";
import { validateArtifactPath, type WorkspaceBackend } from "@olorinm/agent-environment/workspace";

import { BusinessTools, businessToolsSchema } from "./business-tools.js";
import { DurableStore } from "./store.js";
import { ConnectorAccounts, connectorAccountsSchema } from "./connector-accounts.js";
import { ConnectorRuntime } from "./connector-runtime.js";
import { ConnectedApps, connectedAppsSchema } from "./connected-apps.js";
import { EmployeeContext, MemoryError } from "./employee-context.js";
import { ProactiveWork, type ProactivePort } from "./proactive.js";
import { NativeEmployeeTools } from "./native-work.js";
import { SessionHistory, historyQuery } from "./session-history.js";
import { checkConnector } from "./connector-precheck.js";
import { MemoryReviewCoordinator, type RestrictedMemoryReviewer } from "./memory-review.js";
import { CompletedTurns } from "./completed-turns.js";

export { CodexRestrictedMemoryReviewer, codexReviewProfile, reviewProfileDigest } from "./restricted-memory-reviewer.js";
export type { ReviewRuntimeBinding, ReviewToolBinding, CodexRestrictedReviewerDependencies } from "./restricted-memory-reviewer.js";
export type { RestrictedMemoryReviewer } from "./memory-review.js";

const optionsSchema = z.object({
  environments: environmentOptionsSchema,
  businessTools: businessToolsSchema,
  connectorAccounts: connectorAccountsSchema,
  connectedApps: connectedAppsSchema,
  nativeWork: z.object({ employeeTools: z.boolean().default(false),
    memory: z.object({ writeApproval: z.boolean().default(false) }).strict().default({ writeApproval: false }),
    backgroundReview: z.object({ enabled: z.boolean().default(true), memoryInterval: z.number().int().min(0).max(1000000).default(10),
      skillInterval: z.number().int().min(0).max(1000000).default(15) }).strict().prefault({}),
  }).strict().prefault({}),
  connectionsFile: z.string().min(1).optional(),
  publicHomeserver: z.url().optional(),
}).strict();
export const apiRoot = "/_mau/v1";

/** One product process composes independent components; it shares Router accounts, never duplicates them. */
export function createMau(config: ServiceConfig, optionsFile: string, dependencies: {
  router?: Omit<ServiceDependencies, "configure">;
  environments?: () => Promise<Environments>;
  workspaces?: () => Promise<WorkspaceBackend>;
  reviewer?: RestrictedMemoryReviewer;
} = {}, serving: { webRoot?: string } = {}) {
  const base = dirname(resolve(optionsFile));
  const options = optionsSchema.parse(JSON.parse(readFileSync(optionsFile, "utf8")));
  const publicHomeserver = new URL(options.publicHomeserver ?? `https://${config.serverName}`);
  if (!["https:", "http:"].includes(publicHomeserver.protocol) || publicHomeserver.username ||
      publicHomeserver.password || publicHomeserver.search || publicHomeserver.hash || publicHomeserver.pathname !== "/")
    throw new Error("invalid_public_homeserver_url");
  let environments: EnvironmentManager;
  const businessStore = new DurableStore(join(config.stateDir, "business-tools.sqlite"), config.serverName);
  const connectedApps = new ConnectedApps(options.connectedApps, base);
  const business = new BusinessTools(options.businessTools, base, businessStore, connectedApps);
  const connectorAccounts = new ConnectorAccounts(options.connectorAccounts, base);
  const connectorRuntime = options.connectorAccounts?.runtimeConfigFile ? new ConnectorRuntime(
    resolve(base, options.connectorAccounts.runtimeConfigFile), options.connectorAccounts.url, new URL(config.publicUrl).origin, businessStore) : undefined;
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
  const sessions = async (owner: string, agentId: string) => {
    router.service.owned(agentId, owner);
    const value = (await router.service.runtime(agentId)).extension?.sessions;
    if (!value) throw new RouterError("host_sessions_unavailable", 409);
    return value;
  };
  const assertOwned = (owner: string, agentId: string) => { router.service.owned(agentId, owner); };
  const facts = new EmployeeContext(businessStore, assertOwned, { directory: join(config.stateDir, "mau", "memories"), writeApproval: options.nativeWork.memory.writeApproval });
  const history = new SessionHistory(businessStore, assertOwned);
  const proactiveStore = new DurableStore(join(config.stateDir, "proactive.sqlite"), config.serverName);
  const delivery = (value: { state: string; externalId?: string | null | undefined; error?: string | null | undefined } | null) => value ? {
    status: value.state === "accepted" ? "sent" : value.state,
    ...(value.externalId ? { externalId: value.externalId } : {}),
    ...(value.error ? { error: value.error } : {}),
  } : null;
  const proactivePort: ProactivePort = {
    validate: async rule => {
      const work = await sessions(rule.owner, rule.agentId);
      work.validateTarget(rule.targetSessionId);
      if (rule.session.type === "conversation") work.validateTarget(rule.session.sessionId);
      const assigned = connectedApps.connections(rule.agentId, rule.owner);
      if (rule.connections.some(id => !assigned.includes(id))) throw new RouterError("proactive_connection_not_assigned", 403);
      if (rule.execution.type === "agent" && rule.skills.length) {
        const catalog = z.object({ data: z.array(z.object({ skills: z.array(z.object({ name: z.string(), path: z.string(), enabled: z.boolean().optional() })) })) }).parse(await work.skills(true));
        if (rule.skills.some(skill => !catalog.data.some(entry => entry.skills.some(found => found.name === skill.name && found.path === skill.path && found.enabled !== false))))
          throw new RouterError("proactive_skill_not_available", 403);
      }
    },
    authorized: async rule => {
      router.service.owned(rule.agentId, rule.owner);
      if (!rule.connections.length) return true;
      const assigned = connectedApps.connections(rule.agentId, rule.owner), accounts = await connectorAccounts.list(rule.owner);
      return rule.connections.every(id => assigned.includes(id) && accounts.data.some(a => a.id === id && a.state === "connected"));
    },
    check: (rule, input) => checkConnector(connectedApps, rule, input),
    sessionState: async (rule, sessionId) => {
      const runs = (await sessions(rule.owner, rule.agentId)).getSession(sessionId).runs;
      if (runs.some(run => run.phase === "unknown")) return "unknown";
      return runs.some(run => run.phase !== "finished") ? "busy" : "idle";
    },
    submit: async (rule, input) => {
      if (input.idleOnly && await proactivePort.sessionState!(rule, input.sessionId) !== "idle") throw new RouterError("scheduled_session_busy", 409);
      return (await sessions(rule.owner, rule.agentId)).submit(input);
    },
    lookup: async (rule, id) => (await sessions(rule.owner, rule.agentId)).lookup(id),
    deliver: async (rule, input) => delivery((await sessions(rule.owner, rule.agentId)).deliver(input))!,
    delivery: async (rule, id) => delivery((await sessions(rule.owner, rule.agentId)).lookupDelivery(id)),
    cancel: async (rule, id) => { await (await sessions(rule.owner, rule.agentId)).cancel(id); },
  };
  const proactive = new ProactiveWork(proactiveStore, proactivePort);
  const reviews = new MemoryReviewCoordinator(businessStore, {
    config: options.nativeWork.backgroundReview,
    ...(dependencies.reviewer ? { reviewer: dependencies.reviewer } : {}),
    sourceSessions: scope => sessions(scope.owner, scope.agentId),
  });
  const completedTurns = new CompletedTurns(businessStore, history, reviews, sessions, options.nativeWork.employeeTools);
  const reviewOrigin = (admission: import("./run-admission.js").RunAdmission) => reviews.list({ owner: admission.owner, agentId: admission.agentId }).find(job => job.id === admission.reference);
  business.setAdmissionValidator(admission => {
    const review = reviewOrigin(admission);
    return review ? admission.kind === "delegation" && ["submitting", "running"].includes(review.status) && !review.cancellationRequested
      : proactive.allows(admission);
  });
  business.setEmployeeTools((agentId, owner) => new NativeEmployeeTools(owner, agentId, () => sessions(owner, agentId),
    facts, connectedApps, proactive, options.nativeWork.employeeTools, { history,
      reminders: (admission, hostSessionId) => {
        const sessionId = completedTurns.publicSession(admission.owner, admission.agentId, hostSessionId);
        return sessionId ? reviews.nudges({ owner: admission.owner, agentId: admission.agentId, sessionId }).prompt : "";
      },
      isMemoryReview: admission => Boolean(reviewOrigin(admission)),
    }));
  business.onCompleted(turn => {
    if (!reviewOrigin(turn.admission)) completedTurns.enqueue(turn);
  });
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustedProxies ?? false);
  app.get("/oauth/callback", rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false }), async (req, res) => {
    if (!connectorRuntime) throw new RouterError("connector_service_not_configured", 503);
    await connectorRuntime.callback(req, res);
  });
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
  product.get("/proactive", (_req, res) => res.json({ data: proactive.list(res.locals.owner) }));
  product.post("/proactive", async (req, res) => res.status(201).json(await proactive.save(res.locals.owner, req.body)));
  product.put("/proactive/:id", async (req, res) => {
    const { expectedVersion, rule } = z.object({ expectedVersion: z.number().int().positive(), rule: z.unknown() }).strict().parse(req.body);
    res.json(await proactive.save(res.locals.owner, rule, String(req.params.id), expectedVersion));
  });
  product.get("/proactive/:id", (req, res) => res.json(proactive.rule(res.locals.owner, String(req.params.id))));
  product.get("/proactive/:id/runs", (req, res) => res.json({ data: proactive.runs(res.locals.owner, String(req.params.id)), notifications: proactive.notices(res.locals.owner, String(req.params.id)) }));
  product.post("/proactive/:id/state", async (req, res) => {
    const { status } = z.object({ status: z.enum(["active", "paused"]) }).strict().parse(req.body);
    res.json(await proactive.state(res.locals.owner, String(req.params.id), status));
  });
  product.post("/proactive/:id/run", async (req, res) => {
    const { requestId } = z.object({ requestId: z.string().min(1).max(160) }).strict().parse(req.body);
    res.status(202).json(await proactive.runNow(res.locals.owner, String(req.params.id), requestId));
  });
  product.post("/proactive/:id/cancel", async (req, res) => { z.object({}).strict().parse(req.body); await proactive.cancel(res.locals.owner, String(req.params.id)); res.json({ status: "requested" }); });
  product.get("/agents/:id/memory", (req, res) => res.json(facts.read(res.locals.owner, String(req.params.id))));
  product.post("/agents/:id/memory", (req, res) => res.json(facts.mutate(res.locals.owner, String(req.params.id), req.body, { origin: "owner" })));
  product.post("/agents/:id/memory/search", (req, res) => res.json(history.search(res.locals.owner, String(req.params.id), historyQuery.parse(req.body))));
  product.post("/agents/:id/memory/history/import", async (req, res) => {
    const input = z.object({ sessionId: z.string().min(1).max(160), cursor: z.string().max(10000).optional() }).strict().parse(req.body);
    const page = await (await sessions(res.locals.owner, String(req.params.id))).history(input.sessionId, { limit: 100, itemsView: "full", sortDirection: "asc", ...(input.cursor ? { cursor: input.cursor } : {}) });
    res.json(history.importPage(res.locals.owner, String(req.params.id), input.sessionId, page));
  });
  product.get("/agents/:id/memory/pending", (req, res) => res.json({ data: facts.pending(res.locals.owner, String(req.params.id)) }));
  product.get("/agents/:id/memory/reviews", (req, res) => {
    const scope = { owner: res.locals.owner as string, agentId: String(req.params.id) }; assertOwned(scope.owner, scope.agentId);
    res.json({ ...reviews.status(scope), data: reviews.list(scope) });
  });
  product.post("/agents/:id/memory/reviews/state", (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    const scope = { owner: res.locals.owner as string, agentId: String(req.params.id) }; assertOwned(scope.owner, scope.agentId);
    if (enabled) reviews.resume(scope); else reviews.stop(scope); res.json(reviews.status(scope));
  });
  product.post("/agents/:id/memory/pending/:pendingId/approve", (req, res) => {
    z.object({}).strict().parse(req.body); res.json(facts.approve(res.locals.owner, String(req.params.id), String(req.params.pendingId)));
  });
  product.post("/agents/:id/memory/pending/:pendingId/discard", (req, res) => {
    z.object({}).strict().parse(req.body); res.json(facts.discard(res.locals.owner, String(req.params.id), String(req.params.pendingId)));
  });
  product.post("/agents/:id/native/discover", async (req, res) => { z.object({}).strict().parse(req.body); res.json(await (await sessions(res.locals.owner, String(req.params.id))).discover()); });
  product.get("/agents/:id/native/skills", async (req, res) => res.json(await (await sessions(res.locals.owner, String(req.params.id))).skills()));
  product.post("/agents/:id/native/skills", async (req, res) => {
    const { path, enabled } = z.object({ path: z.string().min(1).max(4096), enabled: z.boolean() }).strict().parse(req.body);
    res.json(await (await sessions(res.locals.owner, String(req.params.id))).configureSkill(path, enabled));
  });
  product.get("/agents/:id/native/memory", async (req, res) => res.json(await (await sessions(res.locals.owner, String(req.params.id))).memoryStatus()));
  product.get("/agents/:id/work-sessions/:sessionId/memory", async (req, res) => res.json(await (await sessions(res.locals.owner, String(req.params.id))).readMemory(String(req.params.sessionId))));
  product.post("/agents/:id/work-sessions/:sessionId/memory", async (req, res) => {
    const { mode } = z.object({ mode: z.enum(["enabled", "disabled"]) }).strict().parse(req.body);
    res.json(await (await sessions(res.locals.owner, String(req.params.id))).memoryMode(String(req.params.sessionId), mode));
  });
  product.get("/connector-accounts", async (_req, res) => {
    const result = await connectorAccounts.list(res.locals.owner);
    res.json({ ...result, data: result.data.map(account => {
      const assignedAgents = connectedApps.assigned(res.locals.owner, account.id)
        .filter(id => router.service.agents(res.locals.owner).some(agent => agent.id === id));
      return { ...account, ...(assignedAgents.length ? { assignedAgents, permission: "read-only" } : {}) };
    }) });
  });
  product.post("/connector-accounts/:id/:action", async (req, res) => {
    z.object({}).strict().parse(req.body);
    const action = z.enum(["check", "connect", "disconnect"]).parse(req.params.action);
    const result = await connectorAccounts.action(res.locals.owner, String(req.params.id), action);
    if (result.authorizationUrl) connectorRuntime?.bind(result.authorizationUrl, res);
    res.json(result);
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
        : parser === 413 ? "request_too_large" : parser ? "invalid_request" : "operation_failed",
        ...(error instanceof RouterError && error.nativeError !== undefined ? { nativeError: error.nativeError } : {}),
        ...(error instanceof MemoryError ? { details: error.details } : {}) });
  });
  const sshServers = new Set<() => void>();
  return { app, router, environments, proactive, facts, reviews, start: async () => { await connectorRuntime?.start(); await router.start(); proactive.start(); reviews.start(); completedTurns.start(); },
    attach: (server: Server) => { sshServers.add(attachSsh(server, token => router.service.authenticate(token),
      (owner, agentId, keyId) => environments.connectSsh(owner, agentId, keyId))); },
    close: async () => { for (const close of sshServers) close(); await proactive.close(); await completedTurns.close(); await reviews.close(); await environments.close(); await router.close(); await connectorRuntime?.close(); proactiveStore.close(); businessStore.close(); } };
}
