import { useThemePreference } from "./theme";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, EmployeeAvatar, useToast } from "@olorinm/agent-ui/app";
import {
  clearSession,
  loadSession,
  logout,
  saveSession,
  type Session,
} from "./api/session";
import { errorMessage, useI18n } from "./i18n";
import { LoginScreen } from "./screens/login";
import { AgentsScreen } from "./screens/agents";
import { MessagesScreen } from "./screens/messages";
import { ConnectorsScreen } from "./screens/connectors";
import {
  AppsScreen,
  CreateAppScreen,
  ExtensionsScreen,
  FilesScreen,
  SettingsScreen,
} from "./screens/product-pages";
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
  const { toast } = useToast();
  const queries = useQueryClient();
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [view, setView] = useState(() =>
    new URLSearchParams(location.search).has("agent") ? "agents" : "messages",
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [conversationTarget, setConversationTarget] = useState<string>();
  const current = useRef(session);
  current.current = session;
  useEffect(
    () =>
      onExpired(() => {
        if (!current.current) return;
        toast({
          kind: "error",
          title: errorMessage(t, "account_session_invalid"),
        });
        clearSession();
        queries.clear();
        setSession(null);
      }),
    [onExpired, queries, t, toast],
  );
  const signIn = (next: Session) => {
    saveSession(next);
    setSession(next);
  };
  const signOut = async () => {
    if (session) await logout(session);
    queries.clear();
    setSession(null);
  };
  const toggleLanguage = () =>
    setLanguage(language === "zh-CN" ? "en" : "zh-CN");

  if (!session)
    return (
      <LoginScreen onSignedIn={signIn} onToggleLanguage={toggleLanguage} />
    );
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
          id: "employees",
          label: t("agents.title"),
          icon: <ProductIcon name="rooms" />,
        },
        {
          id: "files",
          label: zh ? "文件" : "Files",
          icon: <ProductIcon name="archive" />,
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
      id: "configuration",
      label: zh ? "配置" : "Configuration",
      items: [
        { id: "connectors", label: zh ? "连接器" : "Connectors", icon: <ProductIcon name="network" /> },
        {
          id: "extensions",
          label: zh ? "扩展" : "Extensions",
          icon: <ProductIcon name="extensions" />,
        },
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
      <AppShell
        brand={t("app.name")}
        logo={<SaplingPlaceholder />}
        navigation={
          <Navigation
            groups={groups}
            selectedId={
              view === "messages" || view === "agents" ? "employees" : view
            }
            onSelect={(id) =>
              id === "create-app"
                ? setCreateOpen(true)
                : setView(id === "employees" ? "messages" : id)
            }
            account={{
              name: session.owner,
              avatar: (
                <EmployeeAvatar
                  seed={session.owner}
                  fallbackName={session.owner}
                  size={28}
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
                  onSelect: () => void signOut(),
                },
              ],
            }}
          />
        }
      >
        {view === "agents" ? (
          <AgentsScreen
            session={session}
            onMessages={(id) => {
              setConversationTarget(id);
              setView("messages");
            }}
          />
        ) : view === "messages" ? (
          <MessagesScreen
            session={session}
            initialAgentId={conversationTarget}
            onStartHandled={() => setConversationTarget(undefined)}
            onContacts={() => setView("agents")}
          />
        ) : view === "files" ? (
          <FilesScreen />
        ) : view === "extensions" ? (
          <ExtensionsScreen />
        ) : view === "connectors" ? (
          <ConnectorsScreen session={session} />
        ) : view === "settings" ? (
          <SettingsScreen />
        ) : (
          <AppsScreen />
        )}
        <CreateAppScreen
          open={createOpen}
          onCancel={() => setCreateOpen(false)}
          onStore={() => {
            setCreateOpen(false);
            setView("apps");
          }}
        />
      </AppShell>
    </FrontendProvider>
  );
}
