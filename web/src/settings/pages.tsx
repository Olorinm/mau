import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListRow, ProductIcon, SelectMenu, SettingsPage, SettingsSection, TextButton, useToast } from "@olorinm/agent-ui/app";
import { ApiError } from "../api/http";
import { ledgerApi, newIdempotencyKey, type ChatSummary } from "../api/ledger";
import type { Session } from "../api/session";
import { errorMessage, useI18n, type Language } from "../i18n";
import { useThemePreference } from "../theme";
import { useAvatarAppearance } from "../avatar";
import { privacyPolicyUrl } from "./connectors";
import { PurgeChatDialog } from "../screens/purge-chat-dialog";

/** 通用: language and theme. */
export function GeneralPage() {
  const { language, setLanguage } = useI18n(), zh = language === "zh-CN";
  const [theme, setTheme] = useThemePreference();
  const [avatar, setAvatar] = useAvatarAppearance();
  return <SettingsPage title={zh ? "通用" : "General"}>
    <SettingsSection>
      <ListRow title={zh ? "语言" : "Language"} trailing={<SelectMenu label={zh ? "语言" : "Language"} value={language}
        options={[{ value: "zh-CN", label: "简体中文" }, { value: "en", label: "English" }]} onChange={(value) => setLanguage(value as Language)} />} />
      <ListRow title={zh ? "外观" : "Appearance"} trailing={<SelectMenu label={zh ? "外观" : "Appearance"} value={theme}
        options={[{ value: "system", label: zh ? "跟随系统" : "System" }, { value: "light", label: zh ? "浅色" : "Light" }, { value: "dark", label: zh ? "深色" : "Dark" }]}
        onChange={setTheme} />} />
      <ListRow title={zh ? "员工头像" : "Employee avatars"} trailing={<SelectMenu label={zh ? "员工头像" : "Employee avatars"} value={avatar}
        options={[{ value: "pixel", label: zh ? "像素小动物" : "Pixel animals" }, { value: "illustrated", label: zh ? "插画" : "Illustrated" }]}
        onChange={setAvatar} />} />
    </SettingsSection>
  </SettingsPage>;
}

/** 扩展: Skills, MCP and other kernel extensions. Graphical management is not connected yet. */
export function ExtensionsPage() {
  const { language } = useI18n(), zh = language === "zh-CN";
  const rows: Array<[string, Parameters<typeof ProductIcon>[0]["name"]]> = [["Skills", "tools"], ["MCP", "network"], [zh ? "内核插件" : "Kernel plugins", "extensions"],
    ["Hooks", "refresh"], ["Tools", "tools"], ["CLI", "kernel"]];
  return <SettingsPage title={zh ? "扩展" : "Extensions"}>
    <SettingsSection note={zh ? "Mau 尚未接入图形化扩展管理。员工可以在自己的环境里安装和使用这些扩展。" : "Graphical extension management is not connected to Mau yet. Agents can install and use extensions in their own environment."}>
      {rows.map(([label, icon]) => <ListRow key={label} icon={<span className="mau-settings-glyph"><ProductIcon name={icon} size={18} /></span>}
        title={label} trailing={<span>{zh ? "尚未接入" : "Not connected"}</span>} />)}
    </SettingsSection>
  </SettingsPage>;
}

/** 数据控制: permanently clear a chat's history through Router's ledger purge. There is no export API yet. */
export function DataControlsPage({ session }: { session: Session }) {
  const { language, t } = useI18n(), zh = language === "zh-CN";
  const { toast } = useToast();
  const api = ledgerApi(session.token);
  const chats = useQuery({ queryKey: ["data-control-chats", session.owner], queryFn: ({ signal }) => api.chats(null, signal) });
  const [purging, setPurging] = useState<ChatSummary>();
  const writable = (chats.data?.data ?? []).filter((chat) => !chat.readOnly);
  return <SettingsPage title={zh ? "数据控制" : "Data controls"}>
    <SettingsSection title={zh ? "聊天记录" : "Chat history"}
      note={zh ? "清空会永久删除你在所有渠道（网页、飞书、邮件等）与该员工或群聊的记录，并开始新对话；员工已经写入的记忆不会被删除。"
        : "Clearing permanently deletes your messages in that chat on every channel and starts a new chat; memories the Agent already wrote are kept."}>
      {chats.isPending ? <ListRow muted title={zh ? "正在读取…" : "Loading…"} />
        : chats.isError ? <ListRow muted title={errorMessage(t, chats.error instanceof ApiError ? chats.error.code : "request_failed")} />
        : writable.length ? writable.map((chat) => <ListRow key={chat.chatId} title={chat.title}
          trailing={<TextButton tone="danger" onClick={() => setPurging(chat)}>{zh ? "清空" : "Clear"}</TextButton>} />)
        : <ListRow muted title={zh ? "还没有聊天记录。" : "No chats yet."} />}
    </SettingsSection>
    <PurgeChatDialog chat={purging} onClose={() => setPurging(undefined)}
      purge={(chatId, cancelActive) => api.purge(chatId, chatId, newIdempotencyKey(), cancelActive)}
      onPurged={(chat) => { toast({ kind: "success", title: zh ? `已清空与 ${chat.title} 的聊天记录` : `Cleared the history with ${chat.title}` }); void chats.refetch(); }} />
  </SettingsPage>;
}

/** 帮助与法律: the public privacy policy and contact. */
export function HelpPage() {
  const { language } = useI18n(), zh = language === "zh-CN";
  const link = (href: string, label: string) => <a className="agent-text-button" href={href} target="_blank" rel="noopener noreferrer">{label}<ProductIcon name="external" size={14} /></a>;
  return <SettingsPage title={zh ? "帮助与法律" : "Help and legal"}>
    <SettingsSection>
      <ListRow title={zh ? "隐私政策" : "Privacy policy"} trailing={link(privacyPolicyUrl, zh ? "查看" : "View")} />
      <ListRow title={zh ? "Mau 网站" : "Mau website"} trailing={link("https://www.openmau.com/", "openmau.com")} />
      <ListRow title={zh ? "联系我们" : "Contact"} trailing={<a className="agent-text-button" href="mailto:hello@openmau.com">hello@openmau.com</a>} />
    </SettingsSection>
  </SettingsPage>;
}
