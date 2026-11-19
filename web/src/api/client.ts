import { request, type PartnerRef } from "./http";

// Shapes follow Mau /_mau/v1 and Router /_agent-router/v1 on their pinned revisions.
export type EnvironmentState =
  | "unconfigured" | "creating" | "starting" | "ready" | "pausing" | "paused"
  | "sleeping" | "resuming" | "deleting" | "deleted" | "needs_action";
export interface EnvironmentView {
  state: EnvironmentState;
  busy: boolean;
  operationId?: string;
  profileId?: string;
  updatedAt?: string;
  error?: string;
  /** The partner whose environment this one runs in; it has no environment of its own. */
  sharedFrom?: string;
  /** The partners running in this partner's environment. */
  sharedBy?: string[];
}
export type ChannelKind = "feishu" | "weixin" | "telegram" | "grove-mail";
export interface AgentSummary {
  agent: { id: string; owner: string; name: string; address: string; createdAt: string; status: "provisioning" | "active" };
  host: { runtimeId: string } | null;
  /** Kinds this console does not connect (push, web, room) are listed by the server too. */
  connections: Array<{ id: string; kind: ChannelKind | "bark" | "web" | "room" }>;
  /** One line saying what the partner is responsible for; fixed when it is created. */
  duty: string | null;
  /** The kernel the partner itself runs on; partners in one environment can run on different ones. */
  kernel: string | null;
  environment: EnvironmentView | null;
  /** `external`: it runs on the owner's own computer, which pairs with it; it has no environment. */
  kind: "managed" | "external";
  connection?: DeviceConnection;
  device?: DeviceView | null;
  /** When the partner was dismissed: it keeps its conversation and memory, and is not listed until it is restored. */
  dismissed?: string | null;
}
export type DeviceConnection = "pairing" | "online" | "offline";
/** The computer paired with a partner that runs on it. */
export interface DeviceView { id: string; name: string; platform: string; kernel: string; online: boolean; pairedAt: string; lastOnlineAt: string | null }
/** A pairing code and the command that uses it on the computer; the server shows a code only when it makes one. */
export interface Pairing { code: string; expiresAt: string; command: string }
/** A partner as it works with the others: who recruited it and what waits at it. */
export interface PartnerView {
  id: string; name: string; duty: string | null; status: string;
  kernel: string | null; model: string | null; effort: string | null; lastActivityAt: string | null;
  /** Messages of other partners it has not answered yet, and its operations that wait for the owner's approval. */
  waiting: { messages: number; approvals: number };
  sharesEnvironmentOf?: string; recruitedBy?: PartnerRef; recruitedAt?: string; dismissedAt?: string;
}
/** Where a new partner runs: in an environment of its own, in another partner's (on its main kernel unless one is named), or on the owner's computer. */
export type NewPartnerEnvironment = { profileId: string } | { shareWith: string; kernel?: string } | { kind: "external" };
/** A partner another one can run in the environment of: it has its own, not destroyed. Sharing does not chain. */
export const canShareEnvironment = ({ environment }: AgentSummary) =>
  !!environment && !environment.sharedFrom && !["deleting", "deleted"].includes(environment.state);
/** `kernels` are the kernels a partner in an environment of this profile can run on, its main one (`kernel`) first. */
export interface EnvironmentProfile { id: string; label: string; kernel: string; kernels: string[] }
/** A partner's memory: one document (MEMORY.md) of entries. */
export interface MemoryFile { file: string; entries: string[]; usage: { used: number; limit: number } }
/** Entries of the memory are separated by this line; the server stores and counts them joined with it. */
export const memoryDelimiter = "\n§\n";
/** One entry as a change of the memory left it. */
export type MemoryChange = { action: "add"; text: string } | { action: "replace"; before: string; after: string } | { action: "remove"; text: string; index: number };
/**
 * One change of a partner's memory. `origin` is `owner` for the owner's own turns, edits and undos; `source` names the
 * partners whose message or results the turn was handling. `unseen`: not the owner's, and newer than the owner last saw.
 */
export interface MemoryMutation {
  id: string; seq: number; at: string; origin: "owner" | "delegation" | "review";
  source?: { kind: "message" | "result"; partners: Array<{ id: string; name: string }> };
  changes: MemoryChange[]; undoOf?: string; undoneAt?: string; unseen: boolean;
}
export type MemoryOperation = { action: "add"; content: string } | { action: "remove"; old_text: string } | { action: "replace"; old_text: string; content: string };
export interface ConnectorAccountState {
  state: "connected" | "authorization_required" | "authorization_pending" | "expired" | "disconnected" | "needs_setup" | "needs_attention";
  verification: "oauth" | "provider" | "none";
  scopes: string[];
  /** Why it expired or needs setup, e.g. `refresh_token_expired`, `application_not_provided`. */
  reason?: string;
  /** Authorized user's display name (Feishu). */
  name?: string;
  authorizationUrl?: string;
  expiresAt?: string;
}
export interface ConnectorAccount extends ConnectorAccountState { id: string; kind: string; label: string; assignedAgents?: string[]; permission?: "read-only";
  /** Acts as the owner; usable only in the owner's private conversation. */
  usage?: "owner_private";
  /** The authorized provider account, when the connector reports it. */
  account?: { email?: string; name?: string } }
