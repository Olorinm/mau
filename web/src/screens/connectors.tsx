import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, ProductStatus } from "@olorinm/agent-ui/app";
import { PageHeader, SearchField } from "@olorinm/agent-frontend";
import { mauApi, routerApi, type AgentSummary, type BusinessConnection } from "../api/client";
import type { Session } from "../api/session";
import { ApiError } from "../api/http";
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
export function ConnectorsScreen({ session }: { session: Session }) {
  const { language, t } = useI18n(), zh = language === "zh-CN";
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"connected" | "available">("connected");
  const [connecting, setConnecting] = useState<AgentSummary>();
  const agents = useQuery({ queryKey: ["agents", session.owner], queryFn: mauApi(session.token).agents });
  const business = useQuery({ queryKey: ["connectors", session.owner], queryFn: mauApi(session.token).connectors, retry: false });
  const checks = useMutation({ mutationFn: (id: string) => routerApi(session.token).check(id) });
  const error = business.error ?? agents.error ?? checks.error;
  const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase());
  const channels = agents.data?.filter(agent => matches(agent.agent.name + " " + agent.connections.map(c => c.kind).join(" "))) ?? [];
  const reads = business.data?.filter(item => matches("业务数据 business data feishu " + (agents.data?.find(a => a.agent.id === item.agentId)?.agent.name ?? ""))) ?? [];
  return <main className="mau-connections">
    <PageHeader title={zh ? "连接器" : "Connectors"} description={zh ? "管理员工使用的工具、数据与通信渠道。" : "Manage the tools, data and channels your Agents use."} />
    <div className="mau-connection-toolbar">
      <div role="group" aria-label={zh ? "连接器分类" : "Connection categories"}>
        <Button aria-pressed={tab === "connected"} onClick={() => setTab("connected")}>{zh ? "已配置" : "Configured"}</Button>
        <Button aria-pressed={tab === "available"} onClick={() => setTab("available")}>{zh ? "添加连接" : "Add a connection"}</Button>
      </div>
      <SearchField value={query} onChange={setQuery} placeholder={zh ? "搜索连接器或员工" : "Search connectors or Agents"} />
    </div>
    {error ? <p role="alert" className="mau-error">{errorMessage(t, error instanceof ApiError ? error.code : "request_failed")} <Button onClick={() => { void business.refetch(); void agents.refetch(); }}>{zh ? "重新加载" : "Reload"}</Button></p> : null}
    {tab === "connected" ? <div className="mau-connection-grid">
      {reads.map(item => { const agent = agents.data?.find(a => a.agent.id === item.agentId); return agent ? <BusinessCard key={item.agentId} item={item} agent={agent} session={session} /> : null; })}
      {channels.map(agent => <article key={agent.agent.id} className="mau-connection-card">
        <h2>{agent.agent.name}</h2><p className="mau-muted">{zh ? "通信渠道" : "Communication channels"}</p>
        <ul>{agent.connections.map(connection => <li key={connection.id}>{t(`channel.${connection.kind}`)}</li>)}</ul>
        {agent.connections.some(c => c.kind === "feishu" && c.personalTools) ? <FeishuAuthorizationRow session={session} agentId={agent.agent.id} /> : null}
        <div className="mau-connection-actions"><Button onClick={() => setConnecting(agent)}>{zh ? "添加渠道" : "Add channel"}</Button><Button disabled={checks.isPending} onClick={() => checks.mutate(agent.agent.id)}>{zh ? "检查渠道" : "Check channels"}</Button></div>
        {checks.variables === agent.agent.id && checks.data ? <ul>{checks.data.map((check, i) => <li key={i}>{check.kind}: {check.status} · {check.detail}</li>)}</ul> : null}
      </article>)}
      {!agents.isPending && !business.isPending && !reads.length && !channels.length ? <p>{zh ? "暂无匹配的连接器。" : "No matching connections."}</p> : null}
    </div> : <>
      <section className="mau-connection-card"><h2>{zh ? "连接通信渠道" : "Connect a channel"}</h2><p>{zh ? "通过飞书、微信、Telegram 或外部邮箱与员工协作。" : "Work with Agents through Feishu, WeChat, Telegram or an external mailbox."}</p>
        <div className="mau-connection-actions">{agents.data?.map(agent => <Button key={agent.agent.id} onClick={() => setConnecting(agent)}>{agent.agent.name}</Button>)}</div>
        {!agents.isPending && !agents.data?.length ? <p>{zh ? "先在通讯录创建员工。" : "Create an Agent in Contacts first."}</p> : null}
      </section>
      <p className="mau-muted">{zh ? "以下连接器已有组件实现，当前服务端尚未部署账号授权。" : "These connectors have component implementations; account authorization is not deployed on this server yet."}</p>
      <div className="mau-connection-grid">{products.filter(matches).map(name => <article key={name} className="mau-connection-card"><h2>{name}</h2><ProductStatus compact tone="neutral" label={zh ? "待服务端接入" : "Server setup required"} /><p className="mau-muted">{zh ? "接入完成后可在这里授权账号，并为指定员工开放权限。" : "Once configured, authorize an account here and assign access to specific Agents."}</p></article>)}</div>
    </>}
    {connecting ? <ConnectChannelDialog session={session} summary={connecting} onClose={() => setConnecting(undefined)} onConnected={() => { void agents.refetch(); }} /> : null}
  </main>;
}
