import type { ComponentProps, ReactNode } from 'react';

/** Form layout only. Products supply fields, validation and submission. */
export function AuthLayout({ brand, logo, title, description, illustration, toolbar, children, ...form }: {
  brand: ReactNode; logo?: ReactNode; title: ReactNode; description?: ReactNode;
  illustration?: ReactNode; toolbar?: ReactNode;
} & Omit<ComponentProps<'form'>, 'title'>) {
  return <main className="agent-app cloud-auth-shell">
    <div className="cloud-auth-page-brand"><span className="cloud-auth-logo">{logo}</span><span className="cloud-auth-wordmark">{brand}</span></div>
    <div className="af-auth-toolbar">{toolbar}</div>{illustration}
    <div className="cloud-auth-stack"><form {...form} className={`cloud-auth-panel ${form.className ?? ''}`}>
      <header className="cloud-auth-header"><div className="cloud-auth-heading"><h1>{title}</h1>{description ? <p>{description}</p> : null}</div></header>
      {children}
    </form></div>
  </main>;
}
export function AuthField({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <label className="cloud-auth-field"><span className="cloud-auth-field-label">{label}</span><span className="cloud-auth-input-wrap">{children}</span></label>;
}

export function AuthSubmit(props: ComponentProps<'button'>) {
  return <button type="submit" {...props} className={`af-auth-submit ${props.className ?? ''}`} />;
}
