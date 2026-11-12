// Extracted from web/src/components/sidebar/settings-mode-panel.tsx at 8b365ed. See source-manifest.json for boundary changes.
import type { TranslationFn } from "./i18n";

export function SettingsModePanel(props: {
  t: TranslationFn;
  developerMode: boolean;
  loading: boolean;
  saving: boolean;
  onSaveDeveloperMode(value: boolean): void;
}) {
  const { t } = props;

  return (
    <div className="settings-page-stack">
      <section className="settings-list-section">
        <div className="settings-list">
          <div className="settings-list-row">
            <span className="settings-list-row-main">
              <strong>{t("settings.developerMode")}</strong>
            </span>
            <button
              className={
                props.developerMode
                  ? "settings-provider-enable-button settings-mode-switch-button enabled"
                  : "settings-provider-enable-button settings-mode-switch-button"
              }
              type="button"
              role="switch"
              aria-checked={props.developerMode}
              aria-label={t("settings.developerMode")}
              disabled={props.loading || props.saving}
              onClick={() => props.onSaveDeveloperMode(!props.developerMode)}
            >
              <span aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
