// Extracted from web/src/components/sidebar/settings-update-panel.tsx at 8b365ed. See source-manifest.json for boundary changes.
import type { ReactNode } from "react";
import { ProductIcon } from "@olorinm/agent-ui/app";
import { useI18n, rawDiagnosticText } from "./i18n";
export function SettingsUpdatePanel(props: {
  currentVersion: string;
  latestLabel?: string;
  updateAvailable?: boolean;
  releaseNotes?: ReactNode;
  loading?: boolean;
  error?: string;
  checking?: boolean;
  checked?: boolean;
  downloading?: boolean;
  actionLabel?: string;
  automaticDownload?: boolean;
  onCheck?(): void;
  onDownload?(): void;
  onAutomaticDownloadChange?(value: boolean): void;
}) {
  const { t } = useI18n();
  const { currentVersion, latestLabel, updateAvailable, checking, checked } =
    props;
  const autoDownload = !!props.automaticDownload;
  const actionLabel = props.actionLabel ?? t("settings.updateDownload");
  return (
    <div className="settings-page-stack settings-update-page">
      {updateAvailable ? (
        <section
          className="settings-update-available-card"
          aria-label={t("settings.updateAvailableTitle")}
        >
          <div className="settings-update-available-header">
            <span className="settings-update-app-icon" aria-hidden="true">
              <ProductIcon name="download" size={22} />
            </span>
            <span className="settings-update-release-copy">
              <strong>{t("settings.updateAvailableTitle")}</strong>
              <small>{latestLabel}</small>
            </span>
            <button
              className="settings-row-button"
              type="button"
              disabled={
                checking ||
                props.loading ||
                props.downloading ||
                !props.onDownload
              }
              onClick={props.onDownload}
            >
              {actionLabel}
            </button>
          </div>
          {props.releaseNotes}
          <small className="settings-update-source-note">
            {t("settings.updateNotesFromService")}
          </small>
        </section>
      ) : null}

      <section className="settings-list-section">
        <div className="settings-list">
          <div className="settings-list-row settings-update-status-row">
            <span className="settings-list-row-main">
              <strong>{t("settings.updateInstalled")}</strong>
            </span>
            <span className="settings-desktop-metric-value">
              {currentVersion}
            </span>
          </div>
          <div className="settings-list-row settings-desktop-action-row">
            <span className="settings-list-row-main">
              <strong>{t("settings.updateCheck")}</strong>
              <small>{t("settings.updateCheckCopy")}</small>
            </span>
            <span className="settings-update-check-control">
              {checked && !updateAvailable && !checking && !props.loading ? (
                <small className="settings-update-check-result">
                  {t("settings.updateUpToDate")}
                </small>
              ) : null}
              <button
                className="settings-row-button"
                type="button"
                disabled={checking || props.loading || !props.onCheck}
                onClick={props.onCheck}
              >
                {checking || props.loading
                  ? t("settings.updateChecking")
                  : t("settings.updateCheck")}
              </button>
            </span>
          </div>
        </div>
      </section>

      {props.onAutomaticDownloadChange && true ? (
        <section className="settings-list-section">
          <div className="settings-list-section-heading">
            <h2>{t("settings.updateAutomatic")}</h2>
          </div>
          <div className="settings-list">
            <div className="settings-list-row settings-update-auto-row">
              <span className="settings-list-row-main">
                <strong>{t("settings.updateAutoDownload")}</strong>
                <small>{t("settings.updateAutoDownloadCopy")}</small>
              </span>
              <button
                className={
                  autoDownload
                    ? "settings-provider-enable-button settings-mode-switch-button enabled"
                    : "settings-provider-enable-button settings-mode-switch-button"
                }
                type="button"
                role="switch"
                aria-checked={autoDownload}
                aria-label={t("settings.updateAutoDownload")}
                onClick={() => props.onAutomaticDownloadChange?.(!autoDownload)}
              >
                <span aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {props.error ? (
        <p className="settings-warning">{rawDiagnosticText(props.error)}</p>
      ) : null}
    </div>
  );
}
