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
  agent: { id: string; owner: string; name: string; address: string; matrixId: string; createdAt: string; status: "provisioning" | "active" };
  host: { runtimeId: string } | null;
  connections: Array<{ id: string; kind: ChannelKind; personalTools?: boolean }>;
  environment: EnvironmentView | null;
}
export interface EnvironmentProfile { id: string; label: string; kernel: string }
export interface BusinessConnection { agentId: string; kind: "business-data"; status: "configured"; tools: string[]; feishuBotRead: boolean; permission: "read-only" }
export interface ConnectorAccountState {
  state: "connected" | "authorization_required" | "authorization_pending" | "disconnected" | "needs_setup" | "needs_attention";
  verification: "oauth" | "provider" | "none";
  scopes: string[];
  authorizationUrl?: string;
  expiresAt?: string;
}
export interface ConnectorAccount extends ConnectorAccountState { id: string; kind: string; label: string }
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
  status: "verified" | "needs_action" | "not_verified";
  detail: string;
}
export interface FeishuAuthorization { authorized: boolean; verified: boolean; userName?: string; status?: string }

const mau = "/_mau/v1", router = "/_agent-router/v1";
const agent = (id: string) => `/agents/${encodeURIComponent(id)}`;

export function mauApi(token: string) {
  return {
    account: () => request<{ owner: string }>(mau + "/account", { token }),
    connectorAccounts: () => request<{ configured: boolean; data: ConnectorAccount[] }>(mau + "/connector-accounts", { token, timeoutMs: 95_000 }),
    connectorAccountAction: (id: string, action: "check" | "connect" | "disconnect") => request<ConnectorAccountState>(mau + "/connector-accounts/" + encodeURIComponent(id) + "/" + action, { token, body: {}, timeoutMs: 150_000 }),
    connectors: () => request<{ data: BusinessConnection[] }>(mau + "/connectors", { token }).then(r => r.data),
    checkConnector: (id: string) => request<{ status: "verified"; checkedAt: string }>(mau + "/connectors/" + encodeURIComponent(id) + "/check", { token, body: {}, timeoutMs: 95_000 }),
    options: () => request<{ environments: EnvironmentProfile[] }>(mau + "/options", { token }),
    agents: () => request<{ data: AgentSummary[] }>(mau + "/agents", { token }).then((r) => r.data),
    agent: (id: string) => request<AgentSummary>(mau + agent(id), { token }),
    createAgent: (name: string, profileId: string) =>
      request<AgentSummary>(mau + "/agents", { token, body: { name, profileId } }),
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
