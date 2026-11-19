import { z } from "zod";
import { routerApiReference } from "@agent-router/server";
import { connectInputSchema, policySettingsSchema, siteAccessInputSchema } from "./connector-accounts.js";
import { connectorAssignmentInput } from "./connected-apps.js";
import { dutySchema } from "./environments.js";
import { modelSelectionInput } from "./model-settings.js";
import { memoryMutationInput } from "./partner-context.js";
import { proactiveRuleInput } from "./proactive.js";
import { historyQuery } from "./session-history.js";

export const apiRoot = "/_mau/v1";
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
  /** A partner gets an environment of its own (`profileId`) or runs in another partner's (`shareWith`). */
  newAgent: z.union([z.object({ ...newAgent, profileId }).strict(),
    z.object({ ...newAgent, shareWith: z.uuid(), kernel: z.string().min(1).max(48).optional() }).strict()]),
  sshKey: z.object({ publicKey: z.string().max(128) }).strict(),
  environment: z.object({ profileId }).strict(),
  environmentReplace: z.object({ profileId, expectedOperationId: z.uuid() }).strict(),
  environmentRollback: z.object({ expectedOperationId: z.uuid() }).strict(),
};

export interface ApiRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The full path, with `:name` for each parameter. */
  path: string;
  /** One plain sentence. */
  summary: string;
  /** JSON Schema of the request body. */
  body?: unknown;
}
const route = (method: ApiRoute["method"], path: string, summary: string, body?: z.ZodType): ApiRoute =>
  ({ method, path: apiRoot + path, summary, ...(body ? { body: z.toJSONSchema(body, { io: "input" }) } : {}) });
const agent = "/agents/:id", account = "/connector-accounts/:id", rule = "/proactive/:id";

