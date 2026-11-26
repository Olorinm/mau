import { z } from "zod";
import { agentProfileName, routerApiReference, routerRouteScope } from "@agent-router/server";
import { connectInputSchema, policySettingsSchema, siteAccessInputSchema } from "./connector-accounts.js";
import { connectorAssignmentInput } from "./connected-apps.js";
import { dutySchema } from "./environments.js";
import { modelSelectionInput } from "./model-settings.js";
import { memoryMutationInput } from "./partner-context.js";
import { proactiveRuleInput } from "./proactive.js";
import { historyQuery } from "./session-history.js";

export const apiRoot = "/_mau/v1";
/**
 * What a request needs, with Router's meanings: `read` looks, `chat` talks to a partner, `approve` decides for the
 * owner, `manage` changes what the owner has set up, and `owner` is the owner's alone and never given to a token.
 */
export type RouteScope = "read" | "chat" | "approve" | "manage" | "owner";
/** The scopes an access token may carry. `read` is implied by every token. */
export const tokenScopes = ["chat", "approve", "manage"] as const;
const profileId = z.string().min(1).max(48);
const newAgent = { name: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), duty: dutySchema.optional() };
/** The request bodies of `/_mau/v1` that `src/app.ts` validates itself; the routes parse with these and the reference shows them. */
export const apiInput = {
  empty: z.object({}).strict(),
  ruleUpdate: z.object({ expectedVersion: z.number().int().positive(), rule: z.unknown() }).strict(),
  ruleState: z.object({ status: z.enum(["active", "paused"]) }).strict(),
  ruleRun: z.object({ requestId: z.string().min(1).max(160) }).strict(),
  memorySeen: z.object({ through: z.number().int().min(0) }).strict(),
  historyImport: z.object({ sessionId: z.string().min(1).max(160), cursor: z.string().max(10000).optional() }).strict(),
  reviewState: z.object({ enabled: z.boolean() }).strict(),
  skillState: z.object({ path: z.string().min(1).max(4096), enabled: z.boolean() }).strict(),
  sessionMemoryMode: z.object({ mode: z.enum(["enabled", "disabled"]) }).strict(),
  feishuApplication: z.object({ agentId: z.uuid() }).strict(),
  /** What the owner writes in a session of a partner. The same `key` always submits the same turn. */
  sessionMessage: z.object({ text: z.string().min(1).max(24_000), key: z.string().min(1).max(160) }).strict(),
  /**
   * A partner gets an environment of its own (`profileId`), runs in another partner's (`shareWith`), or is an agent
   * on a computer (`kind: "external"`). `ownership` says whose that agent is; only the owner's own can be created.
   */
  newAgent: z.union([z.object({ ...newAgent, profileId }).strict(),
    z.object({ ...newAgent, shareWith: z.uuid(), kernel: z.string().min(1).max(48).optional() }).strict(),
    z.object({ ...newAgent, kind: z.literal("external"), ownership: z.enum(["owner", "other"]).default("owner") }).strict()]),
  partnerEdit: z.object({ name: agentProfileName.optional(), duty: dutySchema.nullable().optional() }).strict()
    .refine(value => value.name !== undefined || value.duty !== undefined),
  sshKey: z.object({ publicKey: z.string().max(128) }).strict(),
  environment: z.object({ profileId }).strict(),
  environmentReplace: z.object({ profileId, expectedOperationId: z.uuid() }).strict(),
  environmentRollback: z.object({ expectedOperationId: z.uuid() }).strict(),
  newToken: z.object({ name: z.string().min(1).max(60), scopes: z.array(z.enum(tokenScopes)).min(1).max(tokenScopes.length),
    expiresInDays: z.number().int().min(1).max(90).optional() }).strict(),
};

