import { useState } from "react";
import { ProductIcon, SettingsDialog, useSettingsPageLayout, type SettingsNavItem } from "@olorinm/agent-ui/app";
import type { Session } from "../api/session";
import { useI18n } from "../i18n";
import { IdentitySettings } from "../screens/identity-settings";
import { ChannelsPage } from "./channels";
import { ConnectorsPage } from "./connectors";
import { DataControlsPage, ExtensionsPage, GeneralPage, HelpPage } from "./pages";
import { closeSettings, openSettings, type SettingsRoute, type SettingsSection } from "./route";

/** 设置 as a modal over the app; its page follows the URL hash (`#/settings/connectors/gmail`). */
export function SettingsModal({ session, route, onSignOut }: { session: Session; route: SettingsRoute; onSignOut(): void }) {
  const { language } = useI18n(), zh = language === "zh-CN";
  const items: SettingsNavItem[] = [
    { id: "general", label: zh ? "通用" : "General", icon: <ProductIcon name="settings" /> },
    { id: "connectors", label: zh ? "连接器" : "Connectors", icon: <ProductIcon name="apps" /> },
    { id: "channels", label: zh ? "消息渠道" : "Messaging", icon: <ProductIcon name="chat" /> },
    { id: "identity", label: zh ? "身份与配对" : "Identities and pairing", icon: <ProductIcon name="identity" /> },
    { id: "extensions", label: zh ? "扩展" : "Extensions", icon: <ProductIcon name="extensions" /> },
    { id: "data", label: zh ? "数据控制" : "Data controls", icon: <ProductIcon name="locked" /> },
    { id: "help", label: zh ? "帮助与法律" : "Help and legal", icon: <ProductIcon name="help" /> },
    { id: "logout", label: zh ? "退出" : "Sign out", icon: <ProductIcon name="logout" />, footer: true, onSelect: onSignOut },
  ];
  const page = (section: SettingsSection) => {
    switch (section) {
      case "general": return <GeneralPage />;
      case "connectors": return <ConnectorsPage session={session} {...(route.item ? { item: route.item } : {})} />;
      case "channels": return <ChannelsPage session={session} />;
      case "identity": return <IdentitySettings session={session} />;
      case "extensions": return <ExtensionsPage />;
      case "data": return <DataControlsPage session={session} />;
      case "help": return <HelpPage />;
    }
  };
  // Desktop always shows a page; on mobile a bare #/settings is the navigation list.
  const mobile = useSettingsPageLayout();
  // Choosing a section in the navigation always opens its first page, also when it is already selected.
  const [visit, setVisit] = useState(0);
  const section = route.section ?? (mobile ? null : "general");
  return <SettingsDialog open onOpenChange={(open) => { if (!open) closeSettings(); }} title={zh ? "设置" : "Settings"}
    items={items} selectedId={section} closeLabel={zh ? "关闭设置" : "Close settings"} backLabel={zh ? "返回" : "Back"}
    onSelect={(id) => { setVisit((count) => count + 1); openSettings(id ? { section: id as SettingsSection } : { section: null }, { replace: true }); }}>
    {section ? <div key={visit} style={{ display: "contents" }}>{page(section)}</div> : null}
  </SettingsDialog>;
}