export type PolicySetting = "allow" | "ask" | "deny";
export interface PolicyOperation {
  id: string; label: string; labelZh: string;
  risk: "read" | "write" | "destructive";
  setting: PolicySetting; default: PolicySetting;
  available: boolean;
  unavailableReason?: "scope_required" | "not_supported";
  /** Whether connecting again with this operation's scope can make it available (添加). */
  grantable?: boolean;
}
export interface PolicyGroup { id: string; label: string; labelZh: string; operations: PolicyOperation[] }
/** Per-operation permissions of one connector account. */
export interface ConnectorPolicy { groups: PolicyGroup[]; background?: PolicyOperation[] }
export type WebAccess = "direct" | "ask";
/** A browser connection's site permissions: whether new sites open directly or ask first, and the sites always allowed. */
export interface SiteAccess { webAccess: WebAccess; sites: string[] }
export type EnvironmentAction = "pause" | "resume" | "destroy" | "reconcile";

export interface ConnectionJob {
  id: string;
  kind: "feishu" | "weixin" | "telegram";
  state: "starting" | "binding" | "waiting" | "application" | "telegram_pairing" | "pairing" | "ready" | "failed";
  expiresAt: string;
  url?: string;
  error?: string;
  recovery?: { action: "retry" | "retry_binding" | "authorize_existing_app"; appId?: string; domain: "feishu" | "lark" };
}
export type ConnectionRequest =
  | { kind: "feishu"; appId?: string; domain: "feishu" | "lark" }
  | { kind: "weixin" }
  | { kind: "telegram"; token: string }
  | { kind: "grove-mail"; serviceId: string; inboxId: string; apiKey: string; ownerEmail: string };
export interface ModelSettings {
  kernel?: string;
  defaultModel?: string;
  models: Array<{ id: string; label: string; description?: string; efforts: string[]; defaultEffort?: string }>;
  efforts: string[];
  selection: { model?: string; effort?: string };
  source: "live" | "saved" | "none";
}
export interface CheckResult {
  agentId: string;
  connectionId?: string;
  kind: string;
  status: "verified" | "needs_action" | "not_verified";
  detail: string;
}

const mau = "/_mau/v1", router = "/_agent-router/v1";
const agent = (id: string) => `/agents/${encodeURIComponent(id)}`;

