import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, ProductStatus } from "@olorinm/agent-ui/app";
import { PageHeader, SearchField } from "@olorinm/agent-frontend";
import { mauApi, routerApi, type AgentSummary, type BusinessConnection, type ConnectorAccount } from "../api/client";
import type { Session } from "../api/session";
import { ApiError, safeExternalUrl } from "../api/http";
import { errorMessage, useI18n } from "../i18n";
import { ConnectChannelDialog } from "./connect-channel";
import { FeishuAuthorizationRow } from "./feishu-authorization";

function BusinessCard({ session, item, agent }: { session: Session; item: BusinessConnection; agent: AgentSummary }) {
  const { language } = useI18n(), zh = language === "zh-CN";
  const check = useMutation({ mutationFn: () => mauApi(session.token).checkConnector(item.agentId) });
  return <article className="mau-connection-card">
    <div className="mau-section-heading"><h2>{zh ? "业务数据" : "Business data"}</h2><ProductStatus compact tone={check.isSuccess ? "success" : "neutral"} label={check.isSuccess ? zh ? "已验证" : "Verified" : zh ? "已配置" : "Configured"} /></div>
    <p>{agent.agent.name} · {zh ? "只读权限" : "Read-only access"}</p>
    <p className="mau-muted">{zh ? "读取已授权的业务数据；不包含 SQL 或写入操作。" : "Reads authorized business data. SQL and writes are excluded."}</p>
    {item.feishuBotRead ? <p className="mau-muted">{zh ? "同时可使用飞书机器人已有权限读取文件。" : "Also reads Feishu files within the bot’s existing permissions."}</p> : null}
    <details><summary>{zh ? "可用工具" : "Available tools"}</summary><ul>{item.tools.map(tool => <li key={tool}>{tool}</li>)}</ul></details>
    {check.isError ? <p role="alert">{zh ? "暂时无法验证连接，请稍后重试。" : "The connection could not be verified. Try again later."}</p> : null}
    {check.data ? <p className="mau-muted">{new Date(check.data.checkedAt).toLocaleString()}</p> : null}
    <Button disabled={check.isPending} onClick={() => check.mutate()}>{check.isPending ? zh ? "检查中…" : "Checking…" : zh ? "检查连接" : "Check connection"}</Button>
  </article>;
}