export interface ApiRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The full path, with `:name` for each parameter. */
  path: string;
  /** What the request needs of a caller that is not the signed-in owner. */
  scope: RouteScope;
  /** One plain sentence. */
  summary: string;
  /** JSON Schema of the request body. */
  body?: unknown;
}
/** A `GET` reads; every other route states its scope. */
function route(method: "GET", path: string, summary: string): ApiRoute;
function route(method: Exclude<ApiRoute["method"], "GET">, path: string, summary: string, body: z.ZodType | undefined, scope: RouteScope): ApiRoute;
function route(method: ApiRoute["method"], path: string, summary: string, body?: z.ZodType, scope: RouteScope = "read"): ApiRoute {
  return { method, path: apiRoot + path, scope, summary, ...(body ? { body: z.toJSONSchema(body, { io: "input" }) } : {}) };
}
/** The SSH tunnel is an upgrade of a `GET`: `requestScope` holds the upgrade to `manage`. */
const sshTunnel = { method: "GET", path: apiRoot + "/agents/:id/ssh/:keyId", scope: "read" } as const;
const agent = "/agents/:id", account = "/connector-accounts/:id", rule = "/proactive/:id";

/** Every route `src/app.ts` serves. A test compares it with the routes registered there, so neither can be changed alone. */
export const mauApiReference: ApiRoute[] = [
  { method: "GET", path: "/oauth/callback", scope: "read", summary: "Where a provider sends the owner's browser back after OAuth consent; not under /_mau/v1, not a JSON route, and accepted only from the browser that started the consent." },
  route("GET", "/info", "How to sign in and out; the only route that needs no sign-in."),
  route("GET", "/account", "The signed-in owner."),
  route("GET", "/reference", "This list: every HTTP route of the service."),
  route("GET", "/options", "The environment profiles the owner can create partners with."),
  { ...route("GET", "/tokens", "The owner's access tokens, newest first, without their secrets; for the signed-in owner only."), scope: "owner" },
  route("POST", "/tokens", "Create an access token that lets an Access service token of the owner do more than read; the answer has the token, once.", apiInput.newToken, "owner"),
  route("DELETE", "/tokens/:id", "Revoke an access token.", undefined, "owner"),

  route("GET", "/agents", "The owner's partners, each with its kind, channel connections, duty, kernel, environment or computer, and dismissal."),
  route("POST", "/agents", "Create a partner with an environment of its own (profileId), in another partner's environment (shareWith), or as an agent on the owner's computer (kind external), which answers with a pairing code.", apiInput.newAgent, "manage"),
  route("GET", agent, "One partner."),
  route("PATCH", agent, "Edit a partner’s name or duty in place; a null duty clears it.", apiInput.partnerEdit, "manage"),
  route("DELETE", agent, "Permanently delete a partner with its environment, memory, schedules and channel connections.", undefined, "manage"),
  route("POST", agent + "/dismiss", "Archive a partner: it keeps everything and leaves the roster.", apiInput.empty, "manage"),
  route("POST", agent + "/restore", "Bring a dismissed partner back.", apiInput.empty, "manage"),
  route("GET", agent + "/instructions", "The partner's fixed instructions."),
  route("GET", agent + "/model-settings", "The models and efforts the partner's kernel offers, and the owner's selection."),
  route("PUT", agent + "/model-settings", "Select the partner's model and effort; null returns one to the runtime's default.", modelSelectionInput, "manage"),
  route("GET", agent + "/connectors", "The connector connections the partner can use, and the partner it inherits them from when it has none of its own."),
  route("PUT", agent + "/connectors", "Replace the partner's own connector connections; an empty list removes its own assignment.", connectorAssignmentInput, "manage"),
  route("GET", "/partners", "The owner's partners as they work together, dismissed ones included: status, model, who recruited them and what waits at them."),
  route("GET", "/partners/messages", "Messages between the owner's partners, newest first; query agentId and limit."),
  route("GET", agent + "/sessions", "The sessions the partner works in beside its conversation with the owner, oldest first: one for each piece of work another partner sent it, with its title, who opened it, its turns, its size and whether it can still be continued."),
  route("POST", agent + "/sessions/:sessionId/messages", "Write in one of the partner's sessions as the owner: a turn of that session, whose answer stays there. 409 `partner_session_ended` when the session is closed.", apiInput.sessionMessage, "chat"),

  route("GET", "/devices", "The owner's partners that are agents on a computer, each with whether a computer is paired and connected."),
  route("GET", agent + "/device", "The computer paired with a partner that is an agent on it: name, platform, kernel, whether it is connected and when it last was."),
  route("POST", agent + "/device/pair", "A new pairing code for the partner and the command that uses it; the computer that pairs replaces the one paired before.", apiInput.empty, "manage"),
  route("DELETE", agent + "/device", "End the partner's pairing: its computer is disconnected.", undefined, "manage"),

  route("GET", agent + "/environment", "The state of the partner's environment."),
  route("POST", agent + "/environment", "Create an environment for a partner that has none.", apiInput.environment, "manage"),
  route("POST", agent + "/environment/replace", "Move the partner to a new environment of another profile.", apiInput.environmentReplace, "manage"),
  route("POST", agent + "/environment/rollback", "Return the partner to the environment it had before a replacement.", apiInput.environmentRollback, "manage"),
  route("POST", agent + "/environment/:action", "Run one environment action: pause, resume, destroy or reconcile.", apiInput.empty, "manage"),
  route("POST", agent + "/ssh", "Register a temporary public key for one SSH connection to the partner's environment.", apiInput.sshKey, "manage"),
  { ...sshTunnel, summary: "The SSH tunnel to the partner's environment: an HTTP upgrade, not a JSON route; the upgrade needs the manage scope." },

  route("GET", agent + "/memory", "The partner's memory: its entries and how much of the limit they use."),
  route("POST", agent + "/memory", "Change the partner's memory: add, replace or remove an entry, or a batch of those applied all or none.", memoryMutationInput, "manage"),
  route("GET", agent + "/memory/mutations", "The last changes of the partner's memory, newest first."),
  route("POST", agent + "/memory/mutations/seen", "Record that the owner has seen the memory changes up to one.", apiInput.memorySeen, "manage"),
  route("POST", agent + "/memory/mutations/:mutationId/undo", "Take one memory change back.", apiInput.empty, "manage"),
  route("GET", agent + "/memory/pending", "Memory changes that wait for the owner's approval."),
  route("POST", agent + "/memory/pending/:pendingId/approve", "Approve a waiting memory change.", apiInput.empty, "approve"),
  route("POST", agent + "/memory/pending/:pendingId/discard", "Discard a waiting memory change.", apiInput.empty, "approve"),
  route("GET", agent + "/memory/reviews", "The background memory reviews of the partner and whether they are on."),
  route("POST", agent + "/memory/reviews/state", "Turn the partner's background memory reviews on or off.", apiInput.reviewState, "manage"),
  route("POST", agent + "/memory/search", "Search the partner's recorded conversation history.", historyQuery, "manage"),
  route("POST", agent + "/memory/history/import", "Record one page of a work session's history so that it can be searched.", apiInput.historyImport, "manage"),

  route("POST", agent + "/native/discover", "Ask the partner's runtime to describe itself: kernel, models and settings.", apiInput.empty, "manage"),
  route("GET", agent + "/native/skills", "The skills of the partner's kernel."),
  route("POST", agent + "/native/skills", "Enable or disable one skill of the partner's kernel.", apiInput.skillState, "manage"),
  route("GET", agent + "/native/memory", "The state of the kernel's own memory feature."),
  route("GET", agent + "/work-sessions/:sessionId/memory", "The kernel's memory setting of one work session."),
  route("POST", agent + "/work-sessions/:sessionId/memory", "Enable or disable the kernel's memory for one work session.", apiInput.sessionMemoryMode, "manage"),

  route("GET", "/apps", "The owner's apps from the deployment's app service, and whether it has one."),
  route("GET", "/connector-accounts", "The owner's connector connections with their authorization state and the partners that can use each."),
  route("POST", account + "/feishu-application", "Give the app of a partner's Feishu chat channel to the owner's Feishu connection.", apiInput.feishuApplication, "manage"),
  route("GET", account + "/policy", "The connection's operations with the owner's setting for each: allow, ask or deny."),
  route("PUT", account + "/policy", "Set operations of the connection to allow, ask or deny.", policySettingsSchema, "owner"),
  route("POST", account + "/policy/reset", "Return every operation of the connection to its default setting.", apiInput.empty, "owner"),
  route("GET", account + "/access", "A browser connection's site access: whether new sites open directly or ask first, and the sites always allowed."),
  route("PUT", account + "/access", "Change a browser connection's site access: set webAccess, or remove one always-allowed site.", siteAccessInputSchema, "owner"),
  route("POST", account + "/:action", "Run one account action: check, connect, complete (Feishu device consent) or disconnect; only connect takes a body.", connectInputSchema, "manage"),

  route("GET", "/proactive", "The owner's scheduled rules."),
  route("POST", "/proactive", "Create a scheduled rule.", proactiveRuleInput, "manage"),
  route("GET", rule, "One scheduled rule."),
  route("PUT", rule, "Change a scheduled rule; expectedVersion is the version that was read.", apiInput.ruleUpdate, "manage"),
  route("GET", rule + "/runs", "The runs and notifications of a scheduled rule."),
  route("POST", rule + "/state", "Pause or resume a scheduled rule.", apiInput.ruleState, "manage"),
  route("POST", rule + "/run", "Run a scheduled rule now.", apiInput.ruleRun, "manage"),
  route("POST", rule + "/cancel", "Cancel the running work of a scheduled rule.", apiInput.empty, "manage"),
];


