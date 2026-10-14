import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, useToast } from "@olorinm/agent-ui/app";
import { clearSession, loadSession, logout, saveSession, type Session } from "./api/session";
import { errorMessage, useI18n } from "./i18n";
import { LoginScreen } from "./screens/login";
import { AgentsScreen } from "./screens/agents";

export function App({ onExpired }: { onExpired(handler: () => void): void }) {
  const { t, language, setLanguage } = useI18n();
  const { toast } = useToast();
  const queries = useQueryClient();
  const [session, setSession] = useState<Session | null>(() => loadSession());
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
  return (
    <div className="agent-app mau-shell">
      <header className="mau-header">
        <div className="mau-brand">
          <strong>{t("app.name")}</strong>
          <span>{t("app.tagline")}</span>
        </div>
        <div className="mau-account">
          <span className="mau-owner" title={session.owner}>{session.owner}</span>
          <Button onClick={toggleLanguage}>{t("language.toggle")}</Button>
          <Button onClick={() => void signOut()}>{t("account.logout")}</Button>
        </div>
      </header>
      <main className="mau-main">
        <AgentsScreen session={session} />
      </main>
    </div>
  );
}
