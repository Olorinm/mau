import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, ProductStatus } from "@olorinm/agent-ui/app";
import { mauApi, routerApi, type AgentSummary, type ConnectorAccount, type ConnectorAccountState } from "../api/client";
import { ApiError } from "../api/http";
import type { Session } from "../api/session";
import { errorMessage, useI18n } from "../i18n";
import { ConnectChannelDialog } from "./connect-channel";
import { LinkCode } from "./link-code";

/**
 * One 飞书 entry, two directions on the same Feishu app:
 * 1. 聊天 — Router's chat channel (bot identity), set up with Router's existing flow.
 * 2. 个人权限 — Agent Connectors acting as the owner (docs, calendar, mail…). The chat app is handed over to the
 *    connector, then the owner authorizes with the official device flow. No second app, no second QR for the app.
 */
export function FeishuEntry(props: { session: Session; agents: AgentSummary[]; accounts: ConnectorAccount[]; loading: boolean;
  changed(account: ConnectorAccount): void; agentsChanged(): void }) {
  const { language } = useI18n(), zh = language === "zh-CN";
  const [connecting, setConnecting] = useState<AgentSummary>();
  const personal = (agentId: string) => props.accounts.find(a => a.kind === "feishu" && a.assignedAgents?.includes(agentId));
  const handover = useMutation({ mutationFn: ({ account, agentId }: { account: ConnectorAccount; agentId: string }) =>
    mauApi(props.session.token).feishuApplication(account.id, agentId), onSuccess: (data, { account }) => props.changed({ ...account, ...data }) });
  return <>
    {props.agents.map(agent => <FeishuAgent key={agent.agent.id} session={props.session} agent={agent} account={personal(agent.agent.id)}
      changed={props.changed} connect={() => setConnecting(agent)} />)}
    {!props.agents.length && !props.loading && <p className="mau-panel-note">{zh ? "先在通讯录创建一个员工，再连接飞书。" : "Create an Agent in Contacts to connect Feishu."}</p>}
    <p className="mau-panel-note">{zh ? "聊天使用飞书机器人身份；个人权限以你的身份读取文档、日历、邮件等，修改前都需要你确认，并且只在你与员工的私聊中可用，群聊中不可用。"
      : "Chat uses the Feishu bot. Personal access acts as you (docs, calendar, mail); changes need your approval, and it works only in your private conversation with the Agent, never in groups."}</p>
    {connecting && <ConnectChannelDialog session={props.session} summary={connecting} initialKind="feishu"
      onClose={() => setConnecting(undefined)} onConnected={() => {
        props.agentsChanged();
        // The new chat app goes straight to the owner's Feishu connection; authorization is the next step.
        const account = personal(connecting.agent.id);
        if (account) handover.mutate({ account, agentId: connecting.agent.id });
      }} />}
  </>;
}

const stateLabel = (zh: boolean, account: ConnectorAccount | undefined, chat: boolean) => {
  if (!account) return zh ? "未开放" : "Unavailable";
  switch (account.state) {
    case "connected": return zh ? `已授权${account.name ? ` · ${account.name}` : ""}` : `Authorized${account.name ? ` · ${account.name}` : ""}`;
    case "expired": return zh ? "已过期" : "Expired";
    case "authorization_pending": return zh ? "等待你在飞书确认" : "Waiting for your confirmation";
    case "needs_setup": return chat ? (zh ? "未授权" : "Not authorized") : (zh ? "先连接聊天" : "Connect chat first");
    case "needs_attention": return zh ? "需要重新检查" : "Needs attention";
    default: return zh ? "未授权" : "Not authorized";
  }
};
const reasonText = (zh: boolean, reason: string | undefined) => reason === "refresh_token_expired" ? zh ? "授权已到期。" : "The authorization ran out."
  : reason === "token_revoked" ? zh ? "授权已被撤销。" : "The authorization was revoked." : zh ? "授权已失效。" : "The authorization is no longer valid.";

