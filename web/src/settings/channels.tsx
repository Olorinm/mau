import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ListRow, SettingsPage, SettingsSection, StatusLine, TextButton, useToast } from "@olorinm/agent-ui/app";
import { mauApi, routerApi, type AgentSummary, type ChannelKind } from "../api/client";
import type { Session } from "../api/session";
import { useI18n } from "../i18n";
import { ConnectChannelFlow } from "../screens/connect-channel";
import { AppMark, channelKinds } from "./app-marks";
import { feishuPersonalState, useAgents, useConnectorAccounts } from "./connectors";
import { openSettings } from "./route";

/** 消息渠道: each Agent's chat channels (Feishu chat, WeChat, Telegram, mail), connected with Router's flows in place. */
export function ChannelsPage({ session }: { session: Session }) {
  const { language, t } = useI18n(), zh = language === "zh-CN";
  const { toast } = useToast();
  const agents = useAgents(session);
  const accounts = useConnectorAccounts(session);
  const [connecting, setConnecting] = useState<{ agent: AgentSummary; kind: ChannelKind }>();
  const check = useMutation({ mutationFn: (input: { agent: AgentSummary; kind: ChannelKind }) => routerApi(session.token).check(input.agent.agent.id),
    onSuccess: (checks, input) => {
      const mine = checks.filter((item) => item.kind === input.kind);
      const ok = mine.length > 0 && mine.every((item) => item.status === "verified");
      toast({ kind: ok ? "success" : "error", title: ok ? zh ? `${t(`channel.${input.kind}`)}连接正常` : `${t(`channel.${input.kind}`)} is working`
        : mine.map((item) => item.detail).join(" · ") || (zh ? "连接需要处理" : "The connection needs attention") });
    },
    onError: () => toast({ kind: "error", title: zh ? "连接检查失败，请稍后重试。" : "Connection check failed. Try again later." }) });
  const active = (agents.data ?? []).filter((agent) => agent.environment?.state !== "deleted");
  const kinds = channelKinds;
  const personal = (agentId: string) => accounts.data?.data.find((account) => account.kind === "feishu" && account.assignedAgents?.includes(agentId));

  if (connecting) return <SettingsPage onBack={() => setConnecting(undefined)} backLabel={zh ? "消息渠道" : "Messaging"}
    title={zh ? `连接${t(`channel.${connecting.kind}`)}` : `Connect ${t(`channel.${connecting.kind}`)}`}>
    <div className="mau-settings-flow">
      <p className="mau-settings-note">{zh ? `连接到 ${connecting.agent.agent.name}` : `For ${connecting.agent.agent.name}`}</p>
      <ConnectChannelFlow session={session} summary={connecting.agent} initialKind={connecting.kind} title={() => null}
        onClose={() => setConnecting(undefined)} onConnected={() => {
          // The new Feishu chat app goes straight to the owner's personal connection; authorizing it is the next step.
          const account = connecting.kind === "feishu" ? personal(connecting.agent.agent.id) : undefined;
          const handover = account ? mauApi(session.token).feishuApplication(account.id, connecting.agent.agent.id).catch(() => undefined) : Promise.resolve();
          void handover.then(() => { void agents.refetch(); void accounts.refetch(); });
        }} />
    </div>
  </SettingsPage>;

  return <SettingsPage title={zh ? "消息渠道" : "Messaging"}>
    {agents.isPending ? <p className="mau-settings-note" role="status">{zh ? "正在读取…" : "Loading…"}</p> : null}
    {agents.isSuccess && !active.length ? <SettingsSection>
      <ListRow muted title={zh ? "先在通讯录创建一个员工，再连接消息渠道。" : "Create an Agent in Contacts to connect a channel."} />
    </SettingsSection> : null}
    {active.map((agent) => <SettingsSection key={agent.agent.id} title={agent.agent.name}>
      {kinds.map((kind) => {
        const connected = agent.connections.some((connection) => connection.kind === kind);
        const account = kind === "feishu" ? personal(agent.agent.id) : undefined;
        return <ListRow key={kind} icon={<AppMark id={kind} />} title={t(`channel.${kind}`)}
          subtitle={<>{connected ? <StatusLine tone="success">{zh ? "已连接" : "Connected"}</StatusLine> : <StatusLine>{zh ? "未连接" : "Not connected"}</StatusLine>}
            {kind === "feishu" && account ? <span className="mau-status-extra">{feishuPersonalState(account, zh)}</span> : null}</>}
          trailing={<>
            {kind === "feishu" && account ? <TextButton onClick={() => openSettings({ section: "connectors", item: "feishu" })}>{zh ? "个人权限" : "Personal access"}</TextButton> : null}
            {connected
              ? <><TextButton disabled={check.isPending} aria-label={zh ? `检查${t(`channel.${kind}`)}` : `Check ${t(`channel.${kind}`)}`}
                  onClick={() => check.mutate({ agent, kind })}>{zh ? "检查" : "Check"}</TextButton></>
              : <TextButton aria-label={zh ? `连接${t(`channel.${kind}`)}` : `Connect ${t(`channel.${kind}`)}`} onClick={() => setConnecting({ agent, kind })}>{zh ? "连接" : "Connect"}</TextButton>}
          </>} />;
      })}
    </SettingsSection>)}
    <p className="mau-settings-note">{zh ? "飞书聊天使用机器人身份；个人权限在「连接器 → 飞书」中授权，以你的身份读取文档、日历和邮件，只在你与员工的私聊中可用。"
      : "Feishu chat uses the bot. Personal access is authorized in Connectors → Feishu; it acts as you and works only in your private chats."}</p>
  </SettingsPage>;
}
