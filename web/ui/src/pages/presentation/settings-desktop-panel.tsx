// Extracted from web/src/components/sidebar/settings-desktop-panel.tsx at 8b365ed. See source-manifest.json for boundary changes.
import type { ReactNode } from "react";
import { useI18n, rawDiagnosticText } from "./i18n";
export function SettingsDesktopPanel(props: {
  frontendVersion?: string;
  serviceVersion?: string;
  serviceStatus?: string;
  startedAt?: string;
  exporting?: boolean;
  exportedFileName?: string;
  exportedEvidenceComplete?: boolean;
  error?: string;
  onExport?(): void;
  storage?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const { exporting, exportedFileName, exportedEvidenceComplete, error } =
    props;
  const exportDiagnostics = props.onExport;
  return (
    <div className="settings-page-stack">
      <section className="settings-list-section">
        <div className="settings-list-section-heading">
          <h2>{t("settings.desktopApp")}</h2>
        </div>
        <div className="settings-list">
          <DesktopInfoRow
            label={t("settings.webFrontendVersion")}
            value={props.frontendVersion ?? "—"}
          />
          <DesktopInfoRow
            label={t("settings.webServiceVersion")}
            value={props.serviceVersion ?? "—"}
          />
          <DesktopInfoRow
            label={t("settings.webServiceStatus")}
            value={props.serviceStatus ?? "—"}
          />
          <DesktopInfoRow
            label={t("settings.webServiceStartedAt")}
            value={props.startedAt ?? "—"}
          />
        </div>
        <p className="settings-help">{t("settings.desktopNotDesktopCopy")}</p>
        <div className="settings-form-actions">
          <button
            type="button"
            onClick={exportDiagnostics}
            disabled={exporting || !props.onExport}
          >
            {exporting
              ? t("settings.desktopExporting")
              : t("settings.desktopExportDiagnostics")}
          </button>
        </div>
        {error ? (
          <p className="settings-warning">{rawDiagnosticText(error)}</p>
        ) : null}
        {exportedFileName ? (
          <p className="settings-success">
            {t("settings.desktopExported", { fileName: exportedFileName })}
          </p>
        ) : null}
        {exportedEvidenceComplete === false ? (
          <p className="settings-warning">
            {t("settings.desktopExportIncomplete")}
          </p>
        ) : null}
      </section>
      {props.storage}
      {props.children}
    </div>
  );
}
export function DesktopInfoRow(props: { label: string; value: string }) {
  return (
    <div className="settings-list-row">
      <span className="settings-list-row-main">
        <strong>{props.label}</strong>
      </span>
      <span className="settings-desktop-metric-value">
        {props.value || "—"}
      </span>
    </div>
  );
}
export function DesktopActionRow(props: {
  label: string;
  description: string;
  actionLabel: string;
  disabled?: boolean;
  tone?: "default" | "danger";
  onAction(): void | Promise<void>;
}) {
  return (
    <div className="settings-list-row settings-desktop-action-row">
      <span className="settings-list-row-main">
        <strong>{props.label}</strong>
        <small>{props.description}</small>
      </span>
      <button
        className={
          props.tone === "danger"
            ? "settings-row-button danger"
            : "settings-row-button"
        }
        type="button"
        disabled={props.disabled}
        onClick={() => void props.onAction()}
      >
        {props.actionLabel}
      </button>
    </div>
  );
}
