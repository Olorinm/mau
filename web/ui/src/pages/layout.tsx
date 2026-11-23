// Extracted from web/src/components/rooms/room-sidebar.tsx at 8b365ed. See source-manifest.json for boundary changes.
import { createContext, type ComponentProps, type ReactNode } from "react";
import { EmptyState, ProductIcon, Tooltip } from "../app/index";
import { useFrontendLabels } from "./provider";
import {
  useCompactDetail,
  CompactBackButton,
} from "./layouts/compact-list-detail";
const CompactHeaderBack = createContext<ReactNode>(null);
export interface ViewTab {
  id: string;
  label: string;
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
            <section className="contacts-detail-panel contacts-partner-detail">
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