/** Every route `src/app.ts` serves. A test compares it with the routes registered there, so neither can be changed alone. */
export const mauApiReference: ApiRoute[] = [
  { method: "GET", path: "/oauth/callback", summary: "Where a provider sends the owner's browser back after OAuth consent; not under /_mau/v1, not a JSON route, and accepted only from the browser that started the consent." },
  route("GET", "/info", "How to sign in and out; the only route that needs no sign-in."),
  route("GET", "/account", "The signed-in owner."),
  route("GET", "/reference", "This list: every HTTP route of the service."),
  route("GET", "/options", "The environment profiles the owner can create partners with."),

  route("GET", "/agents", "The owner's partners, each with its channel connections, duty, kernel, environment and dismissal."),
  route("POST", "/agents", "Create a partner with an environment of its own (profileId) or in another partner's environment (shareWith).", apiInput.newAgent),
  route("GET", agent, "One partner."),
  route("DELETE", agent, "Permanently delete a partner with its environment, memory, schedules and channel connections."),
  route("POST", agent + "/dismiss", "Archive a partner: it keeps everything and leaves the roster.", apiInput.empty),
  route("POST", agent + "/restore", "Bring a dismissed partner back.", apiInput.empty),
  route("GET", agent + "/instructions", "The partner's fixed instructions."),
  route("GET", agent + "/model-settings", "The models and efforts the partner's kernel offers, and the owner's selection."),
  route("PUT", agent + "/model-settings", "Select the partner's model and effort; null returns one to the runtime's default.", modelSelectionInput),
  route("GET", agent + "/connectors", "The connector connections the partner can use, and the partner it inherits them from when it has none of its own."),
  route("PUT", agent + "/connectors", "Replace the partner's own connector connections; an empty list removes its own assignment.", connectorAssignmentInput),
  route("GET", "/partners", "The owner's partners as they work together, dismissed ones included: status, model, who recruited them and what waits at them."),
  route("GET", "/partners/messages", "Messages between the owner's partners, newest first; query agentId and limit."),

  route("GET", agent + "/environment", "The state of the partner's environment."),
  route("POST", agent + "/environment", "Create an environment for a partner that has none.", apiInput.environment),
  route("POST", agent + "/environment/replace", "Move the partner to a new environment of another profile.", apiInput.environmentReplace),
  route("POST", agent + "/environment/rollback", "Return the partner to the environment it had before a replacement.", apiInput.environmentRollback),
  route("POST", agent + "/environment/:action", "Run one environment action: pause, resume, destroy or reconcile.", apiInput.empty),
  route("POST", agent + "/ssh", "Register a temporary public key for one SSH connection to the partner's environment.", apiInput.sshKey),
  { method: "GET", path: apiRoot + agent + "/ssh/:keyId", summary: "The SSH tunnel to the partner's environment: an HTTP upgrade, not a JSON route." },

  route("GET", agent + "/memory", "The partner's memory: its entries and how much of the limit they use."),
  route("POST", agent + "/memory", "Change the partner's memory: add, replace or remove an entry, or a batch of those applied all or none.", memoryMutationInput),
  route("GET", agent + "/memory/mutations", "The last changes of the partner's memory, newest first."),
  route("POST", agent + "/memory/mutations/seen", "Record that the owner has seen the memory changes up to one.", apiInput.memorySeen),
  route("POST", agent + "/memory/mutations/:mutationId/undo", "Take one memory change back.", apiInput.empty),
  route("GET", agent + "/memory/pending", "Memory changes that wait for the owner's approval."),
  route("POST", agent + "/memory/pending/:pendingId/approve", "Approve a waiting memory change.", apiInput.empty),
  route("POST", agent + "/memory/pending/:pendingId/discard", "Discard a waiting memory change.", apiInput.empty),
  route("GET", agent + "/memory/reviews", "The background memory reviews of the partner and whether they are on."),
  route("POST", agent + "/memory/reviews/state", "Turn the partner's background memory reviews on or off.", apiInput.reviewState),
  route("POST", agent + "/memory/search", "Search the partner's recorded conversation history.", historyQuery),
  route("POST", agent + "/memory/history/import", "Record one page of a work session's history so that it can be searched.", apiInput.historyImport),

  route("POST", agent + "/native/discover", "Ask the partner's runtime to describe itself: kernel, models and settings.", apiInput.empty),
  route("GET", agent + "/native/skills", "The skills of the partner's kernel."),
  route("POST", agent + "/native/skills", "Enable or disable one skill of the partner's kernel.", apiInput.skillState),
  route("GET", agent + "/native/memory", "The state of the kernel's own memory feature."),
  route("GET", agent + "/work-sessions/:sessionId/memory", "The kernel's memory setting of one work session."),
  route("POST", agent + "/work-sessions/:sessionId/memory", "Enable or disable the kernel's memory for one work session.", apiInput.sessionMemoryMode),

  route("GET", "/connector-accounts", "The owner's connector connections with their authorization state and the partners that can use each."),
  route("POST", account + "/feishu-application", "Give the app of a partner's Feishu chat channel to the owner's Feishu connection.", apiInput.feishuApplication),
  route("GET", account + "/policy", "The connection's operations with the owner's setting for each: allow, ask or deny."),
  route("PUT", account + "/policy", "Set operations of the connection to allow, ask or deny.", policySettingsSchema),
  route("POST", account + "/policy/reset", "Return every operation of the connection to its default setting.", apiInput.empty),
  route("GET", account + "/access", "A browser connection's site access: whether new sites open directly or ask first, and the sites always allowed."),
  route("PUT", account + "/access", "Change a browser connection's site access: set webAccess, or remove one always-allowed site.", siteAccessInputSchema),
  route("POST", account + "/:action", "Run one account action: check, connect, complete (Feishu device consent) or disconnect; only connect takes a body.", connectInputSchema),

  route("GET", "/proactive", "The owner's scheduled rules."),
  route("POST", "/proactive", "Create a scheduled rule.", proactiveRuleInput),
  route("GET", rule, "One scheduled rule."),
  route("PUT", rule, "Change a scheduled rule; expectedVersion is the version that was read.", apiInput.ruleUpdate),
  route("GET", rule + "/runs", "The runs and notifications of a scheduled rule."),
  route("POST", rule + "/state", "Pause or resume a scheduled rule.", apiInput.ruleState),
  route("POST", rule + "/run", "Run a scheduled rule now.", apiInput.ruleRun),
  route("POST", rule + "/cancel", "Cancel the running work of a scheduled rule.", apiInput.empty),
];

/** Every HTTP route of the service: Mau's, then Router's own table. */
export const apiReference = (): { routes: ApiRoute[] } => ({ routes: [...mauApiReference, ...routerApiReference] });
