import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { AuthLayout, AuthField, AuthSubmit, SaplingPlaceholder, ConstellationPlaceholder } from "@olorinm/agent-frontend";
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
    <AuthLayout brand={t("app.name")} logo={<SaplingPlaceholder />} title={t("login.title")}
      description={t("login.subtitle")} illustration={<ConstellationPlaceholder brand={t("app.name")} />}
      onSubmit={submit} toolbar={<button type="button" className="mau-link" onClick={props.onToggleLanguage}>{t("language.toggle")}</button>}>
        {mode === "password" ? (
          <>
            <AuthField label={t("login.user")}>
              <input value={user} onChange={(e) => setUser(e.target.value)} placeholder={t("login.userPlaceholder")}
                autoComplete="username" autoCapitalize="none" spellCheck={false} required />
            </AuthField>
            <AuthField label={t("login.password")}>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password" required />
            </AuthField>
          </>
        ) : (
          <AuthField label={t("login.token")}>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required />

          </AuthField>
        )}
        {login.error ? (
          <p className="mau-error" role="alert">
            {errorMessage(t, login.error instanceof ApiError ? login.error.code : "request_failed")}
          </p>
        ) : null}
        <AuthSubmit disabled={!ready || login.isPending}>
          {login.isPending ? t("common.loading") : t("login.submit")}
        </AuthSubmit>
        <div className="mau-login-links">
          <button type="button" className="mau-link" onClick={() => { login.reset(); setMode(mode === "password" ? "token" : "password"); }}>
            {mode === "password" ? t("login.useToken") : t("login.usePassword")}
          </button>
        </div>
    </AuthLayout>
  );
}