export function mauApi(token: string) {
  return {
    account: () => request<{ owner: string }>(mau + "/account", { token }),
    connectorAccounts: () => request<{ configured: boolean; data: ConnectorAccount[] }>(mau + "/connector-accounts", { token, timeoutMs: 95_000 }),
    /** Unified 飞书 entry: give the Agent's Feishu chat app to the owner's Feishu connection (no second app or QR). */
    feishuApplication: (id: string, agentId: string) => request<ConnectorAccountState>(mau + "/connector-accounts/" + encodeURIComponent(id) + "/feishu-application", { token, body: { agentId }, timeoutMs: 150_000 }),
    connectorAccountAction: (id: string, action: "check" | "connect" | "complete" | "disconnect") => request<ConnectorAccountState>(mau + "/connector-accounts/" + encodeURIComponent(id) + "/" + action, { token, body: {}, credentials: "same-origin", timeoutMs: 150_000 }),
    /** Connect again asking for the scopes of these grantable operations (添加). Older servers refuse the body. */
    connectWithOperations: (id: string, operations: string[]) => request<ConnectorAccountState>(mau + "/connector-accounts/" + encodeURIComponent(id) + "/connect", { token, body: { operations }, credentials: "same-origin", timeoutMs: 150_000 }),
    connectorPolicy: (id: string) => request<ConnectorPolicy>(mau + "/connector-accounts/" + encodeURIComponent(id) + "/policy", { token }),
    updateConnectorPolicy: (id: string, settings: Record<string, PolicySetting>) => request<ConnectorPolicy>(mau + "/connector-accounts/" + encodeURIComponent(id) + "/policy", { token, method: "PUT", body: { settings } }),
    connectorSiteAccess: (id: string) => request<SiteAccess>(mau + "/connector-accounts/" + encodeURIComponent(id) + "/access", { token }),
    updateConnectorSiteAccess: (id: string, change: { webAccess: WebAccess } | { remove: string }) =>
      request<SiteAccess>(mau + "/connector-accounts/" + encodeURIComponent(id) + "/access", { token, method: "PUT", body: change }),
    resetConnectorPolicy: (id: string) => request<ConnectorPolicy>(mau + "/connector-accounts/" + encodeURIComponent(id) + "/policy/reset", { token, body: {} }),
    options: () => request<{ environments: EnvironmentProfile[] }>(mau + "/options", { token }),
    agents: () => request<{ data: AgentSummary[] }>(mau + "/agents", { token }).then((r) => r.data),
    agent: (id: string) => request<AgentSummary>(mau + agent(id), { token }),
    /** The partner's fixed instructions (read-only): its environment profile's, or its own text in a shared environment. */
    agentInstructions: (id: string) => request<{ text: string }>(mau + agent(id) + "/instructions", { token }),
    /** The models and efforts the partner's kernel offers and its runtime allows, with the owner's choice. */
    modelSettings: (id: string) => request<ModelSettings>(mau + agent(id) + "/model-settings", { token, timeoutMs: 45_000 }),
    /** `null` returns a choice to the runtime's default. */
    selectModelSettings: (id: string, change: { model?: string | null; effort?: string | null }) =>
      request<ModelSettings>(mau + agent(id) + "/model-settings", { token, method: "PUT", body: change, timeoutMs: 45_000 }),
    agentMemory: (id: string) => request<MemoryFile>(mau + agent(id) + "/memory", { token }),
    /** Applies the owner's changes to the memory, in order and all or none. */
    changeAgentMemory: (id: string, operations: MemoryOperation[]) =>
      request<unknown>(mau + agent(id) + "/memory", { token, body: { action: "batch", operations } }),
    /** The last changes of the partner's memory, newest first. */
    agentMemoryMutations: (id: string) => request<{ data: MemoryMutation[] }>(mau + agent(id) + "/memory/mutations", { token }).then((r) => r.data),
    /** The owner has seen the changes up to this one. */
    seenAgentMemoryMutations: (id: string, through: number) => request<{ seen: number }>(mau + agent(id) + "/memory/mutations/seen", { token, body: { through } }),
    /** Takes one change back; refused with `memory_undo_conflict` when the memory changed in that place since. */
    undoAgentMemoryMutation: (id: string, mutationId: string) =>
      request<unknown>(mau + agent(id) + "/memory/mutations/" + encodeURIComponent(mutationId) + "/undo", { token, body: {} }),
    /** With `shareWith` no environment is created and the partner is usable when the request returns; with `kind` the answer has its pairing code. */
    createAgent: (name: string, environment: NewPartnerEnvironment, duty?: string) =>
      request<AgentSummary & { pairing?: Pairing }>(mau + "/agents", { token, body: { name, ...environment, ...(duty ? { duty } : {}) } }),
    /** The owner's partners, dismissed ones included. */
    partners: () => request<{ data: PartnerView[] }>(mau + "/partners", { token }).then((r) => r.data),
    /** Archive a partner (it keeps everything and leaves the roster), or bring it back. */
    dismissAgent: (id: string) => request<AgentSummary>(mau + agent(id) + "/dismiss", { token, body: {} }),
    restoreAgent: (id: string) => request<AgentSummary>(mau + agent(id) + "/restore", { token, body: {} }),
    deleteAgent: (id: string) => request<null>(mau + agent(id), { token, method: "DELETE", timeoutMs: 300_000 }),
    /** A new pairing code; the computer that pairs with it replaces the one paired before. */
    pairDevice: (id: string) => request<Pairing>(mau + agent(id) + "/device/pair", { token, body: {} }),
    unpairDevice: (id: string) => request<null>(mau + agent(id) + "/device", { token, method: "DELETE" }),
    environment: (id: string) => request<EnvironmentView>(mau + agent(id) + "/environment", { token }),
    createEnvironment: (id: string, profileId: string) =>
      request<EnvironmentView>(mau + agent(id) + "/environment", { token, body: { profileId } }),
    environmentAction: (id: string, action: EnvironmentAction) =>
      request<EnvironmentView>(mau + agent(id) + "/environment/" + action, { token, body: {} }),
  };
}

export function routerApi(token: string) {
  return {
    connectionOptions: () => request<{ mailServices: Array<{ id: string; label: string }> }>(router + "/connection-options", { token }),
    connect: (id: string, body: ConnectionRequest) =>
      request<ConnectionJob | Omit<AgentSummary, "environment" | "duty" | "kernel">>(router + agent(id) + "/connections", { token, body }),
    jobs: (id: string) => request<{ data: ConnectionJob[] }>(router + agent(id) + "/connection-jobs", { token }).then((r) => r.data),
    job: (id: string, jobId: string) =>
      request<ConnectionJob>(router + agent(id) + "/connection-jobs/" + encodeURIComponent(jobId), { token }),
    pair: (id: string, jobId: string, code: string) =>
      request<null>(router + agent(id) + "/connection-jobs/" + encodeURIComponent(jobId) + "/pairing", { token, body: { code } }),
    check: (id: string) => request<{ checks: CheckResult[] }>(router + agent(id) + "/check", { token, body: {} }).then((r) => r.checks),
  };
}

export const isJob = (value: unknown): value is ConnectionJob =>
  typeof value === "object" && value !== null && "state" in value && "expiresAt" in value;