function FeishuAgent(props: { session: Session; agent: AgentSummary; account: ConnectorAccount | undefined; changed(account: ConnectorAccount): void; connect(): void }) {
  const { language, t } = useI18n(), zh = language === "zh-CN";
  const { agent, account } = props;
  const chat = agent.connections.find(c => c.kind === "feishu");
  const [link, setLink] = useState<string>();
  const update = (data: ConnectorAccountState) => {
    if (!account) return;
    props.changed({ ...account, ...data });
    setLink(data.state === "connected" ? undefined : data.authorizationUrl ?? (data.state === "authorization_pending" ? link : undefined));
  };
  const check = useMutation({ mutationFn: () => routerApi(props.session.token).check(agent.agent.id) });
  // Hand over the chat app (idempotent: the same app keeps an existing authorization), then start the device flow.
  const authorize = useMutation({
    mutationFn: async () => {
      const api = mauApi(props.session.token);
      await api.feishuApplication(account!.id, agent.agent.id);
      return api.connectorAccountAction(account!.id, "connect");
    },
    onSuccess: update,
  });
  const complete = useMutation({ mutationFn: () => mauApi(props.session.token).connectorAccountAction(account!.id, "complete"), onSuccess: update });
  // While the owner confirms in Feishu, finish the flow in the background; the button stays for impatient owners.
  const polling = useQuery({ queryKey: ["feishu-complete", account?.id, link], enabled: !!account && !!link,
    queryFn: () => mauApi(props.session.token).connectorAccountAction(account!.id, "complete"), refetchInterval: 4000, retry: false });
  useEffect(() => { if (polling.data) update(polling.data); }, [polling.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const error = [authorize.error, complete.error].find(Boolean);
  const connected = account?.state === "connected", expired = account?.state === "expired";
  const tone = connected ? "success" : expired || account?.state === "needs_attention" ? "error" : account?.state === "authorization_pending" ? "running" : "warning";
  return <div className="mau-channel-entry mau-feishu-entry">
    <div className="mau-permission-row"><span className="mau-agent-access"><span className="mau-mini-avatar">{agent.agent.name.slice(0, 1).toUpperCase()}</span><strong>{agent.agent.name}</strong></span></div>
    <div className="mau-permission-row" data-step="chat">
      <span>{zh ? "1 · 聊天" : "1 · Chat"}</span>
      <span className="mau-feishu-step">
        <ProductStatus compact tone={chat ? "success" : "warning"} label={chat ? zh ? "聊天已连接" : "Chat connected" : zh ? "未连接" : "Not connected"} />
        <Button disabled={check.isPending} onClick={() => chat ? check.mutate() : props.connect()}>{chat ? zh ? "检查连接" : "Check" : zh ? "连接聊天" : "Connect chat"}</Button>
      </span>
    </div>
    {check.data && <p className="mau-panel-note" role="status">{check.data.filter(c => c.kind === "feishu").map(c => c.detail).join(" · ") || (zh ? "检查完成" : "Check complete")}</p>}
    {check.isError && <p role="alert">{zh ? "连接检查失败，请稍后重试。" : "Connection check failed. Try again later."}</p>}
    {account ? <>
      <div className="mau-permission-row" data-step="personal">
        <span>{zh ? "2 · 个人权限" : "2 · Personal access"}</span>
        <span className="mau-feishu-step">
          <ProductStatus compact tone={tone} label={stateLabel(zh, account, !!chat)} />
          {!connected && <Button variant="primary" disabled={!chat || authorize.isPending} onClick={() => authorize.mutate()}>
            {authorize.isPending ? zh ? "正在准备…" : "Preparing…" : expired || account.state === "authorization_pending" ? zh ? "重新授权" : "Re-authorize" : zh ? "授权" : "Authorize"}</Button>}
        </span>
      </div>
      {expired && <p className="mau-error" role="alert">{reasonText(zh, account.reason)}{zh ? "员工暂时无法使用你的飞书文档、日历和邮件，请重新授权。" : " The Agent cannot use your Feishu docs, calendar or mail until you re-authorize."}</p>}
      {link && <div className="mau-inline-panel">
        <p className="mau-muted">{zh ? "用飞书扫码或打开链接，以你的身份授权。确认后这里会自动更新。" : "Scan with Feishu or open the link to authorize as yourself. This updates automatically."}</p>
        <LinkCode url={link} />
        <Button disabled={complete.isPending} onClick={() => complete.mutate()}>{t("feishu.complete")}</Button>
      </div>}
      {error && <p className="mau-error" role="alert">{errorMessage(t, error instanceof ApiError ? error.code : "request_failed")}</p>}
    </> : null}
  </div>;
}
