// Original settings operations panel from ops-center-view.tsx at 8b365ed.
// Products supply ordered, formatted display records; no event normalization or run orchestration.
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "@olorinm/agent-ui/app";
import { useI18n } from "./i18n";
import "../styles/operations.css";
export interface OperationRunView {
  id: string;
  title: string;
  meta?: string;
  tone: "danger" | "live" | "good";
  icon?: ReactNode;
  sourceLabel: string;
  statusLabel: string;
  dateLabel: string;
  modelLabel?: string;
  durationLabel: string;
  activityLabel?: string;
  eventCount: number;
  toolCount: number;
  result: string;
  input: string;
  sections: readonly {
    id: string;
    title: string;
    emptyLabel: string;
    records: readonly { id: string; title: string; detail: string }[];
  }[];
}
export function SettingsOperationsPanel(props: {
  runs: readonly OperationRunView[];
  selectedId?: string;
  onSelect(id: string): void;
  metrics: readonly {
    id: string;
    label: string;
    value: string;
    meta: string;
    tone?: "good" | "warning" | "danger" | "muted";
    onClick?(): void;
  }[];
}) {
  const { t } = useI18n();
  return (
    <div className="ops-settings-page">
      <section className="ops-settings-hero" aria-label={t("ops.overview")}>
        <div className="ops-settings-metric-grid" aria-label={t("ops.metrics")}>
          {props.metrics.map((metric) => (
            <OpsMetricTile key={metric.id} {...metric} />
          ))}
        </div>
      </section>
      <section
        className="ops-settings-run-log"
        aria-label={t("ops.recentRuns")}
      >
        <header className="ops-settings-log-head">
          <div>
            <h2>{t("ops.recentRuns")}</h2>
          </div>
          <span>{props.runs.length}</span>
        </header>
        <div className="ops-settings-run-list">
          {props.runs.length ? (
            props.runs.map((run) => (
              <OpsSettingsRunItem
                key={run.id}
                run={run}
                open={props.selectedId === run.id}
                onOpen={props.onSelect}
              />
            ))
          ) : (
            <EmptyState
              illustration="grove"
              title={t("ops.noRunTitle")}
              description={t("ops.emptyDescription")}
            />
          )}
        </div>
      </section>
    </div>
  );
}
function OpsSettingsRunItem(props: {
  run: OperationRunView;
  open: boolean;
  onOpen(id: string): void;
}) {
  const { t } = useI18n();
  return (
    <details
      className="ops-settings-run-entry"
      data-state={props.run.tone}
      open={props.open}
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.currentTarget.open !== props.open) {
          props.onOpen(event.currentTarget.open ? props.run.id : "");
        }
      }}
    >
      <summary className="ops-settings-run-summary" title={props.run.meta}>
        {props.run.icon}
        <span className="ops-settings-run-summary-main">
          <strong>{props.run.title}</strong>
          <small>
            {[
              props.run.sourceLabel,
              props.run.statusLabel,
              props.run.dateLabel || t("ops.timeUnknown"),
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </span>
        <span className="ops-settings-run-summary-stats">
          <span>{props.run.modelLabel || t("ops.modelUnknown")}</span>
          <span>
            {String(props.run.eventCount)} {t("ops.events")}
          </span>
        </span>
        <ChevronRight className="ops-settings-run-chevron" size={17} />
      </summary>

      <div className="ops-settings-run-detail">
        <div
          className="ops-settings-detail-facts"
          aria-label={t("ops.selectedRunMeta")}
        >
          <span>
            <strong>{t("settings.extensionTableSource")}</strong>
            {props.run.sourceLabel}
          </span>
          <span>
            <strong>{t("ops.duration")}</strong>
            {props.run.durationLabel}
          </span>
          <span>
            <strong>{t("ops.lastActivity")}</strong>
            {props.run.activityLabel || t("ops.timeUnknown")}
          </span>
          <span>
            <strong>{t("ops.tools")}</strong>
            {String(props.run.toolCount)}
          </span>
          <span>
            <strong>Run</strong>
            {props.run.id}
          </span>
        </div>

        <section className="ops-settings-detail-section">
          <OpsSettingsTitle
            title={t("ops.result")}
            meta={props.run.result ? t("ops.modelResponse") : t("ops.empty")}
          />
          <div className="ops-readable-block ops-settings-readable">
            {props.run.result || t("ops.noResult")}
          </div>
        </section>

        <details className="ops-settings-inline-foldout">
          <summary>
            <span>
              <strong>{t("ops.context")}</strong>
            </span>
            <ChevronRight className="ops-settings-foldout-chevron" size={16} />
          </summary>
          <div className="ops-readable-block ops-settings-readable">
            {props.run.input || t("ops.noContext")}
          </div>
        </details>

        <div className="ops-settings-foldout-grid">
          {props.run.sections.map((section) => (
            <details className="ops-settings-inline-foldout" key={section.id}>
              <summary>
                <span>
                  <strong>{section.title}</strong>
                </span>
                <small className="ops-settings-foldout-meta">
                  {section.records.length}
                </small>
                <ChevronRight
                  className="ops-settings-foldout-chevron"
                  size={16}
                />
              </summary>
              <div className="ops-record-list">
                {section.records.length ? (
                  section.records.map((record) => (
                    <div className="paper-row small" key={record.id}>
                      <span>
                        <strong>{record.title}</strong>
                        <small>{record.detail}</small>
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="paper-empty-row">{section.emptyLabel}</div>
                )}
              </div>
            </details>
          ))}
        </div>
      </div>
    </details>
  );
}
function OpsSettingsTitle(props: { title: string; meta: string }) {
  return (
    <header className="ops-settings-section-title">
      <h3>{props.title}</h3>
      <span>{props.meta}</span>
    </header>
  );
}

function OpsMetricTile(props: {
  label: string;
  value: string;
  meta: string;
  tone?: "good" | "warning" | "danger" | "muted";
  onClick?(): void;
}) {
  if (props.onClick) {
    return (
      <button
        className="ops-settings-metric ops-settings-metric-button"
        data-tone={props.tone || "neutral"}
        type="button"
        onClick={props.onClick}
      >
        <span>{props.label}</span>
        <strong>{props.value}</strong>
        <small>{props.meta}</small>
      </button>
    );
  }
  return (
    <div className="ops-settings-metric" data-tone={props.tone || "neutral"}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <small>{props.meta}</small>
    </div>
  );
}
