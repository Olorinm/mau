// Extracted from web/src/components/app-shell/app-gates.tsx at 8b365ed. See source-manifest.json for boundary changes.
import type { ComponentProps, ReactNode } from "react";
import { ArrowRight, Globe2 } from "lucide-react";
import { DefaultScope } from "./scope";
/** Original authentication page. The product supplies its form and authentication actions. */
export function AuthLayout({
  brand,
  logo,
  title,
  description,
  illustration,
  toolbar,
  children,
  feedback,
  actions,
  footer,
  toastMessage,
  step = "credentials",
  desktopPlatform,
  ...form
}: {
  brand: ReactNode;
  logo?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  illustration?: ReactNode;
  toolbar?: ReactNode;
  feedback?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  toastMessage?: ReactNode;
  step?: string;
  desktopPlatform?: string;
} & Omit<ComponentProps<"form">, "title">) {
  return (
    <DefaultScope>
    <main
      className="agent-app cloud-auth-shell"
      data-step={step}
      data-desktop-platform={desktopPlatform || undefined}
    >
      <div className="cloud-auth-window-drag-region" aria-hidden="true" />
      {illustration}

      <div
        className="cloud-auth-page-brand"
        aria-label={typeof brand === "string" ? brand : undefined}
      >
        <span className="cloud-auth-logo" aria-hidden="true">
          {logo}
        </span>
        <span className="cloud-auth-wordmark">{brand}</span>
      </div>

      {toolbar}

      <div className="cloud-auth-stack">
        {toastMessage ? (
          <div className="cloud-auth-toast" role="status">
            {toastMessage}
          </div>
        ) : null}
        <form {...form} className={`cloud-auth-panel ${form.className ?? ""}`}>
          <header className="cloud-auth-header">
            <div className="cloud-auth-heading">
              <h1>{title}</h1>
              {description ? <p>{description}</p> : null}
            </div>
          </header>

          {children}
          <div className="cloud-auth-feedback" aria-live="polite">
            {feedback}
          </div>
          <div className="cloud-auth-actions">{actions}</div>
          {footer}
        </form>
      </div>
    </main>
    </DefaultScope>
  );
}
export function AuthHeading({
  introduction,
  name,
}: {
  introduction: ReactNode;
  name: ReactNode;
}) {
  return (
    <>
      <span>{introduction}</span>
      <em>{name}</em>
    </>
  );
}
export function AuthLanguageButton({
  children,
  ...props
}: ComponentProps<"button">) {
  return (
    <button className="cloud-auth-language" type="button" {...props}>
      <Globe2 size={15} aria-hidden="true" />
      <span>{children}</span>
    </button>
  );
}
export function AuthField({
  label,
  children,
  invalid,
  hint,
}: {
  label: ReactNode;
  children: ReactNode;
  invalid?: boolean;
  hint?: ReactNode;
}) {
  return (
    <label className="bridge-token-field">
      <span className="cloud-auth-field-label">{label}</span>
      <span
        className="cloud-auth-input-wrap"
        data-invalid={invalid || undefined}
      >
        {children}
      </span>
      {hint ? <span className="cloud-auth-field-hint">{hint}</span> : null}
    </label>
  );
}
export function AuthSubmit({ children, ...props }: ComponentProps<"button">) {
  return (
    <button className="bridge-token-submit" type="submit" {...props}>
      <span>{children}</span>
      <ArrowRight size={15} aria-hidden="true" />
    </button>
  );
}