const routerRoot = "/_agent-router/v1";
const exact = (path: string) => new RegExp("^" + path.split("/").map(part => part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/") + "$");
const matchers = mauApiReference.map(({ method, path, scope }) => ({ method, scope, pattern: exact(path) })), sshTunnelPath = exact(sshTunnel.path);
/**
 * The scope of a concrete request under `/_mau/v1`: method upper-case, path without its query. The match is exact
 * (anchored, case-sensitive, `:name` is one non-empty segment). Express also serves other spellings of a route, such
 * as another letter case or a trailing slash: those are `undefined`, as is a path whose routes disagree, and a
 * caller must refuse `undefined`.
 */
export function mauRouteScope(method: string, path: string): RouteScope | undefined {
  const scopes = new Set(matchers.filter(route => route.method === method && route.pattern.test(path)).map(route => route.scope));
  return scopes.size === 1 ? [...scopes][0] : undefined;
}
/** The scope of a request as it arrived, Mau's or Router's; `undefined` for anything that is not exactly a listed route. */
export function requestScope(request: { headers: Record<string, unknown>; method?: string | undefined; originalUrl?: string | undefined }): RouteScope | undefined {
  if (typeof request.method !== "string" || typeof request.originalUrl !== "string") return undefined;
  const method = request.method.toUpperCase(), path = request.originalUrl.split("?")[0]!;
  if (path.startsWith(routerRoot + "/")) return routerRouteScope(method, path);
  if (!path.startsWith(apiRoot + "/")) return undefined;
  // The only upgrade Mau serves is the SSH tunnel, which is a shell in the partner's environment.
  if (request.headers.upgrade !== undefined) return method === sshTunnel.method && sshTunnelPath.test(path) ? "manage" : undefined;
  return mauRouteScope(method, path);
}

/** Every HTTP route of the service: Mau's, then Router's own table. */
export const apiReference = (): { routes: ApiRoute[] } => ({ routes: [...mauApiReference, ...routerApiReference] });