const products = ["Gmail", "Google Calendar", "Google Drive", "Google Docs", "Google Sheets", "Google Slides", "GitHub", "Notion"];
function AccountCard({ session, item, agents }: { session: Session; item: ConnectorAccount; agents: AgentSummary[] }) {
  const { language } = useI18n(), zh = language === "zh-CN";
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [mustCheck, setMustCheck] = useState(false);
  const [current, setCurrent] = useState(item);
  const action = useMutation({ mutationFn: (name: "check" | "connect" | "disconnect") => mauApi(session.token).connectorAccountAction(item.id, name),
    onSuccess: (data, name) => { setCurrent({ ...item, ...data }); setMustCheck(false); setConfirmDisconnect(false);
      const consent = safeExternalUrl(data.authorizationUrl);
      if (name === "connect" && consent) window.location.assign(consent);
    },
    onError: () => { setMustCheck(true); setConfirmDisconnect(false); } });
  const labels = zh ? { connected: "账号已连接", authorization_required: "等待授权", authorization_pending: "授权待完成", disconnected: "已断开", needs_setup: "待服务端配置", needs_attention: "需要检查" }
    : { connected: "Account connected", authorization_required: "Authorization required", authorization_pending: "Authorization pending", disconnected: "Disconnected", needs_setup: "Setup required", needs_attention: "Needs attention" };
  const url = safeExternalUrl(current.authorizationUrl);
  return <article className="mau-connection-card">
    <div className="mau-section-heading"><h2>{item.label}</h2><ProductStatus compact tone={current.state === "connected" && !mustCheck ? "success" : "neutral"} label={mustCheck ? labels.needs_attention : labels[current.state]} /></div>
    <p>{item.kind}</p>
    <p className="mau-muted">{item.assignedAgents?.length ? (zh ? "授权后，以下员工可在任务中只读访问：" : "After consent, these Agents can read this account during tasks: ") + item.assignedAgents.map(id => agents.find(a => a.agent.id === id)?.agent.name ?? id).join("、") : zh ? "此账号尚未分配给员工。" : "This account has not been assigned to an Agent."}</p>
    {item.assignedAgents?.length ? <p className="mau-muted">{zh ? "不会发送、修改或删除内容；未启用后台任务。" : "Sending, modifying and deleting are unavailable. Background tasks are not enabled."}</p> : null}
    {current.verification === "oauth" ? <p className="mau-muted">{zh ? "OAuth 授权已验证；各产品 API 的可用性仍需实际调用确认。" : "OAuth verified; individual product APIs still require a live check."}</p> : null}
    {!!current.scopes.length && <details><summary>{zh ? "账号已授予的范围" : "Granted account scopes"}</summary><ul>{current.scopes.map(scope => <li key={scope}>{scope}</li>)}</ul></details>}
    {url && !mustCheck ? <div><a href={url} rel="noreferrer">{zh ? "继续前往服务商授权" : "Continue authorization with provider"}</a><p className="mau-muted">{zh ? "授权完成后返回 Mau。" : "Return to Mau after consent."}{current.expiresAt ? ` ${new Date(current.expiresAt).toLocaleString()}` : ""}</p></div> : null}
    {action.isError ? <p role="alert">{zh ? "操作未能确认完成。请先检查授权状态，再决定下一步；不会自动重试。" : "The outcome could not be confirmed. Check authorization before another action; no automatic retry will occur."}</p> : null}
    {confirmDisconnect ? <div>
      <p>{zh ? `断开 ${item.label} 将清除此连接保存的授权，并拒绝尚未批准的写入。服务商保留的授权需在其账号设置中撤销。` : `Disconnecting ${item.label} clears its saved authorization and denies pending writes. Revoke the provider grant in its account settings separately.`}</p>
      <div className="mau-connection-actions"><Button disabled={action.isPending} onClick={() => action.mutate("disconnect")}>{zh ? "确认断开" : "Confirm disconnect"}</Button><Button disabled={action.isPending} onClick={() => setConfirmDisconnect(false)}>{zh ? "取消" : "Cancel"}</Button></div>
    </div> : <div className="mau-connection-actions">
      <Button disabled={action.isPending} onClick={() => action.mutate("check")}>{action.isPending ? zh ? "处理中…" : "Working…" : zh ? "检查授权" : "Check authorization"}</Button>
      {current.state !== "connected" && current.state !== "needs_setup" ? <Button disabled={action.isPending || mustCheck} onClick={() => action.mutate("connect")}>{zh ? "授权账号" : "Authorize account"}</Button> : null}
      {current.state !== "disconnected" && current.state !== "needs_setup" ? <Button disabled={action.isPending || mustCheck} onClick={() => setConfirmDisconnect(true)}>{zh ? "断开账号" : "Disconnect account"}</Button> : null}
    </div>}
  </article>;
}
export function ConnectorsScreen({ session }: { session: Session }) {
  const { language, t } = useI18n(), zh = language === "zh-CN";
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"connected" | "available">("connected");
  const [connecting, setConnecting] = useState<AgentSummary>();
  const agents = useQuery({ queryKey: ["agents", session.owner], queryFn: mauApi(session.token).agents });
  const business = useQuery({ queryKey: ["connectors", session.owner], queryFn: mauApi(session.token).connectors, retry: false });
  const accounts = useQuery({ queryKey: ["connector-accounts", session.owner], queryFn: mauApi(session.token).connectorAccounts, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const checks = useMutation({ mutationFn: (id: string) => routerApi(session.token).check(id) });
  const error = accounts.error ?? business.error ?? agents.error ?? checks.error;
  const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase());
  const channels = agents.data?.filter(agent => matches(agent.agent.name + " " + agent.connections.map(c => c.kind).join(" "))) ?? [];
  const reads = business.data?.filter(item => matches("业务数据 business data feishu " + (agents.data?.find(a => a.agent.id === item.agentId)?.agent.name ?? ""))) ?? [];
  const accountItems = accounts.data?.data.filter(item => matches(item.label + " " + item.kind)) ?? [];
  return <main className="mau-connections">
    <PageHeader title={zh ? "连接器" : "Connectors"} description={zh ? "管理员工使用的工具、数据与通信渠道。" : "Manage the tools, data and channels your Agents use."} />
    <div className="mau-connection-toolbar">
      <div role="group" aria-label={zh ? "连接器分类" : "Connection categories"}>
        <Button aria-pressed={tab === "connected"} onClick={() => setTab("connected")}>{zh ? "已配置" : "Configured"}</Button>
        <Button aria-pressed={tab === "available"} onClick={() => setTab("available")}>{zh ? "添加连接" : "Add a connection"}</Button>
      </div>
      <SearchField value={query} onChange={setQuery} placeholder={zh ? "搜索连接器或员工" : "Search connectors or Agents"} />
    </div>
    {error ? <p role="alert" className="mau-error">{errorMessage(t, error instanceof ApiError ? error.code : "request_failed")} <Button onClick={() => { void business.refetch(); void agents.refetch(); void accounts.refetch(); }}>{zh ? "重新加载" : "Reload"}</Button></p> : null}
    {accounts.isPending ? <p role="status">{zh ? "正在读取账号连接…" : "Loading account connections…"}</p> : null}
    {tab === "connected" ? <div className="mau-connection-grid">
      {accountItems.map(item => <AccountCard key={item.id + JSON.stringify(item)} item={item} session={session} agents={agents.data ?? []} />)}
      {reads.map(item => { const agent = agents.data?.find(a => a.agent.id === item.agentId); return agent ? <BusinessCard key={item.agentId} item={item} agent={agent} session={session} /> : null; })}
      {channels.map(agent => <article key={agent.agent.id} className="mau-connection-card">
        <h2>{agent.agent.name}</h2><p className="mau-muted">{zh ? "通信渠道" : "Communication channels"}</p>
        <ul>{agent.connections.map(connection => <li key={connection.id}>{t(`channel.${connection.kind}`)}</li>)}</ul>
        {agent.connections.some(c => c.kind === "feishu" && c.personalTools) ? <FeishuAuthorizationRow session={session} agentId={agent.agent.id} /> : null}
        <div className="mau-connection-actions"><Button onClick={() => setConnecting(agent)}>{zh ? "添加渠道" : "Add channel"}</Button><Button disabled={checks.isPending} onClick={() => checks.mutate(agent.agent.id)}>{zh ? "检查渠道" : "Check channels"}</Button></div>
        {checks.variables === agent.agent.id && checks.data ? <ul>{checks.data.map((check, i) => <li key={i}>{check.kind}: {check.status} · {check.detail}</li>)}</ul> : null}
      </article>)}
      {!agents.isPending && !business.isPending && !accounts.isPending && !error && !accountItems.length && !reads.length && !channels.length ? <p>{zh ? "暂无匹配的连接器。" : "No matching connections."}</p> : null}
    </div> : <>
      <section className="mau-connection-card"><h2>{zh ? "连接通信渠道" : "Connect a channel"}</h2><p>{zh ? "通过飞书、微信、Telegram 或外部邮箱与员工协作。" : "Work with Agents through Feishu, WeChat, Telegram or an external mailbox."}</p>
        <div className="mau-connection-actions">{agents.data?.map(agent => <Button key={agent.agent.id} onClick={() => setConnecting(agent)}>{agent.agent.name}</Button>)}</div>
        {!agents.isPending && !agents.data?.length ? <p>{zh ? "先在通讯录创建员工。" : "Create an Agent in Contacts first."}</p> : null}
      </section>
      <p className="mau-muted">{accounts.data?.configured ? zh ? "已配置的账号入口在‘已配置’中管理。添加其他账号需先由管理员配置对应服务。" : "Manage configured accounts in Configured. Additional accounts require administrator setup." : zh ? "以下连接器已有组件实现，当前服务端尚未部署账号授权。" : "These connectors have component implementations; account authorization is not deployed on this server yet."}</p>
      {!accounts.data?.configured && <div className="mau-connection-grid">{products.filter(matches).map(name => <article key={name} className="mau-connection-card"><h2>{name}</h2><ProductStatus compact tone="neutral" label={zh ? "待服务端接入" : "Server setup required"} /><p className="mau-muted">{zh ? "接入完成后可在这里授权账号；员工工具权限将单独设置。" : "Once configured, authorize an account here. Agent tool access is a separate step."}</p></article>)}</div>}
    </>}
    {connecting ? <ConnectChannelDialog session={session} summary={connecting} onClose={() => setConnecting(undefined)} onConnected={() => { void agents.refetch(); }} /> : null}
  </main>;
}
