import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, useToast } from "@olorinm/agent-ui/app";
import { clearSession, loadSession, logout, saveSession, type Session } from "./api/session";
import { errorMessage, useI18n } from "./i18n";
import { LoginScreen } from "./screens/login";
import { AgentsScreen } from "./screens/agents";
import { FilesScreen } from "./screens/files";
import { MessagesScreen } from "./screens/messages";
import { AppShell, Navigation, SaplingPlaceholder, FrontendProvider, frontendLabels, type FrontendLabelKey } from "@olorinm/agent-frontend";
import { ProductIcon } from "@olorinm/agent-ui/app";

export function App({ onExpired }: { onExpired(handler: () => void): void }) {
  const { t, language, setLanguage } = useI18n();
  const { toast } = useToast();
  const queries = useQueryClient();
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [view, setView] = useState("agents");
  const current = useRef(session);
  current.current = session;
  useEffect(() => onExpired(() => {
    if (!current.current) return;
    toast({ kind: "error", title: errorMessage(t, "account_session_invalid") });
    clearSession();
    queries.clear();
    setSession(null);
  }), [onExpired, queries, t, toast]);
  const signIn = (next: Session) => { saveSession(next); setSession(next); };
  const signOut = async () => {
    if (session) await logout(session);
    queries.clear();
    setSession(null);
  };
  const toggleLanguage = () => setLanguage(language === "zh-CN" ? "en" : "zh-CN");

  if (!session) return <LoginScreen onSignedIn={signIn} onToggleLanguage={toggleLanguage} />;
  const zh = language === "zh-CN";
  const labels: Partial<Record<FrontendLabelKey,string>> = {navigation:"主导航",toggleNavigation:"展开或收起导航",back:"返回",loading:"加载中…"};
  const entries = [
    {id:"messages",label:zh?"消息":"Messages",icon:<ProductIcon name="rooms"/>},
    {id:"agents",label:t("agents.title"),icon:<ProductIcon name="contacts"/>},
    {id:"files",label:zh?"文件":"Files",icon:<ProductIcon name="archive"/>},
    {id:"apps",label:zh?"应用":"Apps",icon:<ProductIcon name="store"/>},
    {id:"extensions",label:zh?"扩展":"Extensions",icon:<ProductIcon name="extensions"/>},
    {id:"settings",label:zh?"设置":"Settings",icon:<ProductIcon name="settings"/>},
  ];
  return <FrontendProvider translate={key => zh ? labels[key] ?? frontendLabels[key] : frontendLabels[key]}>
    <AppShell brand={t("app.name")} logo={<SaplingPlaceholder/>}
      navigation={<Navigation items={entries} selectedId={view} onSelect={setView}/>}
      toolbar={<div className="mau-account"><span className="mau-owner" title={session.owner}>{session.owner}</span>
        <Button onClick={toggleLanguage}>{t("language.toggle")}</Button><Button onClick={() => void signOut()}>{t("account.logout")}</Button></div>}>
      {view === "agents" ? <AgentsScreen session={session}/> : view === "messages" ? <MessagesScreen session={session}/> : view === "files" ? <FilesScreen session={session}/>
        : <section className="mau-unconnected"><EmptyState illustration="sprout" title={zh?"尚未接入":"Not connected yet"}
            description={zh?`${entries.find(item=>item.id===view)?.label}暂未接入 Mau。`: `${entries.find(item=>item.id===view)?.label} is not connected to Mau yet.`}/></section>}
    </AppShell>
  </FrontendProvider>;
}
