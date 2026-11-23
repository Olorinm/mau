import express from "express";
import { rateLimit } from "express-rate-limit";
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { z } from "zod";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { attachSsh, sshKeyId } from "./ssh.js";
import { webConsole } from "./web.js";
import { createRouter, HttpAgentHost, RouterError, type ServiceConfig, type ServiceDependencies } from "@agent-router/server";
import { EnvironmentManager, environmentOptionsSchema, type Environments } from "./environments.js";
import { AccessTokens } from "./access-tokens.js";
import { apiInput, apiReference, apiRoot, requestScope } from "./api-reference.js";
import { BusinessTools, feishuBotReadersSchema } from "./business-tools.js";
import { DurableStore } from "./store.js";
import { ConnectorAccounts, connectInputSchema, connectorAccountsSchema, policySettingsSchema, siteAccessInputSchema } from "./connector-accounts.js";
import { listApps, type AppDirectory } from "./apps.js";
import { ConnectorRuntime } from "./connector-runtime.js";
import { ConnectedApps, connectedAppsSchema, connectorAssignmentInput } from "./connected-apps.js";
import { AgentSkills } from "./agent-skills.js";
import { PartnerContext, MemoryError } from "./partner-context.js";
import { ProactiveWork, confirmationCard, confirmationEvent, type ProactivePort } from "./proactive.js";
import { NativePartnerTools } from "./native-work.js";
import { Partners, environmentPresence } from "./partners.js";
import { ExternalPartners } from "./external-partners.js";
import { closeRunApprovals } from "./connector-approvals.js";
import { SessionHistory, historyQuery } from "./session-history.js";
import { checkConnector } from "./connector-precheck.js";
import { MemoryReviewCoordinator, type RestrictedMemoryReviewer } from "./memory-review.js";
import { CompletedTurns } from "./completed-turns.js";
import { NativeRelay } from "./native-relay.js";
import { ModelSettings } from "./model-settings.js";
import { OwnerPrivateConnections, ownerPrivateAdmission } from "./owner-private.js";
import { chatChannelApplication } from "./feishu-entry.js";

export type { AppDirectory, AppSummary } from "./apps.js";
export { CodexRestrictedMemoryReviewer, codexReviewProfile, reviewProfileDigest } from "./restricted-memory-reviewer.js";
export type { ReviewRuntimeBinding, ReviewToolBinding, CodexRestrictedReviewerDependencies } from "./restricted-memory-reviewer.js";
export type { RestrictedMemoryReviewer } from "./memory-review.js";

const optionsSchema = z.object({
  environments: environmentOptionsSchema,
  feishuBotReaders: feishuBotReadersSchema,
  connectorAccounts: connectorAccountsSchema,
  connectedApps: connectedAppsSchema,
  nativeWork: z.object({ partnerTools: z.boolean().default(false),
    memory: z.object({ writeApproval: z.boolean().default(false) }).strict().default({ writeApproval: false }),
    backgroundReview: z.object({ enabled: z.boolean().default(true), memoryInterval: z.number().int().min(0).max(1000000).default(10),
      skillInterval: z.number().int().min(0).max(1000000).default(15) }).strict().prefault({}),
  }).strict().prefault({}),
  connectionsFile: z.string().min(1).optional(),
  /** Router's edge identity (agent-router ADR 0005 18.2), validated by Router. Same shape as AGENT_EDGE_IDENTITY_FILE's `edgeIdentity`.
   * Required here or in the Router service config: it is the only owner login. */
  edgeIdentity: z.record(z.string(), z.unknown()).optional(),
}).strict();
/** The authenticated owner, as returned by Router's `authenticateRequest` (agent-router ADR 0005 18.2). */
interface OwnerPrincipal { ownerId: string; personId?: string; via?: string; email?: string; expiresAt?: number; operator?: true; granted?: true }
type EdgeIdentityConfig = NonNullable<ServiceConfig["edgeIdentity"]>;
interface OwnerRequest { headers: IncomingMessage["headers"]; method?: string | undefined; url?: string | undefined; originalUrl?: string | undefined }

/** One product process composes independent components; it shares Router accounts, never duplicates them. */
/** Product records keyed or tagged by a deleted partner: its own documents (connector assignment), business scopes
 * (`agentId:operation`), JSON keys starting with [owner, agentId], and values naming the Agent. Hashed index rows are unreachable once the ID is gone. */
function forgetPartnerRecords(store: DurableStore, owner: string, agentId: string) {
  const prefix = JSON.stringify([owner, agentId]).slice(0, -1);
  store.db.prepare(`DELETE FROM documents WHERE id=? OR substr(id,1,length(?)+1)=?||':' OR substr(id,1,length(?))=?
    OR json_extract(value,'$.agentId')=? OR json_extract(value,'$.admission.agentId')=?`)
    .run(agentId, agentId, agentId, prefix, prefix, agentId, agentId);
}

