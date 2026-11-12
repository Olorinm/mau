// Extracted from web/src/components/sidebar/settings-appearance-panel.tsx at 8b365ed. See source-manifest.json for boundary changes.
type IconStylePreference = string;
import type { TranslationFn } from "./i18n";
type LanguagePreference = string;
type ThemePreference = string;
import { InlineSelect, type InlineSelectOption } from "../ui/inline-select";

export function SettingsAppearancePanel(props: {
  t: TranslationFn;
  themePreference: ThemePreference;
  themeSelectOptions: InlineSelectOption[];
  iconStylePreference: IconStylePreference;
  iconStyleSelectOptions: InlineSelectOption[];
  languagePreference: LanguagePreference;
  languageSelectOptions: InlineSelectOption[];
  onSetThemePreference(value: ThemePreference): void;
  onSetIconStylePreference(value: IconStylePreference): void;
  onSetLanguagePreference(value: LanguagePreference): void;
}) {
  const { t } = props;

  return (
    <div className="settings-page-stack">
      <section className="settings-list-section settings-appearance-section">
        <div className="settings-list settings-preference-list">
          <div className="settings-list-row settings-preference-row">
            <span className="settings-list-row-main">
              <strong>{t("settings.theme")}</strong>
            </span>
            <span className="settings-list-row-control wide">
              <InlineSelect
                value={props.themePreference}
                options={props.themeSelectOptions}
                menuSize="regular"
                onChange={(value) =>
                  props.onSetThemePreference(value as ThemePreference)
                }
              />
            </span>
          </div>
          <div className="settings-list-row settings-preference-row">
            <span className="settings-list-row-main">
              <strong>{t("settings.iconStyle")}</strong>
            </span>
            <span className="settings-list-row-control wide">
              <InlineSelect
                value={props.iconStylePreference}
                options={props.iconStyleSelectOptions}
                menuSize="regular"
                onChange={(value) =>
                  props.onSetIconStylePreference(value as IconStylePreference)
                }
              />
            </span>
          </div>
          <div className="settings-list-row settings-preference-row">
            <span className="settings-list-row-main">
              <strong>{t("settings.language")}</strong>
            </span>
            <span className="settings-list-row-control wide">
              <InlineSelect
                value={props.languagePreference}
                options={props.languageSelectOptions}
                menuSize="regular"
                onChange={(value) =>
                  props.onSetLanguagePreference(value as LanguagePreference)
                }
              />
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
