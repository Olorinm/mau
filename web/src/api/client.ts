import { request } from "./http";

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
}
export type ChannelKind = "feishu" | "weixin" | "telegram" | "grove-mail";
export interface AgentSummary {
  agent: { id: string; owner: string; name: string; address: string; createdAt: string; status: "provisioning" | "active" };
  host: { runtimeId: string } | null;
  /** Kinds this console does not connect (push, web, room) are listed by the server too. */
  connections: Array<{ id: string; kind: ChannelKind | "bark" | "web" | "room" }>;
  environment: EnvironmentView | null;
}
export interface EnvironmentProfile { id: string; label: string; kernel: string }
/** One of an employee's two memory files: `memory` (MEMORY.md, working knowledge) or `user` (USER.md, the owner's preferences). */
export interface MemoryFile { target: "memory" | "user"; file: string; entries: string[]; usage: { used: number; limit: number } }
/** Entries of a memory file are separated by this line; the server stores and counts them joined with it. */
export const memoryDelimiter = "\n§\n";
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
    resetConnectorPolicy: (id: string) => request<ConnectorPolicy>(mau + "/connector-accounts/" + encodeURIComponent(id) + "/policy/reset", { token, body: {} }),
    options: () => request<{ environments: EnvironmentProfile[] }>(mau + "/options", { token }),
    agents: () => request<{ data: AgentSummary[] }>(mau + "/agents", { token }).then((r) => r.data),
    agent: (id: string) => request<AgentSummary>(mau + agent(id), { token }),
    /** The fixed instructions of the employee's environment profile (read-only; shared by the profile's employees). */
    agentInstructions: (id: string) => request<{ text: string }>(mau + agent(id) + "/instructions", { token }),
    agentMemory: (id: string) => request<{ files: MemoryFile[] }>(mau + agent(id) + "/memory", { token }),
    /** Applies the owner's changes to one memory file, in order and all or none. */
    changeAgentMemory: (id: string, target: MemoryFile["target"], operations: MemoryOperation[]) =>
      request<unknown>(mau + agent(id) + "/memory", { token, body: { action: "batch", target, operations } }),
    createAgent: (name: string, profileId: string) =>
      request<AgentSummary>(mau + "/agents", { token, body: { name, profileId } }),
    deleteAgent: (id: string) => request<null>(mau + agent(id), { token, method: "DELETE", timeoutMs: 300_000 }),
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
      request<ConnectionJob | Omit<AgentSummary, "environment">>(router + agent(id) + "/connections", { token, body }),
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
