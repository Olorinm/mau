import {useEffect,useRef,useState,type ReactNode,type FormEvent,type ChangeEvent} from "react";
import {ArrowRight,Globe2,LoaderCircle,UsersRound} from "lucide-react";
import {useI18n,type TranslationFn} from "./presentation/i18n";
export interface AuthBrand {brand:ReactNode;brandLabel:string;logo?:ReactNode;illustration?:ReactNode;desktopPlatform?:string}
export interface EmailCodeAuthProps extends AuthBrand {
 email:string;code:string;inviteCode:string;countryCode:string;codeSent:boolean;requiresInvite?:boolean;requiresCountry?:boolean;
 pending?:boolean;cooldown?:number;codeInvalid?:boolean;inviteInvalid?:boolean;countryInvalid?:boolean;inviteRequiredNotice?:boolean;
 errorMessage?:string;toastMessage?:string;enterLabel:string;countryOptions:readonly {code:string;label:string}[];
 languageAction?:{label:string;shortLabel:string;onSelect():void};
 onEmailChange(value:string):void;onCodeChange(value:string):void;onInviteCodeChange(value:string):void;onCountryCodeChange(value:string):void;
 onSendCode():void;onSubmit():void;onEditEmail():void;onContinueWithoutAccount?():void;
}
export function EmailCodeAuth(props:EmailCodeAuthProps){
 const {t}=useI18n();const {email,code,inviteCode,countryCode,pending,countryOptions,desktopPlatform}=props;
 const codeSent=props.codeSent,cooldown=props.cooldown??0,showInviteCode=codeSent&&props.requiresInvite,showCountryCode=codeSent&&props.requiresCountry;
 const registrationFlow=showInviteCode||showCountryCode,normalizedEmail=email.trim(),normalizedCode=code.trim();
 const missingRequiredInviteCode=showInviteCode&&!inviteCode.trim(),missingRequiredCountryCode=showCountryCode&&!countryCode;
 const inviteCodeInvalid=props.inviteInvalid,countryCodeInvalid=props.countryInvalid,inviteCodeRequired=props.inviteRequiredNotice;
 const emailInputRef=useRef<HTMLInputElement>(null),codeInputRef=useRef<HTMLInputElement>(null),inviteCodeInputRef=useRef<HTMLInputElement>(null),countrySelectRef=useRef<HTMLSelectElement>(null);
 useEffect(()=>{if(codeSent)codeInputRef.current?.focus()},[codeSent]);
 useEffect(()=>{if(inviteCodeInvalid)inviteCodeInputRef.current?.focus();else if(countryCodeInvalid)countrySelectRef.current?.focus()},[inviteCodeInvalid,countryCodeInvalid]);
 const submit=(event:FormEvent)=>{event.preventDefault();if(pending||!normalizedEmail||missingRequiredInviteCode||missingRequiredCountryCode)return;if(!codeSent){if(cooldown<=0)props.onSendCode()}else if(/^\d{6}$/.test(normalizedCode))props.onSubmit()};
 const editEmail=()=>{if(!pending)props.onEditEmail()};const resendCode=()=>{if(!pending&&cooldown<=0&&normalizedEmail)props.onSendCode()};
 const updateEmail=(e:ChangeEvent<HTMLInputElement>)=>props.onEmailChange(e.currentTarget.value);
 const updateCode=(e:ChangeEvent<HTMLInputElement>)=>props.onCodeChange(e.currentTarget.value.replace(/\D/g,"").slice(0,6));
 const updateInviteCode=(e:ChangeEvent<HTMLInputElement>)=>props.onInviteCodeChange(e.currentTarget.value.toUpperCase());
 const updateCountryCode=(e:ChangeEvent<HTMLSelectElement>)=>props.onCountryCodeChange(e.currentTarget.value);
  return (
    <main
      className="cloud-auth-shell"
      data-step={registrationFlow ? "registration" : codeSent ? "code" : "email"}
      data-desktop-platform={desktopPlatform || undefined}
    >
      <div className="cloud-auth-window-drag-region" aria-hidden="true" />
      {props.illustration}

      <div className="cloud-auth-page-brand" aria-label={props.brandLabel}>
        <span className="cloud-auth-logo" aria-hidden="true">
          {props.logo}
        </span>
        <span className="cloud-auth-wordmark">
          {props.brand}
        </span>
      </div>

      {props.languageAction ? <button className="cloud-auth-language" type="button" aria-label={props.languageAction.label} onClick={props.languageAction.onSelect}><Globe2 size={15} aria-hidden="true"/><span>{props.languageAction.shortLabel}</span></button> : null}

      <div className="cloud-auth-stack">
        {props.toastMessage ? (
          <div className="cloud-auth-toast" role="status">
            {props.toastMessage}
          </div>
        ) : null}
        <form className="cloud-auth-panel" onSubmit={submit} aria-label={t("auth.loginAria")}>
          <header className="cloud-auth-header">
            <div className="cloud-auth-heading">
              <h1>
                <span>{t("auth.returnToYour")}</span>
                <em>{props.brand}</em>
              </h1>
            </div>
          </header>

          {!codeSent ? (
            <label className="bridge-token-field">
              <span className="cloud-auth-field-label">{t("auth.emailLabel")}</span>
              <span className="cloud-auth-input-wrap">
                <input
                  ref={emailInputRef}
                  type="email"
                  value={email}
                  autoFocus
                  autoComplete="email"
                  placeholder={t("auth.emailPlaceholder")}
                  disabled={pending}
                  onChange={updateEmail}
                />
              </span>
            </label>
          ) : (
            <>
              <div className="cloud-auth-email-summary">
                <strong>{normalizedEmail}</strong>
                <button type="button" disabled={pending} onClick={editEmail}>
                  {t("auth.changeEmail")}
                </button>
              </div>

              <label className="bridge-token-field">
                <span className="cloud-auth-field-label">{t("auth.codeLabel")}</span>
                <span
                  className="cloud-auth-code-input"
                  data-invalid={props.codeInvalid ? "true" : undefined}
                >
                  <input
                    ref={codeInputRef}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={code}
                    disabled={pending}
                    autoComplete="one-time-code"
                    maxLength={6}
                    aria-label={t("auth.codeLabel")}
                    aria-invalid={props.codeInvalid || undefined}
                    onChange={updateCode}
                  />
                  <span className="cloud-auth-code-boxes" aria-hidden="true">
                    {Array.from({ length: 6 }, (_, index) => (
                      <span
                        key={index}
                        data-active={index === Math.min(code.length, 5) ? "true" : undefined}
                        data-filled={code[index] ? "true" : undefined}
                      >
                        {code[index] ?? ""}
                      </span>
                    ))}
                  </span>
                </span>
              </label>
            </>
          )}

          {showCountryCode ? (
            <label className="bridge-token-field">
              <span className="cloud-auth-field-label">{t("auth.countryLabel")}</span>
              <span className="cloud-auth-input-wrap" data-invalid={countryCodeInvalid ? "true" : undefined}>
                <select
                  ref={countrySelectRef}
                  className="cloud-auth-country-select"
                  value={countryCode}
                  disabled={pending}
                  required
                  autoComplete="country"
                  aria-required="true"
                  aria-invalid={countryCodeInvalid || undefined}
                  onChange={updateCountryCode}
                >
                  <option value="" disabled hidden>
                    {t("auth.countryPlaceholder")}
                  </option>
                  {countryOptions.map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.label} ({option.code})
                    </option>
                  ))}
                </select>
              </span>
              <span className="cloud-auth-field-hint">{t("auth.countryHint")}</span>
            </label>
          ) : null}

          {showInviteCode ? (
            <label className="bridge-token-field">
              <span className="cloud-auth-field-label">{t("auth.inviteCodeLabel")}</span>
              <span className="cloud-auth-input-wrap" data-invalid={inviteCodeInvalid ? "true" : undefined}>
                <input
                  ref={inviteCodeInputRef}
                  type="text"
                  value={inviteCode}
                  disabled={pending}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={32}
                  placeholder={t("auth.inviteCodePlaceholder")}
                  required={showInviteCode}
                  aria-required={showInviteCode}
                  aria-invalid={inviteCodeInvalid || undefined}
                  onChange={updateInviteCode}
                />
              </span>
              <span className="cloud-auth-field-hint">{t("auth.inviteCodeHint")}</span>
            </label>
          ) : null}

          <div className="cloud-auth-feedback" aria-live="polite">
            {props.errorMessage ? (
              <p
                className={inviteCodeRequired ? "cloud-auth-status" : "bridge-token-error"}
                role={inviteCodeRequired ? "status" : "alert"}
              >
                {props.errorMessage}
              </p>
            ) : null}
            {codeSent ? (
              <button
                className="cloud-auth-resend"
                type="button"
                disabled={pending || cooldown > 0 || !normalizedEmail}
                onClick={resendCode}
              >
                {cooldown > 0 ? cooldownLabel(cooldown, "resend", t) : t("auth.resendCode")}
              </button>
            ) : null}
          </div>

          <div className="cloud-auth-actions">
            <button
              className="bridge-token-submit"
              type="submit"
              disabled={
                pending ||
                !normalizedEmail ||
                (!codeSent && cooldown > 0) ||
                (codeSent && !/^\d{6}$/.test(normalizedCode)) ||
                missingRequiredInviteCode ||
                missingRequiredCountryCode
              }
            >
              <span>
                {pending
                  ? t("auth.pleaseWait")
                  : !codeSent && cooldown > 0
                    ? cooldownLabel(cooldown, "send", t)
                    : codeSent
                      ? registrationFlow
                        ? t("auth.finishRegistration")
                        : props.enterLabel
                      : t("auth.getCode")}
              </span>
              <ArrowRight size={15} aria-hidden="true" />
            </button>
            {!codeSent && props.onContinueWithoutAccount ? (
              <button
                className="cloud-auth-continue-local"
                type="button"
                disabled={pending}
                onClick={props.onContinueWithoutAccount}
              >
                {t("auth.continueWithoutAccount")}
              </button>
            ) : null}
          </div>

          {!codeSent ? <p className="cloud-auth-legal">{t("auth.legalNotice")}</p> : null}
        </form>
      </div>
    </main>
  );
}
export interface TeamGateCopy {title:string;hint:string;tokenLabel:string;tokenPlaceholder:string;invalid:string;unavailable:string;pending:string;submit:string;privacy:string;pickTitle:string;pickHint:string;pickEmpty:string;pickNoRoles:string;useEmail:string}
export function TeamGateScreen(props: AuthBrand & {
  copy:TeamGateCopy;
  pending: boolean;
  invalid: boolean;
  unavailable: boolean;
  onSubmit(token: string): void;
  onResetError(): void;
  onCancel?(): void;
}) {
  const { t } = useI18n();
  const copy = props.copy;
  const [token, setToken] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedToken = token.trim();
  const desktopPlatform = props.desktopPlatform;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (props.pending || !normalizedToken) return;
    props.onResetError();
    props.onSubmit(normalizedToken);
  }

  return (
    <main className="cloud-auth-shell" data-step="team-gate" data-desktop-platform={desktopPlatform || undefined}>
      <div className="cloud-auth-window-drag-region" aria-hidden="true" />
      {props.illustration}

      <div className="cloud-auth-page-brand" aria-label={props.brandLabel}>
        <span className="cloud-auth-logo" aria-hidden="true">
          {props.logo}
        </span>
        <span className="cloud-auth-wordmark">
          {props.brand}
        </span>
      </div>

      <div className="cloud-auth-stack">
        <form className="cloud-auth-panel" onSubmit={submit} aria-label={copy.title}>
          <header className="cloud-auth-header">
            <div className="cloud-auth-heading">
              <h1>
                <span>{copy.title}</span>
              </h1>
            </div>
          </header>

          <p className="cloud-auth-status">{copy.hint}</p>

          <label className="bridge-token-field">
            <span className="cloud-auth-field-label">{copy.tokenLabel}</span>
            <span className="cloud-auth-input-wrap">
              <input
                ref={inputRef}
                // A shared secret, not a personal one: never offer to remember it,
                // and keep it out of the browser's saved-password store.
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                autoFocus
                placeholder={copy.tokenPlaceholder}
                disabled={props.pending}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  setToken(event.currentTarget.value);
                  props.onResetError();
                }}
              />
            </span>
          </label>

          <div className="cloud-auth-feedback" aria-live="polite">
            {props.invalid ? (
              <p className="bridge-token-error" role="alert">
                {copy.invalid}
              </p>
            ) : props.unavailable ? (
              <p className="bridge-token-error" role="alert">
                {copy.unavailable}
              </p>
            ) : null}
          </div>

          <div className="cloud-auth-actions">
            <button className="bridge-token-submit" type="submit" disabled={props.pending || !normalizedToken}>
              <span>{props.pending ? copy.pending : copy.submit}</span>
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>

          {props.onCancel ? (
            <button
              className="cloud-auth-continue-local"
              type="button"
              disabled={props.pending}
              onClick={props.onCancel}
            >
              {t("common.cancel")}
            </button>
          ) : null}
          <p className="cloud-auth-legal">{copy.privacy}</p>
        </form>
      </div>
    </main>
  );
}


