import { useThemePreference } from "./theme";
import { MauMark } from "./mau-mark";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, PartnerAvatar, PartnerAvatarAppearanceProvider, useToast } from "@olorinm/agent-ui/app";
import { useAvatarAppearance } from "./avatar";
import {
  bootSession,
  logout,
  reloadForAccess,
  type Boot,
  type Session,
} from "./api/session";
import { accessExpiredEvent } from "./api/http";
import { errorMessage, useI18n } from "./i18n";
import { MessagesScreen } from "./screens/messages";
import { CreateAppScreen } from "./screens/product-pages";
import { SettingsModal } from "./settings/settings-modal";
import { openSettings, takeSettingsReturn, useSettingsRoute } from "./settings/route";
import {
  AppShell,
  FrontendProvider,
  frontendLabels,
  type FrontendLabelKey,
} from "@olorinm/agent-ui/pages";
import { ProductIcon } from "@olorinm/agent-ui/app";

export function App({ onExpired }: { onExpired(handler: () => void): void }) {
  const { t, language } = useI18n();
  const [theme] = useThemePreference();
  const [avatarAppearance] = useAvatarAppearance();
  const { toast } = useToast();
  const queries = useQueryClient();
  const [boot, setBoot] = useState<Boot>();
  const [session, setSession] = useState<Session | null>(null);
  // Edge login (Cloudflare Access): no login page; an expired Access session shows a banner instead.
  const [accessExpired, setAccessExpired] = useState(false);
  useEffect(() => {
    let active = true;
    void bootSession().then((result) => {
      if (!active) return;
      setBoot(result);
      if (result.mode === "edge" || result.mode === "local") setSession(result.session);
    });
    return () => { active = false; };
  }, []);
  const settingsRoute = useSettingsRoute();
  // Landing parameters (the OAuth callback's ?view=connectors&oauth=…) apply once: they reopen the settings page the
  // owner started from, and are removed so a reload does not repeat them.
  useEffect(() => {
    const url = new URL(location.href), oauth = url.searchParams.get("oauth");
    if (!url.searchParams.has("view") && !oauth) return;
    const connectors = url.searchParams.get("view") === "connectors" || !!oauth;
    url.searchParams.delete("view");
    url.searchParams.delete("oauth");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    if (connectors) openSettings(takeSettingsReturn(), { replace: true });
    if (oauth === "connected") toast({ kind: "success", title: t("connectors.oauthConnected") });
    else if (oauth === "failed") toast({ kind: "error", title: t("connectors.oauthFailed") });
    else if (oauth === "cancelled") toast({ kind: "info", title: t("connectors.oauthCancelled") });
  }, [t, toast]);
  const [createOpen, setCreateOpen] = useState(false);
  // `?agent=<id>` opens the conversation with that partner.
  const [conversationTarget, setConversationTarget] = useState<string | undefined>(() => new URLSearchParams(location.search).get("agent") ?? undefined);
  const current = useRef(session);
  current.current = session;
  useEffect(() => {
    const expired = () => { if (current.current) setAccessExpired(true); };
    globalThis.addEventListener(accessExpiredEvent, expired);
    return () => globalThis.removeEventListener(accessExpiredEvent, expired);
  }, []);
  // A 401 means the Access session ended: there is no sign-in page to return to, the banner offers the re-login.
  useEffect(() => onExpired(() => { if (current.current) setAccessExpired(true); }), [onExpired]);
  const signOut = () => {
    if (!session) return;
    logout(session);
    queries.clear();
    setSession(null);
  };
  if (!boot) return null;
  if (boot.mode === "edge-denied" || boot.mode === "edge-failed")
    return (
      <main className="mau-access-page" role="alert">
        <MauMark size={72} />
        <h1>{boot.mode === "edge-denied" ? t("access.notConfigured", { email: boot.email ?? "" }) : t("access.failed")}</h1>
        <p className="mau-muted">{boot.mode === "edge-denied" ? t("access.notConfiguredHint") : errorMessage(t, boot.code)}</p>
        {boot.mode === "edge-denied"
          ? <Button variant="primary" onClick={() => location.assign(boot.logoutUrl)}>{t("access.switchAccount")}</Button>
          : <Button variant="primary" onClick={() => location.reload()}>{t("common.retry")}</Button>}
      </main>
    );
  if (!session) return null;
  const zh = language === "zh-CN";
  const labels: Partial<Record<FrontendLabelKey, string>> = {
    back: "返回",
    loading: "加载中…",
    search: "搜索",
    clearSearch: "清空搜索",
    create: "新建",
    send: "发送",
    attachments: "附件",
    mention: "提及",
    close: "关闭",
    connected: "已连接",
    unavailable: "尚未接入",
    download: "下载",
    preview: "预览",
    edit: "编辑",
    open: "打开",
    empty: "暂无内容",
  };
  // Where the owner can go: the conversations, the apps, and their own settings.
  const destinations = [
    { id: "messages", label: zh ? "对话" : "Conversations", icon: <ProductIcon name="rooms" /> },
    { id: "apps", label: zh ? "应用" : "Apps", icon: <ProductIcon name="store" /> },
    { id: "me", label: zh ? "我" : "Me", icon: <PartnerAvatar seed={session.owner} fallbackName={session.owner} size={24} appearance="illustrated" /> },
  ];
  return (
    <FrontendProvider
      theme={theme}
      language={language}
      translate={(key) =>
        zh ? (labels[key] ?? frontendLabels[key]) : frontendLabels[key]
      }
    >
      <PartnerAvatarAppearanceProvider appearance={avatarAppearance}>
      <AppShell
        logo={<MauMark />}
        label={zh ? "主导航" : "Navigation"}
        destinations={destinations}
        selectedId="messages"
        // No app service is connected yet, so the apps destination leads straight to making one.
        onSelect={(id) => {
          if (id === "apps") setCreateOpen(true);
          else if (id === "me") openSettings({ section: matchMedia("(max-width: 640px)").matches ? null : "general" });
        }}
      >
        {accessExpired ? (
          <div className="mau-access-banner" role="alert">
            <span>{t("access.expired")}</span>
            <Button variant="primary" onClick={reloadForAccess}>{t("access.relogin")}</Button>
          </div>
        ) : null}
        <MessagesScreen
          session={session}
          initialAgentId={conversationTarget}
          onStartHandled={() => setConversationTarget(undefined)}
        />
        {settingsRoute ? <SettingsModal session={session} route={settingsRoute} onSignOut={signOut} /> : null}
        <CreateAppScreen
          open={createOpen}
          onCancel={() => setCreateOpen(false)}
        />
      </AppShell>
      </PartnerAvatarAppearanceProvider>
    </FrontendProvider>
  );
}
