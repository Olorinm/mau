// Original native desktop settings presentation. Native bridge and reset confirmation belong to caller.
import type {ReactNode} from "react";
import {useI18n, rawDiagnosticText} from "./i18n";
import {DesktopActionRow} from "./settings-desktop-panel";
export function SettingsNativeDesktopPanel(props: {
 serviceStatus?: string; busy?: boolean; exporting?: boolean; error?: string; exportedFileName?: string; exportedEvidenceComplete?: boolean;
 onRestart?(): void; onOpenData?(): void; onReset?(): void; onExport?(): void; storage?: ReactNode;
}) {const {t} = useI18n(); const {busy, exporting, error, exportedFileName, exportedEvidenceComplete} = props;
  return (
    <div className="settings-page-stack">
      <section className="settings-list-section">
        <div className="settings-list-section-heading">
          <h2>{t("settings.desktopApp")}</h2>
        </div>
        <div className="settings-list settings-desktop-list">
          <div className="settings-list-row settings-update-status-row">
            <span className="settings-list-row-main">
              <strong>{t("settings.webServiceStatus")}</strong>
            </span>
            <span className="settings-desktop-metric-value">
              {props.serviceStatus ?? "—"}
            </span>
          </div>
          <DesktopActionRow
            label={t("settings.desktopRestartBridge")}
            description={t("settings.desktopRestartBridgeCopy")}
            actionLabel={t("settings.desktopRestartBridge")}
            disabled={busy || !props.onRestart}
            onAction={() => props.onRestart?.()}
          />
          <DesktopActionRow
            label={t("settings.desktopOpenDataDir")}
            description={t("settings.desktopOpenDataDirCopy")}
            actionLabel={t("settings.desktopOpenDataDir")}
            disabled={busy || !props.onOpenData}
            onAction={() => void props.onOpenData?.()}
          />
          <DesktopActionRow
            label={t("settings.desktopExportDiagnostics")}
            description={t("settings.desktopExportDiagnosticsCopy")}
            actionLabel={exporting ? t("settings.desktopExporting") : t("settings.desktopExportDiagnostics")}
            disabled={busy || exporting || !props.onExport}
            onAction={() => props.onExport?.()}
          />
        </div>
        {error ? <p className="settings-warning">{rawDiagnosticText(error)}</p> : null}
        {exportedFileName ? (
          <p className="settings-success">{t("settings.desktopExported", { fileName: exportedFileName })}</p>
        ) : null}
        {exportedEvidenceComplete === false ? (
          <p className="settings-warning">{t("settings.desktopExportIncomplete")}</p>
        ) : null}
      </section>

      {props.storage}

      <section className="settings-list-section">
        <div className="settings-list-section-heading">
          <h2>{t("settings.desktopResetData")}</h2>
        </div>
        <div className="settings-list">
          <DesktopActionRow
            label={t("settings.desktopResetData")}
            description={t("settings.desktopResetDataCopy")}
            actionLabel={t("settings.desktopResetData")}
            tone="danger"
            disabled={busy || !props.onReset}
            onAction={() => props.onReset?.()}
          />
        </div>
      </section>
    </div>
  );
}