/** One start-failure line for operators: the error's name, message and first stack frame, never its properties. */
export function startFailure(error: unknown) {
  if (!(error instanceof Error)) return `mau_start_failed: ${String(error)}`;
  const frame = error.stack?.split("\n").map(line => line.trim()).find(line => line.startsWith("at "));
  return `mau_start_failed: ${error.message} (${error.name}${frame ? ", " + frame : ""})`;
}
export function createMau(config: ServiceConfig, optionsFile: string, dependencies: {
  router?: Omit<ServiceDependencies, "configure" | "authorizeOperator">;
  environments?: () => Promise<Environments>;
  reviewer?: RestrictedMemoryReviewer;
  /** The owner's apps, from the deployment's app service. Without it the console is told there is none. */
  apps?: AppDirectory;
} = {}, serving: { webRoot?: string } = {}) {
  const base = dirname(resolve(optionsFile));
  const options = optionsSchema.parse(JSON.parse(readFileSync(optionsFile, "utf8")));
  let environments: EnvironmentManager;
  const businessStore = new DurableStore(join(config.stateDir, "business-tools.sqlite"), config.serverName);
  // Owner writes need an approval presenter: only Mau's authority key (connectorAccounts) can sign grants.
  const connectedApps = new ConnectedApps(options.connectedApps, base, businessStore, !!options.connectorAccounts,
    { sharedFrom: agentId => environments.sharedFrom(agentId), sharedBy: agentId => environments.sharedBy(agentId) });
  const business = new BusinessTools(options.feishuBotReaders, base, businessStore, connectedApps);
  const connectorAccounts = new ConnectorAccounts(options.connectorAccounts, base);
  if (connectorAccounts.configured) { business.setApprovals(connectorAccounts); business.setSites(connectorAccounts); }
  const connectorRuntime = options.connectorAccounts?.runtimeConfigFile ? new ConnectorRuntime(
    resolve(base, options.connectorAccounts.runtimeConfigFile), options.connectorAccounts.url, new URL(config.publicUrl).origin, businessStore) : undefined;
  const edgeIdentity = options.edgeIdentity as EdgeIdentityConfig | undefined ?? config.edgeIdentity;
  if (options.edgeIdentity && config.edgeIdentity) throw new Error("edge_identity_configured_twice");
  // Owners sign in through the edge identity. Only a process that supplies its own owner login starts without one:
  // local mode (`src/local-login.ts`). The console's chat source is Router's ledger, which Router always serves.
  if (!edgeIdentity && !dependencies.router?.authenticate) throw new Error("edge_identity_required");
  const tokens = new AccessTokens(businessStore);
  const routerConfig: ServiceConfig = { ...config, stateDir: join(config.stateDir, "router"), ...(edgeIdentity ? { edgeIdentity } : {}) };
  const router = createRouter(routerConfig, {
    dependencies: {
      ...dependencies.router,
      // A service token without owner access does more than its default only with an access token of its owner
      // (`Mau-Token`) whose scopes cover the request. Router asks before its CSRF guard, which still applies.
      authorizeOperator: (principal, request) => tokens.authorize(principal, request),
      // Deleting a partner: stop its schedules and destroy its environments while Router still has the Agent,
      // then remove Mau's per-partner state after Router has deactivated it. A partner in a shared environment
      // leaves that environment untouched.
      beforeDelete: async agent => {
        proactive.suspendAgent(agent.id);
        await environments.removeAgent(agent.owner, agent.id);
        await dependencies.router?.beforeDelete?.(agent);
      },
      afterDelete: async agent => {
        environments.forgetAgent(agent.id);
        facts.forget(agent.owner, agent.id);
        partners.forget(agent.owner, agent.id);
        history.forget(agent.owner, agent.id);
        proactive.forgetAgent(agent.id);
        forgetPartnerRecords(businessStore, agent.owner, agent.id);
        modelSettings.forget(agent.id);
        await dependencies.router?.afterDelete?.(agent);
      },
    },
    connections: options.connectionsFile ? resolve(base, options.connectionsFile) : {},
    hosts: {
      assertReady: (id, binding) => environments.assertReady(id, binding),
      wake: (id, binding) => environments.wake(id, binding),
      host: (id, binding) => business.host(id, router.service.agent(id).owner, binding, environments.http(id, binding)),
      http: (id, binding) => environments.http(id, binding),
    },
  });
  const hostOf = (owner: string, agentId: string) => router.connections.configuration(router.service.owned(agentId, owner))?.host;
  const externals = new ExternalPartners(businessStore, router.hostLinks, {
    serviceUrl: new URL(config.publicUrl).origin,
    binding: hostOf,
    bind: async (owner, agentId, host) => {
      // A computer's sessions are its own: pairing one, or ending a pairing, starts the partner's execution sessions afresh.
      if (host) await router.connections.replaceHost(owner, agentId, { ...host, instanceName: "channel-host", instructions: "" });
      else await router.connections.edit(owner, agentId, config => { delete config.host; }, undefined, true);
    },
  });
  /** Every owner route and the SSH upgrade: the Access JWT when the request carries one, otherwise the bearer token. */
  // The method lets Router apply its CSRF guard (Origin, content type) to unsafe edge requests. Method, path and
  // headers let it hold a service token to an operator's requests: here that is reading, without the SSH upgrade.
  const authenticateRequest = (req: OwnerRequest): Promise<OwnerPrincipal> => {
    const request: OwnerRequest = { headers: req.headers, method: req.method, originalUrl: req.originalUrl ?? req.url };
    return router.service.authenticateRequest(request);
  };
  environments = new EnvironmentManager(router.connections, router.service, options.environments,
    base, join(config.stateDir, "mau"), dependencies.environments);
  // Refused before anything of the partner is stopped or paused: other partners still run in its environment.
  router.service.guardDelete(agentId => environments.assertUnshared(agentId));
  business.setSandboxFiles((agentId, binding) => environments.files(agentId, binding));
  // Rule: owner-identity connections (Feishu personal authorization) only in the owner's private conversation.
  const ownerPrivate = new OwnerPrivateConnections([...connectedApps.ownerPrivateConnections,
    ...(connectorRuntime?.connections().filter(c => c.kind === "feishu").map(c => c.id) ?? [])],
    connectorAccounts.configured ? () => connectorAccounts.usage() : undefined);
  business.setOwnerPrivate({ connections: () => ownerPrivate.ids(),
    admitted: async admission => ownerPrivateAdmission(admission, await router.service.runtime(admission.agentId).then(r => r.extension, () => undefined)) });
  const skills = new AgentSkills(connectedApps, connectorRuntime ? owner => connectorRuntime.connections(owner) : undefined,
    undefined, connectorAccounts.configured ? async owner => (await connectorAccounts.list(owner)).data : undefined);
  business.setSkills(async (agentId, owner, binding) => {
    const installation = environments.skillInstallation(agentId, binding);
    if (!installation || (!options.connectedApps && !installation.bundled)) return;
    return skills.install(environments.kernel(agentId), environments.sharedFrom(agentId) ?? agentId, owner, binding,
      () => environments.files(agentId, binding), installation.revision);
  });
  business.setGuides(agentId => skills.toolGuides(environments.kernel(agentId)));
  const sessions = async (owner: string, agentId: string) => {
    router.service.owned(agentId, owner);
    const value = (await router.service.runtime(agentId)).extension?.sessions;
    if (!value) throw new RouterError("host_sessions_unavailable", 409);
    return value;
  };
  if (connectedApps.employeePermissions) business.setEmployeeDesk((agentId, owner, scheduled) => {
    const lead = environments.sharedFrom(agentId);
    if (!lead && !scheduled) return undefined;
    const destination = lead ?? agentId;
    const work = () => sessions(owner, destination);
    return {
      open: async card => {
        const employee = router.service.owned(agentId, owner);
        (await work()).request({ eventId: card.id, kind: "approval", title: `伙伴「${employee.name}」请求批准`,
          text: [card.summary, ...(card.connection ? [`连接：${card.connection}`, JSON.stringify(card.arguments)] : [])].join("\n"),
          choices: card.choices ?? [{ id: "allow", label: "批准这次操作" }, { id: "deny", label: "拒绝这次操作", style: "danger" }],
          expiresAt: card.deadlineAt });
      },
      choice: async id => {
        const result = (await work()).lookupRequest(id);
        return result?.status === "pending" ? undefined : result?.choice ?? "deny";
      },
      status: async id => {
        const result = (await work()).lookupRequest(id);
        if (!result || result.status === "expired") return "expired";
        if (result.status === "pending") return "pending";
        return result.status === "answered" && result.choice === "allow" ? "approved" : "denied";
      },
      withdraw: async id => { (await work()).withdrawRequest(id); },
    };
  });
  const assertOwned = (owner: string, agentId: string) => { router.service.owned(agentId, owner); };
  const modelSettings = new ModelSettings(businessStore, sessions);
  /** What a kernel of the environment an Agent runs in offers, whether or not a partner runs on it yet. */
  const kernelModels = (agentId: string, kernel: string) =>
    modelSettings.kernelView(environments.sharedFrom(agentId) ?? agentId, kernel, () => environments.discover(agentId, kernel));
  const facts = new PartnerContext(businessStore, assertOwned, { directory: join(config.stateDir, "mau", "memories"), writeApproval: options.nativeWork.memory.writeApproval });
  const history = new SessionHistory(businessStore, assertOwned);
  const proactiveStore = new DurableStore(join(config.stateDir, "proactive.sqlite"), config.serverName);
  const delivery = (value: { state: string; externalId?: string | null | undefined; error?: string | null | undefined } | null) => value ? {
    status: value.state === "accepted" ? "sent" : value.state,
    ...(value.externalId ? { externalId: value.externalId } : {}),
    ...(value.error ? { error: value.error } : {}),
  } : null;
  const proactivePort: ProactivePort = {
    validate: async rule => {
      if (externals.has(rule.agentId)) throw new RouterError("not_available_for_external_partner", 409);
      const work = await sessions(rule.owner, rule.agentId);
      work.validateTarget(rule.targetSessionId);
      if (rule.session.type === "conversation") work.validateTarget(rule.session.sessionId);
      if (!work.deliveryConnections().includes(rule.notify.channel)) throw new RouterError("proactive_notify_channel_not_found", 400);
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
    // The card is a request in the owner's conversation with the Agent: it belongs to no run and only the owner answers it.
    confirmations: {
      ask: async proposal => { (await sessions(proposal.owner, proposal.agentId)).request({ eventId: confirmationEvent(proposal), kind: "approval",
        ...confirmationCard(proposal), expiresAt: proposal.expiresAt }); },
      answer: async proposal => {
        const request = (await sessions(proposal.owner, proposal.agentId)).lookupRequest(confirmationEvent(proposal));
        if (!request || request.status === "expired" || request.status === "withdrawn") return "expired";
        return request.status === "pending" ? "pending" : request.choice === "confirm" ? "confirmed" : "rejected";
      },
      withdraw: async proposal => { (await sessions(proposal.owner, proposal.agentId)).withdrawRequest(confirmationEvent(proposal)); },
    },
  };
  const proactive = new ProactiveWork(proactiveStore, proactivePort);
  const reviews = new MemoryReviewCoordinator(businessStore, {
    config: options.nativeWork.backgroundReview,
    ...(dependencies.reviewer ? { reviewer: dependencies.reviewer } : {}),
    sourceSessions: scope => sessions(scope.owner, scope.agentId),
  });
  const completedTurns = new CompletedTurns(businessStore, history, reviews, sessions, options.nativeWork.partnerTools);
  const nativeRelay = new NativeRelay(businessStore, {
    partners: () => options.nativeWork.partnerTools ? environments.readyBindings().filter(b => b.kernel === "codex").flatMap(b => {
      try { return [{ agentId: b.agentId, owner: router.service.agent(b.agentId).owner, operationId: b.operationId, runtimeId: b.runtimeId }]; }
      catch { return []; }
    }) : [],
    host: partner => new HttpAgentHost(environments.http(partner.agentId, partner.operationId, false, { activity: false })),
    sessions,
    publicSession: (owner, agentId, hostSessionId) => completedTurns.publicSession(owner, agentId, hostSessionId),
    touch: agentId => environments.touch(agentId),
    record: (owner, agentId, sessionId, source, text) => history.append(owner, agentId, sessionId, source, text),
  });
  const reviewOrigin = (admission: import("./run-admission.js").RunAdmission) => reviews.list({ owner: admission.owner, agentId: admission.agentId }).find(job => job.id === admission.reference);
  const routerOf = (agentId: string) => router.service.runtime(agentId).then(r => r.extension, () => undefined);
  /** A partner's duty and kernel: recorded with its environment, or with it and its computer. */
  const duty = (agentId: string) => {
    const description = router.service.agent(agentId).description;
    return description === undefined ? externals.duty(agentId) ?? environments.duty(agentId) : description ?? undefined;
  };
  const kernel = (agentId: string) => externals.kernel(agentId) ?? environments.kernel(agentId);
  const partners = new Partners(businessStore, {
    employeePermissions: connectedApps.employeePermissions,
    agents: owner => router.service.agents(owner),
    create: (owner, name) => router.service.create(owner, name),
    sessions,
    conversations: async agentId => (await routerOf(agentId))?.communication,
    turnEnded: async (agentId, taskId) => {
      const runtime = await router.service.runtime(agentId), input = runtime.extension?.communication?.input(taskId);
      // A turn that answers in a conversation has ended when its answer is recorded there.
      return input ? input.state === "done" : ["completed", "failed", "canceled", "rejected"].includes(runtime.work.inspect(taskId).status);
    },
    duty: agentId => duty(agentId),
    environmentHolder: agentId => environments.sharedFrom(agentId) ?? agentId,
    kernel: agentId => kernel(agentId),
    kernels: agentId => environments.kernels(agentId),
    presence: (owner, agentId) => externals.presence(agentId) ?? environmentPresence(environments.summary(owner, agentId)?.state),
    dismissed: (owner, agentId) => externals.unpair(owner, agentId),
    assertShareable: (owner, holder, kernel) => environments.assertShareable(owner, holder, kernel),
    share: (owner, agentId, holder, duty, kernel) => environments.beginShared(owner, agentId, holder, duty, kernel),
    models: (owner, agentId) => modelSettings.view(owner, agentId),
    kernelModels: (owner, agentId, kernel) => { assertOwned(owner, agentId); return kernelModels(agentId, kernel); },
    // A partner whose own runtime was not read yet uses what was read of its kernel in its environment.
    defaultModel: agentId => {
      const holder = environments.sharedFrom(agentId) ?? agentId, kernel = environments.kernel(agentId);
      return modelSettings.defaultModel(agentId) ?? (kernel !== undefined && kernel !== environments.kernel(holder)
        ? modelSettings.kernelDefaultModel(holder, kernel) : modelSettings.defaultModel(holder));
    },
    connections: (owner, agentId) => connectedApps.connections(agentId, owner),
    answerCard: async (owner, agentId, cardId, answer) => {
      router.service.owned(agentId, owner);
      const control = (await router.service.runtime(agentId)).extension?.control;
      if (!control) throw new RouterError("host_sessions_unavailable", 409);
      return control.answer(cardId, answer);
    },
    closeApprovals: async (agentId, runId, withdraw) => { if (connectorAccounts.configured) await closeRunApprovals(businessStore, connectorAccounts, agentId, runId, withdraw); },
  });
  business.setAdmissionValidator(admission => {
    const partner = partners.allows(admission);
    if (partner !== undefined) return partner;
    const review = reviewOrigin(admission);
    return review ? admission.kind === "delegation" && ["submitting", "running"].includes(review.status) && !review.cancellationRequested
      : proactive.allows(admission);
  });
  business.setPartnerTools((agentId, owner) => new NativePartnerTools(owner, agentId, partners,
    facts, proactive, options.nativeWork.partnerTools, { history,
      reminders: (admission, hostSessionId) => {
        const sessionId = completedTurns.publicSession(admission.owner, admission.agentId, hostSessionId);
        return sessionId ? reviews.nudges({ owner: admission.owner, agentId: admission.agentId, sessionId }).prompt : "";
      },
      isMemoryReview: admission => Boolean(reviewOrigin(admission)),
    }));
  business.onCompleted(turn => {
    partners.turnCompleted(turn.admission);
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
  if (serving.webRoot) app.use(webConsole(serving.webRoot));
  const product = express.Router();
  product.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: "draft-8", legacyHeaders: false }));
  product.use(express.json({ limit: "16kb" }));
  product.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  product.get("/info", (_req, res) => res.json(edgeIdentity ? { login: "edge", logoutUrl: "/cdn-cgi/access/logout" } : { login: "local" }));
  product.use(async (req, res, next) => {
    const principal = await authenticateRequest(req);
    res.locals.principal = principal; res.locals.owner = principal.ownerId;
    next();
  });
  // A partner on the owner's computer has its own kernel, model, memory, skills and files, and nothing of Mau's:
  // of a partner's routes it has only itself, its dismissal and its computer.
  product.use("/agents/:id", (req, res, next) => {
    if (externals.isOwned(res.locals.owner, String(req.params.id)) && !/^\/(?:dismiss|restore|device(?:\/pair)?)?$/.test(req.path))
      throw new RouterError("not_available_for_external_partner", 409);
    next();
  });
  product.get("/account", (req, res) => {
    const principal = res.locals.principal as OwnerPrincipal, { ownerId, personId, via, email, expiresAt } = principal;
    // Shown only: what the access token sent with a service token's request would let it do.
    const token = tokens.describe(principal, req);
    res.json({ owner: ownerId, ...(personId ? { person: { id: personId, name: router.service.persons.person(personId)?.displayName ?? ownerId } } : {}),
      via: via ?? "bearer", ...(email ? { email } : {}), ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}), ...(token ? { token } : {}) });
  });
  // Access tokens are the owner's alone: a service token without owner access is refused here whatever it was
  // granted, so no token and no scope of a route can create or revoke one.
  const tokenOwner = (res: express.Response) => {
    if ((res.locals.principal as OwnerPrincipal).operator) throw new RouterError("owner_sign_in_required", 403);
    return res.locals.owner as string;
  };
  product.get("/tokens", (_req, res) => res.json({ data: tokens.list(tokenOwner(res)) }));
  product.post("/tokens", (req, res) => res.status(201).json(tokens.create(tokenOwner(res), req.body)));
  product.delete("/tokens/:id", (req, res) => { tokens.revoke(tokenOwner(res), String(req.params.id)); res.status(204).end(); });
  product.get("/reference", (_req, res) => res.json(apiReference()));
  product.get("/proactive", (_req, res) => res.json({ data: proactive.list(res.locals.owner) }));
  product.post("/proactive", async (req, res) => res.status(201).json(await proactive.save(res.locals.owner, req.body)));
  product.put("/proactive/:id", async (req, res) => {
    const { expectedVersion, rule } = apiInput.ruleUpdate.parse(req.body);
    res.json(await proactive.save(res.locals.owner, rule, String(req.params.id), expectedVersion));
  });
  product.get("/proactive/:id", (req, res) => res.json(proactive.rule(res.locals.owner, String(req.params.id))));
  product.get("/proactive/:id/runs", (req, res) => res.json({ data: proactive.runs(res.locals.owner, String(req.params.id)), notifications: proactive.notices(res.locals.owner, String(req.params.id)) }));
  product.post("/proactive/:id/state", async (req, res) => {
    const { status } = apiInput.ruleState.parse(req.body);
    res.json(await proactive.state(res.locals.owner, String(req.params.id), status));
  });
  product.post("/proactive/:id/run", async (req, res) => {
    const { requestId } = apiInput.ruleRun.parse(req.body);
    res.status(202).json(await proactive.runNow(res.locals.owner, String(req.params.id), requestId));
  });
  product.post("/proactive/:id/cancel", async (req, res) => { apiInput.empty.parse(req.body); await proactive.cancel(res.locals.owner, String(req.params.id)); res.json({ status: "requested" }); });
  product.get("/agents/:id/memory", (req, res) => res.json(facts.read(res.locals.owner, String(req.params.id))));
  product.post("/agents/:id/memory", (req, res) => res.json(facts.mutate(res.locals.owner, String(req.params.id), req.body, { origin: "owner" })));
  product.get("/agents/:id/memory/mutations", (req, res) => res.json({ data: facts.mutations(res.locals.owner, String(req.params.id)) }));
  product.post("/agents/:id/memory/mutations/seen", (req, res) => {
    const { through } = apiInput.memorySeen.parse(req.body);
    res.json(facts.markSeen(res.locals.owner, String(req.params.id), through));
  });
  product.post("/agents/:id/memory/mutations/:mutationId/undo", (req, res) => {
    apiInput.empty.parse(req.body); res.json(facts.undo(res.locals.owner, String(req.params.id), String(req.params.mutationId)));
  });
  product.post("/agents/:id/memory/search", (req, res) => res.json(history.search(res.locals.owner, String(req.params.id), historyQuery.parse(req.body))));
  product.post("/agents/:id/memory/history/import", async (req, res) => {
    const input = apiInput.historyImport.parse(req.body);
    const page = await (await sessions(res.locals.owner, String(req.params.id))).history(input.sessionId, { limit: 100, itemsView: "full", sortDirection: "asc", ...(input.cursor ? { cursor: input.cursor } : {}) });
    res.json(history.importPage(res.locals.owner, String(req.params.id), input.sessionId, page));
  });
  product.get("/agents/:id/memory/pending", (req, res) => res.json({ data: facts.pending(res.locals.owner, String(req.params.id)) }));
  product.get("/agents/:id/memory/reviews", (req, res) => {
    const scope = { owner: res.locals.owner as string, agentId: String(req.params.id) }; assertOwned(scope.owner, scope.agentId);
    res.json({ ...reviews.status(scope), data: reviews.list(scope) });
  });
  product.post("/agents/:id/memory/reviews/state", (req, res) => {
    const { enabled } = apiInput.reviewState.parse(req.body);
    const scope = { owner: res.locals.owner as string, agentId: String(req.params.id) }; assertOwned(scope.owner, scope.agentId);
    if (enabled) reviews.resume(scope); else reviews.stop(scope); res.json(reviews.status(scope));
  });
  product.post("/agents/:id/memory/pending/:pendingId/approve", (req, res) => {
    apiInput.empty.parse(req.body); res.json(facts.approve(res.locals.owner, String(req.params.id), String(req.params.pendingId)));
  });
  product.post("/agents/:id/memory/pending/:pendingId/discard", (req, res) => {
    apiInput.empty.parse(req.body); res.json(facts.discard(res.locals.owner, String(req.params.id), String(req.params.pendingId)));
  });
  product.post("/agents/:id/native/discover", async (req, res) => { apiInput.empty.parse(req.body); res.json(await (await sessions(res.locals.owner, String(req.params.id))).discover()); });
  product.get("/agents/:id/native/skills", async (req, res) => res.json(await (await sessions(res.locals.owner, String(req.params.id))).skills()));
  product.post("/agents/:id/native/skills", async (req, res) => {
    const { path, enabled } = apiInput.skillState.parse(req.body);
    res.json(await (await sessions(res.locals.owner, String(req.params.id))).configureSkill(path, enabled));
  });
  product.get("/agents/:id/native/memory", async (req, res) => res.json(await (await sessions(res.locals.owner, String(req.params.id))).memoryStatus()));
  product.get("/agents/:id/work-sessions/:sessionId/memory", async (req, res) => res.json(await (await sessions(res.locals.owner, String(req.params.id))).readMemory(String(req.params.sessionId))));
  product.post("/agents/:id/work-sessions/:sessionId/memory", async (req, res) => {
    const { mode } = apiInput.sessionMemoryMode.parse(req.body);
    res.json(await (await sessions(res.locals.owner, String(req.params.id))).memoryMode(String(req.params.sessionId), mode));
  });
  product.get("/apps", async (_req, res) => res.json(await listApps(dependencies.apps, res.locals.owner)));
  product.get("/connector-accounts", async (_req, res) => {
    const result = await connectorAccounts.list(res.locals.owner);
    res.json({ ...result, data: result.data.map(account => {
      const assignedAgents = connectedApps.assigned(res.locals.owner, account.id)
        .filter(id => router.service.agents(res.locals.owner).some(agent => agent.id === id));
      return { ...account, ...(assignedAgents.length ? { assignedAgents } : {}) };
    }) });
  });
  // Unified 飞书 entry, step 2: hand the app of the Agent's Feishu chat channel to the owner's Feishu connection.
  product.post("/connector-accounts/:id/feishu-application", async (req, res) => {
    const { agentId } = apiInput.feishuApplication.parse(req.body);
    const owner = res.locals.owner as string, agent = router.service.owned(agentId, owner), id = String(req.params.id);
    if (!connectedApps.assigned(owner, id).includes(agentId)) throw new RouterError("connector_not_assigned_to_agent", 409);
    // A partner using another partner's connections does not change the application behind them.
    const sharedFrom = environments.sharedFrom(agentId);
    if (sharedFrom && !connectedApps.configured(owner, id).includes(agentId)) {
      const partner = router.service.agent(sharedFrom);
      throw new RouterError("connector_assigned_through_partner", 409).with({ partner: { id: partner.id, name: partner.name } });
    }
    const application = chatChannelApplication(router.connections.configuration(agent)?.connections, router.connections.agentDirectory(agentId));
    res.json(await connectorAccounts.provideApplication(owner, id, application));
  });
  // Owner settings per operation (allow, ask, deny); the connector service enforces them on every call.
  product.get("/connector-accounts/:id/policy", async (req, res) => res.json(await connectorAccounts.policy(res.locals.owner, String(req.params.id))));
  product.put("/connector-accounts/:id/policy", async (req, res) =>
    res.json(await connectorAccounts.setPolicy(res.locals.owner, String(req.params.id), policySettingsSchema.parse(req.body))));
  product.post("/connector-accounts/:id/policy/reset", async (req, res) => {
    apiInput.empty.parse(req.body ?? {});
    res.json(await connectorAccounts.resetPolicy(res.locals.owner, String(req.params.id)));
  });
  // A browser connection's site permissions: open new sites directly or ask first, and the always-allowed sites.
  product.get("/connector-accounts/:id/access", async (req, res) => res.json(await connectorAccounts.siteAccess(res.locals.owner, String(req.params.id))));
  product.put("/connector-accounts/:id/access", async (req, res) =>
    res.json(await connectorAccounts.setSiteAccess(res.locals.owner, String(req.params.id), siteAccessInputSchema.parse(req.body))));
  product.post("/connector-accounts/:id/:action", async (req, res) => {
    const action = z.enum(["check", "connect", "complete", "disconnect"]).parse(req.params.action);
    // Connect may name operations whose missing scopes to add; every other action takes no input.
    const input = action === "connect" ? connectInputSchema.parse(req.body ?? {}) : (apiInput.empty.parse(req.body), {});
    const result = await connectorAccounts.action(res.locals.owner, String(req.params.id), action, input);
    if (result.authorizationUrl) connectorRuntime?.bind(result.authorizationUrl, res);
    res.json(result);
  });
  product.get("/options", (_req, res) => res.json({
    environments: environments.profiles(res.locals.owner).map(({ id, label, kernel, otherKernels }) =>
      ({ id, label, kernel, kernels: [kernel, ...otherKernels.map(other => other.kernel)] })),
  }));
  const summary = (owner: string, id: string) => ({
    ...router.connections.summary(router.service.owned(id, owner)),
    kind: externals.has(id) ? "external" as const : "managed" as const,
    duty: duty(id) ?? null,
    kernel: kernel(id) ?? null,
    environment: environments.summary(owner, id),
    ...(externals.has(id) ? externals.view(owner, id) : {}),
    dismissed: partners.dismissedAt(id) ?? null,
  });
  product.get("/agents", (_req, res) => res.json({ data: router.service.agents(res.locals.owner).map(a => summary(a.owner, a.id)) }));
  product.post("/agents", async (req, res) => {
    const input = apiInput.newAgent.parse(req.body), owner = res.locals.owner as string;
    if ("kind" in input) {
      const ownership = externals.creatable(input.ownership);
      const agent = await router.service.create(owner, input.name);
      externals.register(owner, agent.id, ownership, input.duty, !environments.summary(owner, agent.id) && !hostOf(owner, agent.id));
      // The partner has a conversation before it has a computer: what the owner writes meanwhile waits for the pairing.
      if (!router.connections.configuration(agent)) await router.connections.edit(owner, agent.id, () => undefined);
      res.status(201).json({ ...summary(owner, agent.id), pairing: externals.pair(owner, agent.id) }); return;
    }
    // Asked again for a name that exists, Router answers with that partner: one on the owner's computer gets no environment.
    if (router.service.agents(owner).some(agent => agent.name === input.name && externals.has(agent.id))) throw new RouterError("not_available_for_external_partner", 409);
    if ("shareWith" in input) {
      await environments.assertShareable(owner, input.shareWith, input.kernel);
      const agent = await router.service.create(owner, input.name);
      await environments.beginShared(owner, agent.id, input.shareWith, input.duty, input.kernel);
      res.status(202).json(summary(owner, agent.id)); return;
    }
    const profile = environments.profiles(owner).find(p => p.id === input.profileId);
    if (!profile) throw new RouterError("environment_profile_not_assigned", 403);
    const agent = await router.service.create(owner, input.name);
    await environments.begin(owner, agent.id, input.profileId, input.duty);
    res.status(202).json(summary(owner, agent.id));
  });
  product.get("/agents/:id", (req, res) => res.json(summary(res.locals.owner, String(req.params.id))));
  product.patch("/agents/:id", (req, res) => {
    const owner = res.locals.owner as string, id = String(req.params.id);
    const { name, duty } = apiInput.partnerEdit.parse(req.body);
    router.service.updateProfile(owner, id, { ...(name !== undefined ? { name } : {}), ...(duty !== undefined ? { description: duty } : {}) });
    res.json(summary(owner, id));
  });
  // Dismissing archives a partner: everything it has is kept, and it leaves the roster until it is restored.
  for (const action of ["dismiss", "restore"] as const) product.post(`/agents/:id/${action}`, async (req, res) => {
    apiInput.empty.parse(req.body);
    const owner = res.locals.owner as string, id = router.service.owned(String(req.params.id), owner).id;
    if (action === "dismiss") await partners.archive(owner, id, "owner"); else partners.restore(owner, id);
    res.json(summary(owner, id));
  });
  // The computer paired with a partner that is an agent on it.
  product.get("/devices", (_req, res) => {
    const owner = res.locals.owner as string, names = new Map(router.service.agents(owner).map(agent => [agent.id, agent.name]));
    res.json({ data: externals.list(owner).flatMap(({ agentId, ...view }) => names.has(agentId) ? [{ partner: { id: agentId, name: names.get(agentId)! }, ...view }] : []) });
  });
  product.get("/agents/:id/device", (req, res) => {
    const owner = res.locals.owner as string;
    res.json(externals.view(owner, router.service.owned(String(req.params.id), owner).id));
  });
  product.post("/agents/:id/device/pair", (req, res) => {
    apiInput.empty.parse(req.body);
    const owner = res.locals.owner as string;
    res.json(externals.pair(owner, router.service.owned(String(req.params.id), owner).id));
  });
  product.delete("/agents/:id/device", async (req, res) => {
    const owner = res.locals.owner as string, id = router.service.owned(String(req.params.id), owner).id;
    // Refused for a partner of another kind.
    externals.view(owner, id);
    await externals.unpair(owner, id);
    res.status(204).end();
  });
  product.get("/partners", async (_req, res) => res.json({ data: await partners.list(res.locals.owner) }));
  product.get("/partners/messages", (req, res) => {
    const filter = z.object({ agentId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).strict().parse(req.query);
    res.json({ data: partners.messages(res.locals.owner, filter) });
  });
  product.delete("/agents/:id", async (req, res) => {
    await router.service.delete(res.locals.owner, String(req.params.id));
    res.status(204).end();
  });
  product.post("/agents/:id/ssh", async (req, res) => {
    const { publicKey } = apiInput.sshKey.parse(req.body);
    sshKeyId(publicKey);
    res.json(await environments.prepareSsh(res.locals.owner, String(req.params.id), publicKey));
  });
  product.get("/agents/:id/instructions", (req, res) => res.json(environments.instructions(res.locals.owner, String(req.params.id))));
  product.get("/agents/:id/model-settings", async (req, res) => res.json(await modelSettings.view(res.locals.owner, String(req.params.id))));
  product.put("/agents/:id/model-settings", async (req, res) => res.json(await modelSettings.select(res.locals.owner, String(req.params.id), req.body)));
  // What a partner can use of the owner's connector connections. Every call of `connected_apps` reads it, so a change
  // needs no restart; the tool itself is added to a conversation at its first turn (`business_session_catalog`).
  const connectors = (owner: string, id: string) => {
    const inherited = connectedApps.inheritedFrom(id, owner);
    return { connections: connectedApps.connections(id, owner),
      ...(inherited ? { inheritedFrom: { id: inherited, name: router.service.agent(inherited).name } } : {}) };
  };
  product.get("/agents/:id/connectors", (req, res) => {
    const owner = res.locals.owner as string;
    res.json(connectors(owner, router.service.owned(String(req.params.id), owner).id));
  });
  product.put("/agents/:id/connectors", async (req, res) => {
    const { connections } = connectorAssignmentInput.parse(req.body), owner = res.locals.owner as string;
    const id = router.service.owned(String(req.params.id), owner).id, known = (await connectorAccounts.list(owner)).data.map(account => account.id);
    if (connections.some(connection => !known.includes(connection))) throw new RouterError("connector_not_found", 400);
    if (connections.length && connectedApps.sharedEmployee(id)) {
      const privateIds = await ownerPrivate.ids();
      if (!privateIds || connections.some(connection => privateIds.has(connection))) throw new RouterError("personal_connection_requires_environment_owner", 403);
    }
    connectedApps.assign(owner, id, connections);
    res.json(connectors(owner, id));
  });
  product.get("/agents/:id/environment", (req, res) => res.json(environments.summary(res.locals.owner, String(req.params.id)) ?? { state: "unconfigured", busy: false }));
  product.post("/agents/:id/environment", async (req, res) => {
    const { profileId } = apiInput.environment.parse(req.body);
    res.status(202).json(await environments.begin(res.locals.owner, String(req.params.id), profileId));
  });
  product.post("/agents/:id/environment/replace", async (req, res) => {
    const input = apiInput.environmentReplace.parse(req.body);
    res.status(202).json(await environments.replace(res.locals.owner, String(req.params.id), input.profileId, input.expectedOperationId));
  });
  product.post("/agents/:id/environment/rollback", async (req, res) => {
    const input = apiInput.environmentRollback.parse(req.body);
    res.status(202).json(await environments.rollbackReplacement(res.locals.owner, String(req.params.id), input.expectedOperationId));
  });
  product.post("/agents/:id/environment/:action", async (req, res) => {
    apiInput.empty.parse(req.body);
    const action = z.enum(["pause", "resume", "destroy", "reconcile"]).parse(req.params.action);
    res.status(202).json(await environments.action(res.locals.owner, String(req.params.id), action));
  });
  product.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(apiRoot, product);
  app.use(router.app);
  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // What a refused service token would need: the scope of the route, unless it is the owner's alone or not a route.
    const scope = error instanceof RouterError && error.message === "owner_sign_in_required" ? requestScope(req) : undefined;
    // Body parser rejections (malformed JSON, oversized bodies) are client errors.
    const parser = error instanceof Error && "type" in error && "status" in error &&
      typeof error.status === "number" && error.status >= 400 && error.status < 500 ? error.status : undefined;
    if (!(error instanceof RouterError) && !(error instanceof z.ZodError) && parser === undefined)
      process.stderr.write(JSON.stringify({ event: "mau.error", code: "operation_failed",
        message: error instanceof Error ? error.message : String(error) }) + "\n");
    res.status(error instanceof RouterError ? error.status : error instanceof z.ZodError ? 400 : parser ?? 500)
      .json({ error: error instanceof RouterError ? error.message : error instanceof z.ZodError ? "invalid_request"
        : parser === 413 ? "request_too_large" : parser ? "invalid_request" : "operation_failed",
        ...(error instanceof RouterError && error.nativeError !== undefined ? { nativeError: error.nativeError } : {}),
        // Members beside `error`, for example the partners sharing an environment that was asked to be destroyed.
        ...(error instanceof RouterError && error.fields ? error.fields : {}),
        ...(scope && scope !== "owner" ? { scope } : {}),
        // Router's identity errors carry display fields (e.g. `email` for owner_not_configured).
        ...(error instanceof RouterError && "details" in error && error.details && typeof error.details === "object" ? error.details : {}),
        ...(error instanceof MemoryError ? { details: error.details } : {}) });
  });
  const sshServers = new Set<() => void>();
  return { app, router, environments, proactive, facts, reviews, partners, start: async () => { await connectorRuntime?.start(); await router.start(); proactive.start(); reviews.start(); completedTurns.start(); nativeRelay.start(); if (options.nativeWork.partnerTools) partners.start(); },
    // One upgrade listener: Router's ledger event socket (`/_agent-router/v1/web/socket`) first, then SSH, which
    // answers 404 for every other path.
    attach: (server: Server) => { sshServers.add(attachSsh(server, async req => (await authenticateRequest(req)).ownerId,
      (owner, agentId, keyId) => environments.connectSsh(owner, agentId, keyId),
      (req, socket, head) => router.upgrade(req, socket, head))); },
    close: async () => { for (const close of sshServers) close(); await proactive.close(); await partners.close(); await completedTurns.close(); await nativeRelay.close(); await reviews.close(); await environments.close(); externals.close(); await router.close(); await connectorRuntime?.close(); proactiveStore.close(); businessStore.close(); } };
}
