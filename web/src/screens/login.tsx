import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@olorinm/agent-ui/app";
import { ApiError } from "../api/http";
import { loginWithPassword, loginWithToken, type Session } from "../api/session";
import { errorMessage, useI18n } from "../i18n";

export function LoginScreen(props: { onSignedIn(session: Session): void; onToggleLanguage(): void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"password" | "token">("password");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const login = useMutation({
    mutationFn: () => mode === "password" ? loginWithPassword(user, password) : loginWithToken(token),
    onSuccess: props.onSignedIn,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!login.isPending) login.mutate();
  };
  const ready = mode === "password" ? user.trim() && password : token.trim();
  return (
    <div className="agent-app mau-login">
      <form className="mau-login-card" onSubmit={submit}>
        <div className="mau-login-heading">
          <strong className="mau-wordmark">{t("app.name")}</strong>
          <h1>{t("login.title")}</h1>
          <p>{t("login.subtitle")}</p>
        </div>
        {mode === "password" ? (
          <>
            <label className="mau-field">
              <span>{t("login.user")}</span>
              <input value={user} onChange={(e) => setUser(e.target.value)} placeholder={t("login.userPlaceholder")}
                autoComplete="username" autoCapitalize="none" spellCheck={false} required />
            </label>
            <label className="mau-field">
              <span>{t("login.password")}</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password" required />
            </label>
          </>
        ) : (
          <label className="mau-field">
            <span>{t("login.token")}</span>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required />
            <small>{t("login.tokenHint")}</small>
          </label>
        )}
        {login.error ? (
          <p className="mau-error" role="alert">
            {errorMessage(t, login.error instanceof ApiError ? login.error.code : "request_failed")}
          </p>
        ) : null}
        <Button type="submit" variant="primary" disabled={!ready || login.isPending}>
          {login.isPending ? t("common.loading") : t("login.submit")}
        </Button>
        <div className="mau-login-links">
          <button type="button" className="mau-link" onClick={() => { login.reset(); setMode(mode === "password" ? "token" : "password"); }}>
            {mode === "password" ? t("login.useToken") : t("login.usePassword")}
          </button>
          <button type="button" className="mau-link" onClick={props.onToggleLanguage}>{t("language.toggle")}</button>
        </div>
      </form>
    </div>
  );
}
