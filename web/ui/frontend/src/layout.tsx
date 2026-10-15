// Extracted from web/src/components/rooms/room-sidebar.tsx at 8b365ed. See source-manifest.json for boundary changes.
import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { EmptyState, ProductIcon, Tooltip } from "@olorinm/agent-ui/app";
import { useFrontendLabels } from "./provider";
import {
  useCompactDetail,
  CompactBackButton,
} from "./layouts/compact-list-detail";
import { MotionMenu, MotionMenuItem } from "./ui/menu";
import type { MenuAction } from "./shell";
const CompactHeaderBack = createContext<ReactNode>(null);
export interface ListItem {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  disabled?: boolean;
  ariaLabel?: string;
}
export interface ViewTab {
  id: string;
  label: string;
}

export function CollaborationTabs({
  items,
  selectedId,
  onSelect,
  label,
}: {
  items: readonly ViewTab[];
  selectedId: string;
  onSelect(id: string): void;
  label: string;
}) {
  return (
    <nav className="collaboration-switch" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          data-active={item.id === selectedId}
          data-room-view-target={item.id}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

export function SidebarHeader({
  title,
  description,
  icon,
  actions,
  actionLabel,
  variant = "conversations",
}: {
  variant?: "conversations" | "contacts";
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: readonly MenuAction[];
  actionLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useFrontendLabels();
  if (variant === "contacts")
    return (
      <header className="contacts-nav-header">
        <h1>{title}</h1>
        {actions?.length ? (
          <MotionMenu
            open={open}
            onOpenChange={setOpen}
            ariaLabel={actionLabel ?? t("create")}
            align="end"
            tooltipContent={actionLabel ?? t("create")}
            tooltipSide="bottom"
            trigger={
              <button
                className="rooms-icon-button"
                type="button"
                aria-label={actionLabel ?? t("create")}
              >
                <ProductIcon name="add" size={16} />
              </button>
            }
          >
            {actions.map((action) => (
              <MotionMenuItem
                key={action.id}
                disabled={action.disabled}
                onClick={() => {
                  setOpen(false);
                  action.onSelect();
                }}
              >
                {action.icon}
                <span>{action.label}</span>
              </MotionMenuItem>
            ))}
          </MotionMenu>
        ) : null}
      </header>
    );
  return (
    <header className="rooms-list-header">
      <div className="rooms-list-title">
        <span className="rooms-title-icon" aria-hidden="true">
          {icon ?? <ProductIcon name="rooms" size={18} />}
        </span>
        <div>
          <h1>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
      </div>
      <div className="rooms-create-menu-wrap">
        {actions?.length ? (
          <MotionMenu
            open={open}
            onOpenChange={setOpen}
            ariaLabel={actionLabel ?? t("create")}
            align="end"
            tooltipContent={actionLabel ?? t("create")}
            tooltipSide="bottom"
            trigger={
              <button
                type="button"
                className="rooms-icon-button"
                aria-label={actionLabel ?? t("create")}
              >
                <ProductIcon name="add" size={17} />
              </button>
            }
          >
            {actions.map((action) => (
              <MotionMenuItem
                key={action.id}
                disabled={action.disabled}
                onClick={() => {
                  setOpen(false);
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
    </header>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  label?: string;
}) {
  const { t } = useFrontendLabels();
  return (
    <div
      className="rooms-search-wrap contacts-nav-search-wrap"
      data-open={value.trim() ? "true" : "false"}
    >
      <label className="rooms-search contacts-nav-search">
        <ProductIcon name="search" size={15} />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder ?? t("search")}
          aria-label={label ?? placeholder ?? t("search")}
        />
        {value.trim() ? (
          <Tooltip content={t("clearSearch")}>
            <button
              className="rooms-search-clear"
              type="button"
              onClick={() => onChange("")}
              aria-label={t("clearSearch")}
            >
              <ProductIcon name="close" size={15} />
            </button>
          </Tooltip>
        ) : null}
      </label>
    </div>
  );
}
function ConversationListItem({
  item,
  active,
  onSelect,
}: {
  item: ListItem;
  active: boolean;
  onSelect(id: string): void;
}) {
  return (
    <button
      className="rooms-list-item"
      data-active={active ? "true" : "false"}
      type="button"
      onClick={() => onSelect(item.id)}
      aria-label={item.ariaLabel}
      aria-current={active ? "true" : undefined}
      disabled={item.disabled}
    >
      {item.leading}
      <span className="rooms-list-copy">
        <span className="rooms-list-name">{item.title}</span>
        <span className="rooms-list-preview">{item.description}</span>
      </span>
      {item.trailing}
    </button>
  );
}
function ContactListItem({
  item,
  active,
  onSelect,
}: {
  item: ListItem;
  active: boolean;
  onSelect(id: string): void;
}) {
  return (
    <button
      key={item.id}
      className="contacts-person-row"
      data-active={active ? "true" : "false"}
      type="button"
      disabled={item.disabled}
      aria-label={item.ariaLabel}
      aria-current={active ? "true" : undefined}
      onClick={() => onSelect(item.id)}
    >
      {item.leading}
      <span>
        <strong>{item.title}</strong>
        {item.description ? <small>{item.description}</small> : null}
        {item.trailing}
      </span>
    </button>
  );
}
export function ItemList({
  items,
  selectedId,
  onSelect,
  label,
  empty,
  variant = "conversations",
  heading,
  count,
}: {
  items: readonly ListItem[];
  selectedId?: string;
  onSelect(id: string): void;
  label: string;
  empty?: ReactNode;
  variant?: "conversations" | "contacts";
  heading?: ReactNode;
  count?: ReactNode;
}) {
  return (
    <section
      className={
        variant === "contacts"
          ? "contacts-sidebar-directory"
          : "rooms-chat-list"
      }
      aria-label={label}
    >
      {heading ? (
        <div
          className={`rooms-section-label ${variant === "contacts" ? "contacts-nav-section-label" : ""}`}
        >
          <span>{heading}</span>
          {count !== undefined ? <small>{count}</small> : null}
        </div>
      ) : null}
      <div
        className={
          variant === "contacts"
            ? "contacts-list contacts-sidebar-member-list"
            : "rooms-list-items"
        }
      >
        {items.length ? (
          items.map((item) =>
            variant === "contacts" ? (
              <ContactListItem
                key={item.id}
                item={item}
                active={item.id === selectedId}
                onSelect={onSelect}
              />
            ) : (
              <ConversationListItem
                key={item.id}
                item={item}
                active={item.id === selectedId}
                onSelect={onSelect}
              />
            ),
          )
        ) : (
          <div className="rooms-empty-row">{empty}</div>
        )}
      </div>
    </section>
  );
}

export function ListDetailLayout({
  list,
  detail,
  detailOpen,
  onBack,
  backLabel,
  empty,
  variant = "conversations",
  inspector,
}: {
  list: ReactNode;
  detail?: ReactNode;
  detailOpen: boolean;
  onBack(): void;
  backLabel?: string;
  empty?: ReactNode;
  variant?: "conversations" | "contacts";
  inspector?: ReactNode;
}) {
  const { t } = useFrontendLabels();
  const compactDetail = useCompactDetail(
    detailOpen ? "detail" : undefined,
    onBack,
  );
  const { compact, detailRef, listRef } = compactDetail;
  const contacts = variant === "contacts";
  return (
    <section
      className={`${contacts ? "contacts-view" : "rooms-view"} af-list-detail ${compactDetail.className}`}
      data-list-detail={compact ? "compact" : "wide"}
      data-detail-open={detailOpen}
      data-members-open={!!inspector && !compact}
    >
      <aside
        ref={listRef}
        className={contacts ? "contacts-nav-panel" : "rooms-list-panel"}
        data-list-panel
        inert={compact && detailOpen}
        onClickCapture={compactDetail.rememberListTarget}
        onFocusCapture={compactDetail.rememberListTarget}
      >
        {list}
      </aside>
      <section
        ref={detailRef}
        className={contacts ? "contacts-main-panel" : "room-main-panel"}
        data-detail-panel
        inert={compact && !detailOpen}
      >
        {contacts && compact && detailOpen ? (
          <CompactBackButton onClick={onBack} label={backLabel ?? t("back")} />
        ) : null}
        {contacts ? (
          <div className="contacts-detail-layout">
            <section className="contacts-detail-panel contacts-employee-detail">
              {detail ?? empty}
            </section>
          </div>
        ) : (
          <CompactHeaderBack.Provider
            value={
              compact && detailOpen ? (
                <CompactBackButton
                  onClick={onBack}
                  label={backLabel ?? t("back")}
                />
              ) : null
            }
          >
            {detail ?? empty}
          </CompactHeaderBack.Provider>
        )}
      </section>
      {inspector}
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  avatar,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  avatar?: ReactNode;
}) {
  const back = useContext(CompactHeaderBack);
  return (
    <header className="room-header">
      {back}
      <div className="room-header-main">
        {avatar ? (
          <span className="room-header-avatar-button">{avatar}</span>
        ) : null}
        <div className="room-header-copy">
          <div className="room-title-row">
            <h2>{title}</h2>
          </div>
          {description ? <p>{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="room-header-actions">{actions}</div> : null}
    </header>
  );
}
export function DetailPanel({
  children,
  ...header
}: {
  title: ReactNode;
  description?: ReactNode;
  avatar?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader {...header} />
      <div className="af-detail-body">{children}</div>
    </>
  );
}
export function LoadingSurface({ label }: { label?: string }) {
  const { t } = useFrontendLabels();
  return (
    <div
      className="og-skeleton-stack af-loading"
      role="status"
      aria-label={label ?? t("loading")}
    >
      <span className="og-skeleton og-skeleton-line" style={{ width: "42%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "74%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "58%" }} />
    </div>
  );
}
export function InlineNotice({
  title,
  children,
  action,
  tone = "info",
}: {
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  tone?: "info" | "error";
}) {
  return (
    <div
      className="af-notice"
      data-tone={tone}
      role={tone === "error" ? "alert" : "status"}
    >
      {title ? <strong>{title}</strong> : null}
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function CollectionEmptyState({
  label,
  loading,
  notice,
  ...props
}: ComponentProps<typeof EmptyState> & {
  label: string;
  loading?: boolean;
  notice?: ReactNode;
}) {
  return (
    <section
      className={`rooms-view ${loading ? "rooms-loading-view" : "rooms-unavailable-view rooms-onboarding-view"}`}
      aria-label={label}
      aria-busy={loading || undefined}
    >
      {loading ? <LoadingSurface /> : <EmptyState {...props} />}
      {notice}
    </section>
  );
}
