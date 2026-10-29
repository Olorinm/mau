import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, ProductIcon, ProductStatus } from "@olorinm/agent-ui/app";
import { SearchField } from "@olorinm/agent-frontend";
import { mauApi, routerApi, type AgentSummary, type BusinessConnection, type ChannelKind, type ConnectorAccount } from "../api/client";
import type { Session } from "../api/session";
import { ApiError, safeExternalUrl } from "../api/http";
import { errorMessage, useI18n } from "../i18n";
import { ConnectChannelDialog } from "./connect-channel";
import { FeishuAuthorizationRow } from "./feishu-authorization";

type Product = { id: string; name: string; en?: string; description: string; descriptionEn: string; group: "work" | "knowledge" | "channels"; channel?: ChannelKind };
const catalog: Product[] = [
  { id: "gmail", name: "Gmail", description: "查找邮件、阅读往来，把重要信息带进对话。", descriptionEn: "Find emails and bring important conversations into your work.", group: "work" },
  { id: "calendar", name: "Google 日历", en: "Google Calendar", description: "把日程、会议与待办安排在一起。", descriptionEn: "Bring your events and meeting schedule together.", group: "work" },
  { id: "drive", name: "Google 云端硬盘", en: "Google Drive", description: "查找文件，获取工作所需的资料。", descriptionEn: "Find files and the information you need.", group: "knowledge" },
  { id: "docs", name: "Google 文档", en: "Google Docs", description: "读取文档，让员工了解项目上下文。", descriptionEn: "Bring document context into your conversations.", group: "knowledge" },
  { id: "sheets", name: "Google 表格", en: "Google Sheets", description: "读取表格，理解和分析数据。", descriptionEn: "Read spreadsheets and understand your data.", group: "knowledge" },
  { id: "slides", name: "Google 幻灯片", en: "Google Slides", description: "阅读演示文稿，提取关键信息。", descriptionEn: "Read presentations and find the key points.", group: "knowledge" },
  { id: "notion", name: "Notion", description: "连接笔记、文档与团队知识。", descriptionEn: "Connect notes, documents and team knowledge.", group: "knowledge" },
  { id: "github", name: "GitHub", description: "了解代码仓库与项目进展。", descriptionEn: "Keep up with repositories and project progress.", group: "knowledge" },
  { id: "business", name: "业务数据", en: "Business data", description: "让员工查询已授权的业务信息。", descriptionEn: "Let Agents read your authorized business information.", group: "work" },
  { id: "feishu", name: "飞书", en: "Feishu", description: "在飞书里交流，让员工参与日常工作。", descriptionEn: "Work with your Agents in Feishu.", group: "channels", channel: "feishu" },
  { id: "weixin", name: "微信", en: "WeChat", description: "从微信发起对话，接收员工回复。", descriptionEn: "Chat with your Agents through WeChat.", group: "channels", channel: "weixin" },
  { id: "telegram", name: "Telegram", description: "通过 Telegram 与员工保持联系。", descriptionEn: "Keep in touch with your Agents on Telegram.", group: "channels", channel: "telegram" },
  { id: "matrix", name: "Matrix", description: "连接你的 Matrix 聊天账号。", descriptionEn: "Connect your Matrix conversations.", group: "channels", channel: "matrix" },
  { id: "grove-mail", name: "外部邮箱", en: "External mailbox", description: "通过现有邮箱服务与员工收发消息。", descriptionEn: "Exchange Agent messages through an existing mail service.", group: "channels", channel: "grove-mail" },
];

