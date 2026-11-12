// Extracted from web/src/components/network/app-version-management-page.tsx at 8b365ed. See source-manifest.json for boundary changes.
import { useId, type ReactNode } from "react";
import {
  ArrowLeft,
  AlertTriangle,
  Save,
  LoaderCircle,
  CircleStop,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@olorinm/agent-ui/app";
import { useI18n } from "./presentation/i18n";
export interface VersionRow {
  id: string;
  title: string;
  selected?: boolean;
  status?: ReactNode;
  published?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}
export function VersionHistory({
  title,
  description,
  icon,
  onBack,
  backLabel,
  notice,
  overview = [],
  draft,
  sections = [],
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  onBack(): void;
  backLabel: string;
  notice?: ReactNode;
  overview?: readonly {
    label: string;
    value: ReactNode;
    tone?: "warning" | "success";
  }[];
  draft?: { title: string; description?: ReactNode; content: ReactNode };
  sections?: readonly {
    id: string;
    title: string;
    description?: ReactNode;
    rows: readonly VersionRow[];
    empty?: ReactNode;
  }[];
}) {
  return (
    <section className="app-store-version-page">
      <header className="app-store-publish-header">
        <div className="app-store-publish-header-title">
          <button
            type="button"
            className="app-store-publish-back"
            onClick={onBack}
            aria-label={backLabel}
          >
            <ArrowLeft size={18} />
          </button>
          {icon}
          <div>
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
        </div>
      </header>
      {notice}
      <div className="app-store-version-content">
        <section className="app-store-version-overview">
          {overview.map((item) => (
            <VersionOverviewItem key={item.label} {...item} />
          ))}
        </section>
        {draft ? (
          <section className="app-store-publish-section">
            <div className="app-store-publish-section-heading">
              <h2>{draft.title}</h2>
              <p>{draft.description}</p>
            </div>
            <div className="app-store-version-draft-row">{draft.content}</div>
          </section>
        ) : null}
        {sections.map((section) => (
          <section key={section.id} className="app-store-publish-section">
            <div className="app-store-publish-section-heading">
              <h2>{section.title}</h2>
              <p>{section.description}</p>
            </div>
            <div className="app-store-version-list">
              {section.rows.map((row) => (
                <VersionRecord key={row.id} row={row} />
              ))}
              {!section.rows.length ? (
                <p className="app-store-version-empty">{section.empty}</p>
              ) : null}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
function VersionOverviewItem(props: {
  label: string;
  value: ReactNode;
  tone?: "warning" | "success";
}) {
  return (
    <div
      className="app-store-version-overview-item"
      data-tone={props.tone ?? "neutral"}
    >
      <small>{props.label}</small>
      <strong>{props.value}</strong>
    </div>
  );
}
function VersionRecord({ row }: { row: VersionRow }) {
  return (
    <article
      className="app-store-version-row"
      data-selected={row.selected ? "true" : "false"}
    >
      <div className="app-store-version-row-main">
        <strong>{row.title}</strong>
        <div className="app-store-version-badges">{row.status}</div>
        <small>{row.published}</small>
        {row.description ? <p>{row.description}</p> : null}
      </div>
      {row.actions}
    </article>
  );
}
export function VersionSwitchBlocker(props: {
  kind: "unsaved" | "active-runs";
  pending: boolean;
  onSave(): void;
  onContinue(): void;
  onCancel(): void;
}) {
  const { t } = useI18n();
  const descriptionId = useId();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogContent
        className="app-store-version-blocker"
        aria-describedby={descriptionId}
      >
        <div>
          <AlertTriangle size={20} />
          <div>
            <DialogTitle>
              {props.kind === "unsaved"
                ? t("appStore.version.unsavedTitle")
                : t("appStore.version.activeRunsTitle")}
            </DialogTitle>
            <p id={descriptionId}>
              {props.kind === "unsaved"
                ? t("appStore.version.unsavedBody")
                : t("appStore.version.activeRunsBody")}
            </p>
          </div>
        </div>
        <div className="app-store-version-blocker-actions">
          {props.kind === "unsaved" ? (
            <button
              type="button"
              className="og-button"
              disabled={props.pending}
              onClick={props.onSave}
            >
              <Save size={15} />
              {t("appStore.version.goSave")}
            </button>
          ) : null}
          <button
            type="button"
            className="og-button og-button--danger"
            disabled={props.pending}
            onClick={props.onContinue}
          >
            {props.pending ? (
              <LoaderCircle className="app-store-publish-spinner" size={15} />
            ) : (
              <CircleStop size={15} />
            )}
            {props.kind === "unsaved"
              ? t("appStore.version.discardAndSwitch")
              : t("appStore.version.forceStopAndSwitch")}
          </button>
          <button
            type="button"
            className="og-button"
            disabled={props.pending}
            onClick={props.onCancel}
          >
            {t("common.cancel")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
