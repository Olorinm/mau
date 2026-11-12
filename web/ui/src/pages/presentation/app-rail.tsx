// Extracted from web/src/components/sidebar/app-navigation.tsx at 8b365ed. See source-manifest.json for boundary changes.
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import clsx from "clsx";
import { UnreadCountAnchor } from "./unread-count";
import { MotionMenu, MotionMenuItem } from "../ui/menu";
import { useI18n } from "./i18n";
import type { NavigationGroup, MenuAction } from "../shell";
import styles from "../styles/rail.module.css";
export function AppRail({
  expanded,
  groups,
  selectedId,
  onSelect,
  footer,
  label,
  account,
}: {
  expanded: boolean;
  groups: readonly NavigationGroup[];
  selectedId?: string;
  onSelect(id: string): void;
  footer?: ReactNode;
  label?: string;
  account?: {
    name: string;
    avatar: ReactNode;
    label: string;
    description?: string;
    onOpen?(): void;
    actions: readonly MenuAction[];
  };
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <aside
      className={clsx("app-rail", styles.rail)}
      data-expanded={expanded ? "true" : "false"}
      aria-label={label ?? t("app.mainNav")}
    >
      <nav className={clsx("app-rail-nav", styles.nav)}>
        {groups.map((group) => (
          <RailSection
            key={group.id}
            title={group.label}
            compactTitle={!expanded ? group.compactLabel : undefined}
          >
            {group.items.map((item) => (
              <RailButton
                key={item.id}
                active={selectedId === item.id}
                sectionTarget={item.id}
                label={item.label}
                icon={item.icon}
                badge={item.badge}
                disabled={item.disabled}
                onClick={() => onSelect(item.id)}
              />
            ))}
          </RailSection>
        ))}
      </nav>
      <div className={clsx("app-rail-bottom", styles.bottom)}>
        {footer}
        {account ? (
          <MotionMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            side="top"
            align="start"
            ariaLabel={account.label}
            className={clsx("app-account-menu", styles.accountMenu)}
            trigger={
              <button
                className={clsx("app-user-button", styles.userButton)}
                data-active={menuOpen ? "true" : "false"}
                data-tooltip={account.label}
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                aria-label={account.label}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title={account.label}
              >
                <span className={styles.userButtonAvatar}>
                  {account.avatar}
                </span>
                <strong className={styles.userButtonName}>
                  {account.name}
                </strong>
              </button>
            }
          >
            <button
              className={clsx(
                "app-account-menu-profile",
                styles.accountMenuProfile,
              )}
              type="button"
              role="menuitem"
              onClick={account.onOpen}
              disabled={!account.onOpen}
            >
              <span
                className={clsx(
                  "app-account-menu-avatar",
                  styles.accountMenuAvatar,
                )}
                aria-hidden="true"
              >
                {account.avatar}
              </span>
              <span
                className={clsx(
                  "app-account-menu-copy",
                  styles.accountMenuCopy,
                )}
              >
                <strong>{account.name}</strong>
                <small>{account.description}</small>
              </span>
              {account.onOpen ? (
                <ChevronRight size={18} aria-hidden="true" />
              ) : null}
            </button>
            <div
              className={clsx(
                "app-account-menu-divider",
                styles.accountMenuDivider,
              )}
            />
            {account.actions.map((action) => (
              <MotionMenuItem
                className={clsx(
                  "app-account-menu-item",
                  styles.accountMenuItem,
                )}
                key={action.id}
                disabled={action.disabled}
                onClick={() => {
                  setMenuOpen(false);
                  action.onSelect();
                }}
              >
                {action.icon}
                <span>{action.label}</span>
              </MotionMenuItem>
            ))}
          </MotionMenu>
        ) : null}
      </div>
    </aside>
  );
}
function RailSection(props: {
  title?: string;
  compactTitle?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={clsx("app-rail-section", styles.section)}
      aria-label={props.title}
    >
      <h2
        className={clsx("app-rail-section-title", styles.sectionTitle)}
        title={props.title}
      >
        {props.compactTitle ?? props.title}
      </h2>
      <div className={clsx("app-rail-section-items", styles.sectionItems)}>
        {props.children}
      </div>
    </section>
  );
}
function RailButton(props: {
  active?: boolean;
  sectionTarget?: string;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
  onClick(): void;
}) {
  const { t } = useI18n();
  const unreadCount = typeof props.badge === "number" ? props.badge : 0;
  return (
    <button
      className={clsx("app-rail-button", styles.button)}
      data-active={props.active ? "true" : "false"}
      data-rail-section={props.sectionTarget}
      data-tooltip={props.label}
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-current={props.active ? "page" : undefined}
      aria-label={
        unreadCount
          ? t("app.unreadCount", { label: props.label, count: unreadCount })
          : props.label
      }
      title={props.label}
    >
      <UnreadCountAnchor
        count={unreadCount}
        className={styles.iconUnreadAnchor}
      >
        {props.icon}
        {typeof props.badge === "number" ? null : props.badge}
      </UnreadCountAnchor>
      <span className={styles.buttonLabel}>{props.label}</span>
    </button>
  );
}