/** Local vector marks keep the catalog independent of third-party image requests. */
function AppMark({ id, large = false }: { id: string; large?: boolean }) {
  return <span className={`mau-app-mark mau-app-mark-${id}${large ? " mau-app-mark-large" : ""}`} aria-hidden="true">
    {id === "gmail" ? <svg viewBox="0 0 32 28" fill="none"><path d="M3 24V8l13 10L29 8v16" stroke="#4285f4" strokeWidth="5" strokeLinejoin="round"/><path d="M3 8V4l13 11L29 4v4" stroke="#ea4335" strokeWidth="5" strokeLinejoin="round"/><path d="M29 9v15" stroke="#34a853" strokeWidth="5"/><path d="M3 9v15" stroke="#c5221f" strokeWidth="5"/><path d="M29 4v6" stroke="#fbbc04" strokeWidth="5"/></svg>
      : id === "drive" ? <svg viewBox="0 0 32 30"><path d="M11 2h10l-10 18H1z" fill="#0f9d58"/><path d="m21 2 10 18H21L11 2z" fill="#f4b400"/><path d="M1 20h30l-5 9H6z" fill="#4285f4"/></svg>
      : id === "calendar" ? <span className="mau-calendar-mark">31</span>
      : ["docs", "sheets", "slides"].includes(id) ? <svg viewBox="0 0 28 32" fill="none"><path d="M5 1h12l6 6v23H5z" fill="currentColor"/><path d="M17 1v7h6" fill="white" opacity=".4"/>{id === "sheets" ? <path d="M9 14h10v10H9zm0 5h10m-5-5v10" stroke="white"/> : id === "slides" ? <path d="M8 14h12v9H8z" stroke="white" strokeWidth="2"/> : <path d="M9 15h10M9 19h10M9 23h7" stroke="white" strokeWidth="2"/>}</svg>
      : id === "notion" ? <span className="mau-letter-mark">N</span>
      : id === "github" ? <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.26-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03a9.6 9.6 0 0 1 5 0c1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.39.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.58 4.94.36.31.68.92.68 1.85v2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>
      : id === "feishu" ? <svg viewBox="0 0 32 32"><path d="m3 10 11 3 14-9-5 13-9 6z" fill="#3370ff"/><path d="m3 10 10 18 10-11-9 4z" fill="#00d6b9"/></svg>
      : id === "weixin" ? <ProductIcon name="chat" />
      : id === "telegram" ? <ProductIcon name="send" />
      : id === "business" ? <ProductIcon name="archive" />
      : <ProductIcon name={id === "matrix" ? "rooms" : "mention"} />}
  </span>;
}
function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mau-connector-section"><h2>{title}</h2><div className="mau-connector-panel">{children}</div></section>;
}
function PermissionRow({ label, value, enabled = false }: { label: string; value: string; enabled?: boolean }) {
  return <div className="mau-permission-row"><span>{label}</span><span className={enabled ? "mau-permission-enabled" : "mau-muted"}>{enabled && <ProductIcon name="check" />}{value}</span></div>;
}
function AccountDetail({ session, item, agents, changed }: { session: Session; item: ConnectorAccount; agents: AgentSummary[]; changed(item: ConnectorAccount): void }) {
  const { language } = useI18n(), zh = language === "zh-CN";
  const [confirmDisconnect, setConfirmDisconnect] = useState(false), [mustCheck, setMustCheck] = useState(false);
  const action = useMutation({ mutationFn: (name: "check" | "connect" | "disconnect") => mauApi(session.token).connectorAccountAction(item.id, name),
    onSuccess: (data, name) => { changed({ ...item, ...data }); setMustCheck(false); setConfirmDisconnect(false);
      const consent = safeExternalUrl(data.authorizationUrl);
      if (name === "connect" && consent) window.location.assign(consent);
    }, onError: () => { setMustCheck(true); setConfirmDisconnect(false); } });
  const connected = item.state === "connected", ready = connected && !mustCheck;
  const labels = zh ? { connected: "已连接", authorization_required: "尚未连接", authorization_pending: "等待完成授权", disconnected: "已断开", needs_setup: "暂未开放", needs_attention: "需要重新检查" }
    : { connected: "Connected", authorization_required: "Not connected", authorization_pending: "Finish authorization", disconnected: "Disconnected", needs_setup: "Coming soon", needs_attention: "Needs attention" };
  const assigned = item.assignedAgents?.map(id => agents.find(a => a.agent.id === id)?.agent.name).filter(Boolean) ?? [];
  const url = safeExternalUrl(item.authorizationUrl);
  return <>
    <section className="mau-connector-panel mau-account-panel" aria-label={zh ? "连接账号" : "Connected account"}>
      <div className="mau-account-summary"><span className="mau-account-symbol"><ProductIcon name={ready ? "check" : "contacts"} /></span><div><strong>{labels[item.state]}</strong><p>{zh ? ready ? "你的 Google 账号已授权给 Mau。" : "连接 Google 账号，让员工帮你处理邮件信息。" : ready ? "Your Google account is connected to Mau." : "Connect a Google account to work with your email."}</p></div></div>
      <div className="mau-connector-buttons">
        {!connected && item.state !== "needs_setup" && <Button variant="primary" disabled={action.isPending || mustCheck} onClick={() => action.mutate("connect")}>{action.isPending && action.variables === "connect" ? zh ? "正在前往 Google…" : "Opening Google…" : zh ? "连接 Gmail" : "Connect Gmail"}</Button>}
        <Button disabled={action.isPending} onClick={() => action.mutate("check")}><ProductIcon name="refresh" />{action.isPending && action.variables === "check" ? zh ? "检查中…" : "Checking…" : zh ? "检查连接" : "Check connection"}</Button>
      </div>
      {mustCheck && <p className="mau-error" role="alert">{zh ? "操作结果尚未确认。请先检查连接，再决定是否重试；不会自动重试。" : "The outcome is uncertain. Check the connection before trying again; no automatic retry will occur."}</p>}
      {url && !mustCheck && !connected && <a className="mau-consent-link" href={url} rel="noreferrer">{zh ? "继续前往 Google 授权" : "Continue to Google authorization"}</a>}
    </section>
    <DetailSection title={zh ? "读取权限" : "Read access"}>
      {(zh ? ["搜索邮件", "阅读邮件与会话", "查看草稿", "查看标签"] : ["Search email", "Read messages and threads", "View drafts", "View labels"]).map(label => <PermissionRow key={label} label={label} enabled={ready && assigned.length > 0} value={zh ? ready ? assigned.length ? "允许" : "未分配员工" : "连接后可用" : ready ? assigned.length ? "Allowed" : "No Agent assigned" : "Connect to enable"} />)}
    </DetailSection>
    <DetailSection title={zh ? "使用此连接的员工" : "Agents with access"}>
      {assigned.length ? assigned.map(name => <div className="mau-permission-row" key={name}><span className="mau-agent-access"><span className="mau-mini-avatar">{name!.slice(0,1).toUpperCase()}</span>{name}</span><span className="mau-muted">{zh ? "任务中只读" : "Read-only during tasks"}</span></div>) : <p className="mau-panel-note">{zh ? "暂未分配员工。" : "No Agent has been assigned."}</p>}
    </DetailSection>
    <DetailSection title={zh ? "写入与后台操作" : "Write and background access"}>
      <PermissionRow label={zh ? "发送、修改或删除邮件" : "Send, modify or delete email"} value={zh ? "未开放" : "Unavailable"} />
      <PermissionRow label={zh ? "后台同步" : "Background sync"} value={zh ? "未启用" : "Not enabled"} />
    </DetailSection>
    <p className="mau-detail-note">{zh ? "目前只申请邮件读取权限。你可以随时断开连接。" : "Only read access is requested. You can disconnect at any time."}</p>
    {(connected || item.state === "needs_attention" || mustCheck || confirmDisconnect) && <section className="mau-connector-panel mau-disconnect-panel">
      {confirmDisconnect ? <><p>{zh ? "断开后，Mau 将清除此连接保存的授权，员工无法继续访问邮箱。" : "Disconnecting removes the saved authorization and stops Agent access."}</p><div className="mau-connector-buttons"><Button disabled={action.isPending} onClick={() => action.mutate("disconnect")}>{zh ? "确认断开" : "Confirm disconnect"}</Button><Button onClick={() => setConfirmDisconnect(false)}>{zh ? "取消" : "Cancel"}</Button></div></> : <button className="mau-text-danger" disabled={action.isPending || mustCheck} onClick={() => setConfirmDisconnect(true)}>{zh ? "断开连接" : "Disconnect"}</button>}
    </section>}
  </>;
}
function BusinessDetail({ session, items, agents }: { session: Session; items: BusinessConnection[]; agents: AgentSummary[] }) {
  const { language } = useI18n(), zh = language === "zh-CN";
  const check = useMutation({ mutationFn: (id: string) => mauApi(session.token).checkConnector(id) });
  return <><DetailSection title={zh ? "已连接的员工" : "Connected Agents"}>{items.map(item => <div className="mau-business-entry" key={item.agentId}>
    <div className="mau-permission-row"><span>{agents.find(a => a.agent.id === item.agentId)?.agent.name ?? (zh ? "员工" : "Agent")}</span><span className="mau-muted">{zh ? "只读" : "Read-only"}</span></div>
    <p className="mau-panel-note">{zh ? `可查询 ${item.tools.length} 项业务工具${item.feishuBotRead ? "，并读取飞书机器人可访问的文件" : ""}。` : `${item.tools.length} business tools available${item.feishuBotRead ? ", with Feishu bot file access" : ""}.`}</p>
    <Button disabled={check.isPending} onClick={() => check.mutate(item.agentId)}>{zh ? "检查连接" : "Check connection"}</Button>
    {check.variables === item.agentId && check.isSuccess && <ProductStatus compact tone="success" label={zh ? "连接正常" : "Connection verified"} />}
    {check.variables === item.agentId && check.isError && <p role="alert">{zh ? "暂时无法检查，请稍后重试。" : "Could not verify the connection. Try again later."}</p>}
    <details className="mau-tools-disclosure"><summary>{zh ? "查看可用工具" : "View available tools"}</summary><ul>{item.tools.map(tool => <li key={tool}>{tool}</li>)}</ul></details>
  </div>)}</DetailSection></>;
}

