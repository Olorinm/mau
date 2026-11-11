import { useThemePreference } from "./theme";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, EmployeeAvatar, EmployeeAvatarAppearanceProvider, useToast } from "@olorinm/agent-ui/app";
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
import { AppsScreen, CreateAppScreen } from "./screens/product-pages";
import { SettingsModal } from "./settings/settings-modal";
import { openSettings, takeSettingsReturn, useSettingsRoute } from "./settings/route";
import {
  AppShell,
  Navigation,
  SaplingPlaceholder,
  FrontendProvider,
  frontendLabels,
  type FrontendLabelKey,
} from "@olorinm/agent-frontend";
import { ProductIcon } from "@olorinm/agent-ui/app";

export function App({ onExpired }: { onExpired(handler: () => void): void }) {
  const { t, language, setLanguage } = useI18n();
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
      if (result.mode === "edge") setSession(result.session);
    });
    return () => { active = false; };
  }, []);
  const [view, setView] = useState("messages");
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
  // `?agent=<id>` opens the conversation with that employee.
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
  const toggleLanguage = () =>
    setLanguage(language === "zh-CN" ? "en" : "zh-CN");

  if (!boot) return null;
  if (boot.mode === "edge-denied" || boot.mode === "edge-failed")
    return (
      <main className="mau-access-page" role="alert">
        <SaplingPlaceholder />
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
    navigation: "主导航",
    toggleNavigation: "展开或收起导航",
    back: "返回",
    loading: "加载中…",
    search: "搜索",
    clearSearch: "清空搜索",
    create: "新建",
    send: "发送",
    attachments: "附件",
    mention: "提及",
    close: "关闭",
    resizeNavigation: "调整主导航宽度",
    connected: "已连接",
    unavailable: "尚未接入",
    download: "下载",
    preview: "预览",
    edit: "编辑",
    open: "打开",
    empty: "暂无内容",
  };
  const groups = [
    {
      id: "native",
      label: zh ? "原生应用" : "Native apps",
      items: [
        {
          id: "messages",
          label: zh ? "对话" : "Conversations",
          icon: <ProductIcon name="rooms" />,
        },
      ],
    },
    {
      id: "my-apps",
      label: zh ? "我的 App" : "My apps",
      items: [
        {
          id: "create-app",
          label: zh ? "新建应用" : "Create app",
          icon: <ProductIcon name="add" />,
        },
      ],
    },
    {
      id: "resources",
      label: zh ? "资源" : "Resources",
      items: [
        {
          id: "apps",
          label: zh ? "App 商店" : "App Store",
          icon: <ProductIcon name="store" />,
        },
      ],
    },
    {
      id: "settings",
      items: [
        {
          id: "settings",
          label: zh ? "设置" : "Settings",
          icon: <ProductIcon name="settings" />,
        },
      ],
    },
  ];
  return (
    <FrontendProvider
      theme={theme}
      language={language}
      translate={(key) =>
        zh ? (labels[key] ?? frontendLabels[key]) : frontendLabels[key]
      }
    >
      <EmployeeAvatarAppearanceProvider appearance={avatarAppearance}>
      <AppShell
        brand={t("app.name")}
        logo={<SaplingPlaceholder />}
        navigation={
          <Navigation
            groups={groups}
            selectedId={view}
            onSelect={(id) =>
              id === "create-app" ? setCreateOpen(true)
                : id === "settings" ? openSettings({ section: matchMedia("(max-width: 640px)").matches ? null : "general" })
                : setView(id)
            }
            account={{
              name: session.edge.email ?? session.owner,
              avatar: (
                <EmployeeAvatar
                  seed={session.owner}
                  fallbackName={session.owner}
                  size={28}
                  appearance="illustrated"
                />
              ),
              label: zh ? "账号" : "Account",
              actions: [
                {
                  id: "language",
                  label: t("language.toggle"),
                  onSelect: toggleLanguage,
                },
                {
                  id: "logout",
                  label: t("account.logout"),
                  onSelect: signOut,
                },
              ],
            }}
          />
        }
      >
        {accessExpired ? (
          <div className="mau-access-banner" role="alert">
            <span>{t("access.expired")}</span>
            <Button variant="primary" onClick={reloadForAccess}>{t("access.relogin")}</Button>
          </div>
        ) : null}
        {view === "messages" ? (
          <MessagesScreen
            session={session}
            initialAgentId={conversationTarget}
            onStartHandled={() => setConversationTarget(undefined)}
          />
        ) : (
          <AppsScreen />
        )}
        {settingsRoute ? <SettingsModal session={session} route={settingsRoute} onSignOut={signOut} /> : null}
        <CreateAppScreen
          open={createOpen}
          onCancel={() => setCreateOpen(false)}
          onStore={() => {
            setCreateOpen(false);
            setView("apps");
          }}
        />
      </AppShell>
      </EmployeeAvatarAppearanceProvider>
    </FrontendProvider>
  );
}