export function TeamAccountPickerScreen(props: AuthBrand & {
  copy:TeamGateCopy;
  accounts: readonly { email: string; label?:string; roles: string[]; status: string; disabled?:boolean }[];
  loading: boolean;
  switchingEmail?: string;
  error: string;
  onPick(email: string): void;
  onUseEmail(): void;
}) {
  const copy = props.copy;
  const switching = Boolean(props.switchingEmail);
  const desktopPlatform = props.desktopPlatform;

  return (
    <main className="cloud-auth-shell" data-step="team-accounts" data-desktop-platform={desktopPlatform || undefined}>
      <div className="cloud-auth-window-drag-region" aria-hidden="true" />
      {props.illustration}

      <div className="cloud-auth-page-brand" aria-label={props.brandLabel}>
        <span className="cloud-auth-logo" aria-hidden="true">
          {props.logo}
        </span>
        <span className="cloud-auth-wordmark">
          {props.brand}
        </span>
      </div>

      <div className="cloud-auth-stack">
        <section className="cloud-auth-panel" aria-label={copy.pickTitle}>
          <header className="cloud-auth-header">
            <div className="cloud-auth-heading">
              <h1>
                <span>{copy.pickTitle}</span>
              </h1>
            </div>
          </header>

          <p className="cloud-auth-status">{copy.pickHint}</p>

          <div className="cloud-auth-feedback" aria-live="polite">
            {props.error ? (
              <p className="bridge-token-error" role="alert">
                {props.error}
              </p>
            ) : null}
          </div>

          {props.loading ? (
            <p className="cloud-auth-status">
              <LoaderCircle size={14} aria-hidden="true" /> {copy.pending}
            </p>
          ) : props.accounts.length === 0 ? (
            <p className="cloud-auth-status">{copy.pickEmpty}</p>
          ) : (
            <div className="team-account-picker-list" role="list">
              {props.accounts.map((account) => (
                <button
                  key={account.email}
                  className="team-account-picker-option"
                  type="button"
                  role="listitem"
                  // A disabled account exists but cannot sign in, so it is shown
                  // (the database is the truth) and not offered.
                  disabled={switching || account.disabled}
                  data-pending={props.switchingEmail === account.email ? "true" : undefined}
                  onClick={() => props.onPick(account.email)}
                >
                  <span className="team-account-picker-identity">
                    <strong>{account.label ?? account.email}</strong>
                    <small>
                      {account.disabled ? (
                        <em className="team-account-picker-status">{account.status}</em>
                      ) : null}
                      {account.roles.length > 0 ? account.roles.join(" + ") : copy.pickNoRoles}
                    </small>
                  </span>
                  {props.switchingEmail === account.email ? (
                    <LoaderCircle size={15} aria-hidden="true" />
                  ) : (
                    <ArrowRight size={15} aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
          )}

          <div className="cloud-auth-actions">
            <button className="cloud-auth-continue-local" type="button" disabled={switching} onClick={props.onUseEmail}>
              {copy.useEmail}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

function cooldownLabel(seconds: number, variant: "resend" | "send", t: TranslationFn): string {
  const value = Math.max(0, Math.ceil(seconds));
  if (value >= 90) {
    const minutes = Math.ceil(value / 60);
    return variant === "resend"
      ? t("auth.resendCodeInMinutes", { count: minutes })
      : t("auth.sendCodeInMinutes", { count: minutes });
  }
  return variant === "resend"
    ? t("auth.resendCodeInSeconds", { count: value })
    : t("auth.sendCodeInSeconds", { count: value });
}


export function RoomsUnavailableState(props: {
  logo?:ReactNode;
  onRefresh():void;
  healthLoading: boolean;
  healthError: string;
  onboardingGuideVisible: boolean;
  onDismissOnboardingGuide(): void;
}) {
  const { t } = useI18n();
  return (
    <section className="rooms-view rooms-unavailable-view rooms-onboarding-view" aria-label={t("app.rooms")}>
      <div
        className="room-empty-state rooms-runtime-empty rooms-runtime-guide"
        data-prominent={props.onboardingGuideVisible ? "true" : "false"}
      >
        <div className="rooms-guide-avatar" aria-hidden="true">
          {props.logo}
        </div>
        <UsersRound size={32} />
        <h3>{props.healthLoading ? t("gate.roomsLoadingTitle") : t("gate.roomsUnavailableTitle")}</h3>
        <p>{props.healthError ? t("gate.roomsBridgeDisconnectedCopy") : t("gate.roomsDataPreparingCopy")}</p>
        <div className="rooms-guide-actions">
          <button className="room-primary-button" type="button" onClick={props.onRefresh}>
            {t("mountedApp.refresh")}
          </button>
          {props.onboardingGuideVisible ? (
            <button className="rooms-guide-secondary" type="button" onClick={props.onDismissOnboardingGuide}>
              {t("gate.later")}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