export function ConnectorsScreen({ session }: { session: Session }) {
  const { language, t } = useI18n(), zh = language === "zh-CN";
  const [query, setQuery] = useState(""), [tab, setTab] = useState<"available" | "connected">("available");
  const [selected, setSelected] = useState<string>(), [connecting, setConnecting] = useState<{ agent: AgentSummary; kind: ChannelKind }>();
  const heading = useRef<HTMLHeadingElement>(null), content = useRef<HTMLDivElement>(null), queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ["agents", session.owner], queryFn: mauApi(session.token).agents });
  const business = useQuery({ queryKey: ["connectors", session.owner], queryFn: mauApi(session.token).connectors, retry: false });
  const accountsKey = ["connector-accounts", session.owner];
  const accounts = useQuery({ queryKey: accountsKey, queryFn: mauApi(session.token).connectorAccounts, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const checks = useMutation({ mutationFn: (id: string) => routerApi(session.token).check(id) });
  const error = accounts.error ?? business.error ?? agents.error;
  const activeAgents = (agents.data ?? []).filter(a => a.environment?.state !== "deleted");
  const linked = (p: Product) => activeAgents.filter(a => a.connections.some(c => c.kind === p.channel));
  const accountFor = (p: Product) => accounts.data?.data.filter(a => `${a.label} ${a.id}`.toLowerCase().includes(p.id)) ?? [];
  const connected = (p: Product) => p.channel ? linked(p).length > 0 : p.id === "business" ? !!business.data?.length : accountFor(p).some(a => a.state === "connected");
  const available = (p: Product) => !!p.channel || (p.id === "business" ? !!business.data?.length : accountFor(p).some(a => a.state !== "needs_setup"));
  const productName = (p: Product) => zh ? p.name : p.en ?? p.name;
  const description = (p: Product) => zh ? p.description : p.descriptionEn;
  const stateLabel = (p: Product) => connected(p) ? zh ? "已连接" : "Connected" : available(p) ? zh ? "连接" : "Connect" : zh ? "即将开放" : "Coming soon";
  const matches = (p: Product) => `${p.name} ${p.en ?? ""} ${p.id}`.toLowerCase().includes(query.trim().toLowerCase());
  const visible = catalog.filter(p => matches(p) && (tab === "available" || connected(p)));
  const chosen = catalog.find(p => p.id === selected);
  const featured = !query && tab === "available" ? catalog.filter(p => ["gmail", "feishu", "business"].includes(p.id) && available(p)) : [];
  const open = (p: Product) => setSelected(p.id);
  useEffect(() => { if (selected) { content.current?.scrollTo(0, 0); heading.current?.focus(); } }, [selected]);
  const row = (p: Product) => <button key={p.id} className="mau-catalog-row" onClick={() => open(p)} aria-label={`${productName(p)} ${stateLabel(p)}`}>
    <AppMark id={p.id} /><span className="mau-catalog-row-copy"><strong>{productName(p)}</strong><span>{description(p)}</span></span>
    <span className={`mau-catalog-state ${connected(p) ? "is-connected" : available(p) ? "is-available" : ""}`}>{connected(p) && <span className="mau-status-dot" />}{stateLabel(p)}</span><ProductIcon name="next" />
  </button>;
  return <main className="mau-connections" ref={content}>
    <div className={`mau-connectors-content${chosen ? " is-detail" : ""}`}>
      {chosen ? <>
        <button className="mau-connector-back" onClick={() => setSelected(undefined)}><ProductIcon name="back" />{zh ? "所有连接器" : "All connectors"}</button>
        <header className="mau-connector-hero"><AppMark id={chosen.id} large /><h1 ref={heading} tabIndex={-1}>{productName(chosen)}</h1><p>{description(chosen)}</p></header>
      </> : <>
        <header className="mau-connectors-heading"><h1>{zh ? "连接器" : "Connectors"}</h1><p>{zh ? "连接你常用的应用，让员工更了解你的工作。" : "Connect your everyday apps and give your Agents the context they need."}</p></header>
        <div className="mau-catalog-search"><SearchField value={query} onChange={setQuery} placeholder={zh ? "搜索连接器" : "Search connectors"} /></div>
        <div className="mau-catalog-tabs" role="group" aria-label={zh ? "连接器分类" : "Connector categories"}>
          <button aria-pressed={tab === "available"} onClick={() => setTab("available")}>{zh ? "可用" : "Available"}</button>
          <button aria-pressed={tab === "connected"} onClick={() => setTab("connected")}>{zh ? "已连接" : "Connected"}{!accounts.isPending && <span>{catalog.filter(connected).length}</span>}</button>
        </div>
      </>}
      {error && <div role="alert" className="mau-connector-error">{errorMessage(t, error instanceof ApiError ? error.code : "request_failed")}<Button onClick={() => { void business.refetch(); void agents.refetch(); void accounts.refetch(); }}>{zh ? "重新加载" : "Reload"}</Button></div>}
      {accounts.isPending && <p role="status" className="mau-detail-note">{zh ? "正在读取连接状态…" : "Loading connections…"}</p>}
      {chosen ? <>
        {chosen.channel ? <>
          <DetailSection title={zh ? "连接到员工" : "Connect to an Agent"}>
            {activeAgents.map(agent => { const has = agent.connections.some(c => c.kind === chosen.channel); return <div className="mau-channel-entry" key={agent.agent.id}>
              <div className="mau-permission-row"><span className="mau-agent-access"><span className="mau-mini-avatar">{agent.agent.name.slice(0,1).toUpperCase()}</span><strong>{agent.agent.name}</strong></span><Button disabled={checks.isPending} onClick={() => has ? checks.mutate(agent.agent.id) : setConnecting({ agent, kind: chosen.channel! })}>{has ? zh ? "检查连接" : "Check connection" : zh ? "连接" : "Connect"}</Button></div>
              {has && <span className="mau-channel-connected">{zh ? "已连接" : "Connected"}</span>}
              {has && chosen.channel === "feishu" && agent.connections.some(c => c.kind === "feishu" && c.personalTools) && <FeishuAuthorizationRow session={session} agentId={agent.agent.id} />}
              {checks.variables === agent.agent.id && checks.data && <p className="mau-panel-note" role="status">{checks.data.filter(c => c.kind === chosen.channel).map(c => c.detail).join(" · ") || (zh ? "检查完成" : "Check complete")}</p>}
              {checks.variables === agent.agent.id && checks.isError && <p role="alert">{zh ? "连接检查失败，请稍后重试。" : "Connection check failed. Try again later."}</p>}
            </div>; })}
            {!activeAgents.length && !agents.isPending && <p className="mau-panel-note">{zh ? "先在通讯录创建一个员工，再连接此应用。" : "Create an Agent in Contacts to connect this app."}</p>}
          </DetailSection>
        </> : chosen.id === "business" && business.data?.length ? <BusinessDetail session={session} items={business.data} agents={agents.data ?? []} />
          : accountFor(chosen).length ? accountFor(chosen).map(item => <AccountDetail key={item.id} session={session} item={item} agents={agents.data ?? []} changed={next => queryClient.setQueryData(accountsKey, (old: { configured: boolean; data: ConnectorAccount[] } | undefined) => old && ({ ...old, data: old.data.map(a => a.id === next.id ? next : a) }))} />)
          : !accounts.isPending && <div className="mau-connector-empty"><ProductIcon name="locked" /><h2>{zh ? "即将开放" : "Coming soon"}</h2><p>{zh ? "这个应用还没有开放账号连接，开放后可以直接在这里授权。" : "Account connections are not available yet. You will be able to connect here when it is ready."}</p></div>}
      </> : <>
        {!!featured.length && <section className="mau-catalog-section"><h2>{zh ? "从这里开始" : "Start here"}</h2><div className="mau-featured-apps">{featured.map(p => <button className="mau-featured-app" key={p.id} onClick={() => open(p)}><AppMark id={p.id} /><strong>{productName(p)}</strong><p>{description(p)}</p><span>{connected(p) ? zh ? "管理连接" : "Manage connection" : zh ? "了解并连接" : "Explore and connect"}<ProductIcon name="next" /></span></button>)}</div></section>}
        {([['work', zh ? "日常工作" : "Everyday work"], ['knowledge', zh ? "文件与知识" : "Files and knowledge"], ['channels', zh ? "消息渠道" : "Messaging"]] as const).map(([group, title]) => {
          const items = visible.filter(p => p.group === group);
          return items.length ? <section key={group} className="mau-catalog-section"><h2>{title}</h2><div className="mau-connector-panel mau-catalog-list">{items.map(row)}</div></section> : null;
        })}
        {!visible.length && !accounts.isPending && <div className="mau-connector-empty"><ProductIcon name={query ? "search" : "network"} /><h2>{zh ? query ? "没有找到连接器" : "还没有已连接的应用" : query ? "No connectors found" : "No connected apps yet"}</h2><p>{zh ? query ? "试试应用名称，例如 Gmail 或飞书。" : "到「可用」中选择你常用的应用。" : query ? "Try an app name, such as Gmail." : "Choose an app in Available to get started."}</p></div>}
      </>}
    </div>
    {connecting && <ConnectChannelDialog session={session} summary={connecting.agent} initialKind={connecting.kind} onClose={() => setConnecting(undefined)} onConnected={() => { void agents.refetch(); }} />}
  </main>;
}
