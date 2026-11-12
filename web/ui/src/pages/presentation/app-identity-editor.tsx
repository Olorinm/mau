// Extracted from web/src/components/apps/app-identity-editor.tsx at 8b365ed. See source-manifest.json for boundary changes.
import { useI18n } from "./i18n";
import { AppIconPickerField } from "./app-icon-picker";
import styles from "../styles/app-identity.module.css";

export interface AppIdentityDraft {
  title: string;
  description: string;
  icon?: string;
}

export function AppIdentityEditor(props: {
  appId?: string;
  value: AppIdentityDraft;
  disabled?: boolean;
  onChange(value: AppIdentityDraft): void;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.editor}>
      <AppIconPickerField
        appId={props.appId}
        value={props.value.icon}
        title={props.value.title || t("app.createApp")}
        disabled={props.disabled}
        onChange={(icon) => props.onChange({ ...props.value, icon })}
      />
      <div className={styles.fields}>
        <label className={styles.row}>
          <span>
            {t("appStore.release.nameLabel")} <em>*</em>
          </span>
          <input
            value={props.value.title}
            disabled={props.disabled}
            onChange={(event) =>
              props.onChange({ ...props.value, title: event.target.value })
            }
          />
        </label>
        <label className={`${styles.row} ${styles.stacked}`}>
          <span>{t("appStore.release.descriptionLabel")}</span>
          <textarea
            value={props.value.description}
            disabled={props.disabled}
            rows={4}
            onChange={(event) =>
              props.onChange({
                ...props.value,
                description: event.target.value,
              })
            }
          />
        </label>
      </div>
    </div>
  );
}
