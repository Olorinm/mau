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
export type ChannelKind = "feishu" | "weixin" | "telegram" | "matrix" | "grove-mail";
export interface AgentSummary {
  agent: { id: string; owner: string; name: string; address: string; matrixId: string; createdAt: string; status: "provisioning" | "active";
    /** Router phase 7: `none` (no Matrix account), `dormant` or `active`. */
    matrix?: { state: "active" | "dormant" | "none"; userId: string | null } };
  host: { runtimeId: string } | null;
  connections: Array<{ id: string; kind: ChannelKind; personalTools?: boolean }>;
  environment: EnvironmentView | null;
}
export interface EnvironmentProfile { id: string; label: string; kernel: string }
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
  usage?: "owner_private" }
export type EnvironmentAction = "pause" | "resume" | "destroy" | "reconcile";

export interface ConnectionJob {
  id: string;
  kind: "feishu" | "weixin" | "telegram";
  state: "starting" | "binding" | "waiting" | "application" | "authorization" | "telegram_pairing" | "pairing" | "ready" | "failed";
  expiresAt: string;
  url?: string;
  error?: string;
  recovery?: { action: "retry" | "retry_binding" | "authorize_existing_app"; appId?: string; domain: "feishu" | "lark"; personalTools: boolean };
}
export type ConnectionRequest =
  | { kind: "feishu"; appId?: string; domain: "feishu" | "lark"; personalTools: boolean }
  | { kind: "weixin" }
  | { kind: "telegram"; token: string }
  | { kind: "matrix" }
  | { kind: "grove-mail"; serviceId: string; inboxId: string; apiKey: string; ownerEmail: string };
export interface CheckResult {
  agentId: string;
  connectionId?: string;
  kind: string;
  /** `disabled`: a Matrix connection kept while Matrix is off (agent-router ADR 0005 19.2). */
  status: "verified" | "needs_action" | "not_verified" | "disabled";
  detail: string;
}
export interface FeishuAuthorization { authorized: boolean; verified: boolean; userName?: string; status?: string }

const mau = "/_mau/v1", router = "/_agent-router/v1";
const agent = (id: string) => `/agents/${encodeURIComponent(id)}`;

export function mauApi(token: string) {
  return {
    account: () => request<{ owner: string }>(mau + "/account", { token }),
    connectorAccounts: () => request<{ configured: boolean; data: ConnectorAccount[] }>(mau + "/connector-accounts", { token, timeoutMs: 95_000 }),
    /** Unified 飞书 entry: give the Agent's Feishu chat app to the owner's Feishu connection (no second app or QR). */
    feishuApplication: (id: string, agentId: string) => request<ConnectorAccountState>(mau + "/connector-accounts/" + encodeURIComponent(id) + "/feishu-application", { token, body: { agentId }, timeoutMs: 150_000 }),
    connectorAccountAction: (id: string, action: "check" | "connect" | "complete" | "disconnect") => request<ConnectorAccountState>(mau + "/connector-accounts/" + encodeURIComponent(id) + "/" + action, { token, body: {}, credentials: "same-origin", timeoutMs: 150_000 }),
    options: () => request<{ environments: EnvironmentProfile[] }>(mau + "/options", { token }),
    agents: () => request<{ data: AgentSummary[] }>(mau + "/agents", { token }).then((r) => r.data),
    agent: (id: string) => request<AgentSummary>(mau + agent(id), { token }),
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
  const feishu = (id: string) => router + agent(id) + "/communication/connections/feishu/authorization";
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
    feishuAuthorization: (id: string) => request<FeishuAuthorization>(feishu(id), { token }),
    beginFeishuAuthorization: (id: string) =>
      request<{ verificationUrl: string; expiresAt: string }>(feishu(id) + "/begin", { token, body: {} }),
    completeFeishuAuthorization: (id: string) => request<FeishuAuthorization>(feishu(id) + "/complete", { token, body: {} }),
  };
}

export const isJob = (value: unknown): value is ConnectionJob =>
  typeof value === "object" && value !== null && "state" in value && "expiresAt" in value;
