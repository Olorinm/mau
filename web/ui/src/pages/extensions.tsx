// Extracted from web/src/components/extensions/extensions-view.tsx at 8b365ed. See source-manifest.json for boundary changes.
import { useId, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import clsx from "clsx";
import { useI18n } from "./presentation/i18n";
import styles from "./styles/extensions.module.css";
export interface ExtensionTab {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  count?: ReactNode;
}
export interface ExtensionRow {
  id: string;
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  kind?: string;
  source?: string;
  metadata?: ReactNode;
  targets?: ReactNode;
  sourceId?: string;
  enabled?: boolean;
  targetIds?: readonly string[];
  onOpen?(): void;
}

export function ExtensionsPage({
  title,
  summary,
  tabs,
  selectedId,
  onSelect,
  query,
  onQueryChange,
  filters,
  actions,
  rows = [],
  children,
  notice,
  empty,
  loading,
  targetOptions = [],
}: {
  title: ReactNode;
  summary?: ReactNode;
  tabs: readonly ExtensionTab[];
  selectedId: string;
  onSelect(id: string): void;
  query: string;
  onQueryChange(value: string): void;
  filters?: ReactNode;
  actions?: ReactNode;
  rows?: readonly ExtensionRow[];
  children?: ReactNode;
  notice?: ReactNode;
  empty?: ReactNode;
  loading?: boolean;
  targetOptions?: readonly { id: string; label: string }[];
}) {
  const { t } = useI18n();
  const panelId = useId();
  const current = tabs.find((tab) => tab.id === selectedId);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [targetFilter, setTargetFilter] = useState("all");
  const hasActiveFilters =
    !!query ||
    sourceFilter !== "all" ||
    statusFilter !== "all" ||
    targetFilter !== "all";
  const clearFilters = () => {
    onQueryChange("");
    setSourceFilter("all");
    setStatusFilter("all");
    setTargetFilter("all");
  };
  const visibleRows = rows.filter(
    (row) =>
      (sourceFilter === "all" || row.sourceId === sourceFilter) &&
      (statusFilter === "all" ||
        row.enabled === (statusFilter === "enabled")) &&
      (targetFilter === "all" || row.targetIds?.includes(targetFilter)) &&
      (!query || row.title.toLowerCase().includes(query.toLowerCase())),
  );
  return (
    <section
      className={clsx("view-panel tab-view", styles.view)}
      data-view="extensions"
    >
      <div className={styles.page}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <h2>{title}</h2>
            <small>{summary}</small>
          </div>
          <nav
            className={styles.workspaceNav}
            role="tablist"
            aria-label={
              typeof title === "string"
                ? title
                : t("settings.extensionWorkspaceNav")
            }
          >
            {tabs.map((workspace) => {
              const active = selectedId === workspace.id;
              return (
                <button
                  key={workspace.id}
                  className={clsx(
                    styles.workspaceNavItem,
                    active && styles.active,
                  )}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={panelId}
                  data-id={workspace.id}
                  onClick={() => onSelect(workspace.id)}
                >
                  {workspace.icon}
                  <span>{workspace.label}</span>
                  <small>{loading ? "…" : (workspace.count ?? 0)}</small>
                </button>
              );
            })}
          </nav>
        </aside>

        <main
          className={styles.workspace}
          id={panelId}
          role="tabpanel"
          aria-label={current?.label}
        >
          <header className={styles.header}>
            <div>
              <h1>{current?.label}</h1>
              <p>{current?.description}</p>
            </div>
          </header>

          <div className={styles.toolbar}>
            <label className={styles.searchField}>
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                value={query}
                aria-label={t("settings.extensionSearch")}
                placeholder={t("settings.extensionSearchPlaceholder")}
                onChange={(event) => onQueryChange(event.target.value)}
              />
            </label>
            <select
              className={styles.filterSelect}
              value={sourceFilter}
              aria-label={t("settings.extensionSourceFilter")}
              onChange={(event) => setSourceFilter(event.target.value)}
            >
              <option value="all">{t("settings.extensionAllSources")}</option>
              <option value="user">{t("settings.extensionOriginUser")}</option>
              <option value="native">
                {t("settings.extensionOriginNative")}
              </option>
              <option value="unknown">{t("common.unknown")}</option>
            </select>
            <select
              className={styles.filterSelect}
              value={statusFilter}
              aria-label={t("settings.extensionStatusFilter")}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">{t("settings.extensionAllStatuses")}</option>
              <option value="enabled">
                {t("settings.extensionHasEnabledDeployments")}
              </option>
              <option value="disabled">
                {t("settings.extensionHasNoEnabledDeployments")}
              </option>
            </select>
            <select
              className={styles.filterSelect}
              value={targetFilter}
              aria-label={t("settings.extensionTargetFilter")}
              onChange={(event) => setTargetFilter(event.target.value)}
            >
              <option value="all">{t("settings.extensionAllTargets")}</option>
              <option value="local">
                {t("settings.extensionLocalTarget")}
              </option>
              {targetOptions.map((kernel) => (
                <option key={kernel.id} value={kernel.id}>
                  {kernel.label}
                </option>
              ))}
            </select>
            {filters}
            {actions}
          </div>
          <div className={styles.resultsMeta}>
            <span>
              {t("settings.extensionResultsCount", {
                visible: visibleRows.length,
                total: rows.length,
              })}
            </span>
            {hasActiveFilters ? (
              <button type="button" onClick={clearFilters}>
                {t("settings.extensionClearFilters")}
              </button>
            ) : null}
          </div>

          <section className={styles.workspaceContent}>
            {notice}
            {loading ? (
              <ExtensionsLoadingState />
            ) : (
              (children ??
              (!visibleRows.length ? (
                <div className={styles.emptyState}>
                  {empty ?? t("settings.extensionNoResultsTitle")}
                </div>
              ) : selectedId === "skills" ? (
                <SkillTable rows={visibleRows} />
              ) : (
                <ManagementList rows={visibleRows} />
              )))
            )}
          </section>
        </main>
      </div>
    </section>
  );
}
function ManagementList({ rows }: { rows: readonly ExtensionRow[] }) {
  return (
    <div className={styles.managerList}>
      {rows.map((row) => (
        <article className={styles.managerRow} key={row.id}>
          <div className={styles.managerMain}>
            <span className={styles.kindIcon}>{row.icon}</span>
            <div className={styles.managerCopy}>
              <div className={styles.managerTitleLine}>
                {row.onOpen ? (
                  <button
                    type="button"
                    className={styles.titleButton}
                    onClick={row.onOpen}
                  >
                    {row.title}
                  </button>
                ) : (
                  <strong>{row.title}</strong>
                )}
                <span className={styles.sourceTag} data-source={row.sourceId}>
                  {row.source}
                </span>
                {row.kind ? (
                  <span className={styles.miniBadge}>{row.kind}</span>
                ) : null}
              </div>
              <small>{row.description}</small>
              {row.metadata ? (
                <div className={styles.managerMeta}>{row.metadata}</div>
              ) : null}
            </div>
          </div>
          <div className={styles.managerTargets}>{row.targets}</div>
        </article>
      ))}
    </div>
  );
}
function SkillTable({ rows }: { rows: readonly ExtensionRow[] }) {
  const { t } = useI18n();
  return (
    <div className={clsx(styles.table, styles.skillTable)}>
      <div className={styles.tableHeader} aria-hidden="true">
        <span>{t("settings.extensionTableExtension")}</span>
        <span>{t("settings.extensionTableTargets")}</span>
      </div>
      {rows.map((row) => (
        <article className={styles.tableRow} key={row.id}>
          <div className={styles.identity} data-kind="skill">
            <span className={styles.title}>
              <span className={styles.titleMain}>
                {row.onOpen ? (
                  <span className={styles.titleTooltip}>
                    <button
                      className={styles.titleButton}
                      type="button"
                      onClick={row.onOpen}
                    >
                      {row.title}
                    </button>
                  </span>
                ) : (
                  <strong>{row.title}</strong>
                )}
                {row.source ? (
                  <span className={styles.sourceTag} data-source={row.sourceId}>
                    {row.source}
                  </span>
                ) : null}
                {row.metadata}
              </span>
              <small>{row.description}</small>
            </span>
          </div>
          {row.targets}
        </article>
      ))}
    </div>
  );
}
function ExtensionsLoadingState() {
  const { t } = useI18n();
  return (
    <div
      className={clsx(styles.table, styles.skillTable, styles.loadingTable)}
      role="status"
      aria-label={t("mountedApp.loading")}
    >
      <div className={styles.tableHeader} aria-hidden="true">
        <span>{t("settings.extensionTableExtension")}</span>
        <span>{t("settings.extensionTableTargets")}</span>
      </div>
      {[0, 1, 2, 3, 4].map((index) => (
        <div className={styles.tableRow} aria-hidden="true" key={index}>
          <div className="og-skeleton-stack">
            <span
              className="og-skeleton og-skeleton-line"
              style={{ width: index % 2 ? "58%" : "72%" }}
            />
            <span
              className="og-skeleton og-skeleton-line"
              style={{ width: "88%" }}
            />
          </div>
          <span
            className="og-skeleton og-skeleton-line"
            style={{ width: index % 2 ? "46%" : "62%" }}
          />
        </div>
      ))}
    </div>
  );
}
