// Extracted from web/src/components/sidebar/settings-dialog.tsx at 8b365ed. See source-manifest.json for boundary changes.
import type { ReactNode } from "react";
import clsx from "clsx";
import { ProductIcon } from "@olorinm/agent-ui/app";
import { useI18n } from "./presentation/i18n";
import styles from "./styles/settings.module.css";
export interface SettingsSection {
  id: string;
  label: string;
  icon?: ReactNode;
  description?: ReactNode;
  content: ReactNode;
  dividerAfter?: boolean;
}
export function SettingsLayout({
  title,
  sections,
  selectedId,
  onSelect,
  kicker,
  embedded = true,
  onClose,
}: {
  title: ReactNode;
  sections: readonly SettingsSection[];
  selectedId: string;
  onSelect(id: string): void;
  kicker?: ReactNode;
  embedded?: boolean;
  onClose?(): void;
}) {
  const { t } = useI18n();
  const current = sections.find((section) => section.id === selectedId);
  return (
    <div
      className={clsx(
        "settings-screen",
        styles.screen,
        embedded && "embedded",
        embedded && styles.embedded,
      )}
      role={embedded ? undefined : "dialog"}
      aria-modal={embedded ? undefined : "true"}
      aria-label={typeof title === "string" ? title : undefined}
    >
      <aside className={clsx("settings-screen-sidebar", styles.sidebar)}>
        {embedded ? (
          <header className={styles.sidebarHeader}>
            <h2>{title}</h2>
          </header>
        ) : (
          <button
            className={clsx("settings-back-button", styles.backButton)}
            type="button"
            onClick={onClose}
          >
            <ProductIcon name="back" size={18} />
            <span>{t("common.backToApp")}</span>
          </button>
        )}
        <nav
          className={clsx("settings-nav", styles.nav)}
          aria-label={t("settings.nav")}
        >
          {sections.map((item) => {
            const active = selectedId === item.id;
            return (
              <button
                key={item.id}
                className={clsx(
                  "settings-nav-item",
                  styles.navItem,
                  item.dividerAfter && styles.navItemDividerAfter,
                  active && "active",
                  active && styles.navItemActive,
                )}
                data-active={active ? "true" : "false"}
                data-settings-section={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className={clsx("settings-screen-main", styles.main)}>
        <div
          className={clsx(
            "settings-screen-content",
            styles.content,
            selectedId === "ops" && "ops-settings-screen-content",
          )}
        >
          <header className={clsx("settings-screen-header", styles.header)}>
            <span className={clsx("settings-screen-kicker", styles.kicker)}>
              {kicker}
            </span>
            <h1>{current?.label}</h1>
            <p>{current?.description}</p>
          </header>

          {current?.content}
        </div>
      </main>
    </div>
  );
}
export function PreferenceGroup({
  title,
  children,
  description,
}: {
  title?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
}) {
  return (
    <section className="settings-list-section">
      {title ? <h2>{title}</h2> : null}
      {description ? <p>{description}</p> : null}
      <div className="settings-list settings-preference-list">{children}</div>
    </section>
  );
}
export function PreferenceRow({
  label,
  description,
  control,
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
}) {
  return (
    <div className="settings-list-row settings-preference-row">
      <span className="settings-list-row-main">
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      <span className="settings-list-row-control wide">{control}</span>
    </div>
  );
}
