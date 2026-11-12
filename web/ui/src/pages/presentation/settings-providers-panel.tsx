// Original provider rows and editor from settings-provider-section.tsx at 8b365ed.
// Provider discovery, model routing, credential policies and persistence stay in the product.
import { Check, ChevronDown, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "./i18n";
export interface ProviderDraft {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
  description: string;
}
export interface ProviderView {
  id: string;
  name: string;
  detail: string;
  source?: string;
  icon?: ReactNode;
  enabled: boolean;
  unavailable?: boolean;
  readOnly?: boolean;
}
export function ProviderEditor(props: {
  detailForm: ProviderDraft;
  protocolOptions: readonly { id: string; label: string }[];
  credentialsManaged?: boolean;
  editableProviderModels: string[];
  providerFormError?: string;
  providerSaveState?: "idle" | "saved";
  providerApiKeyVisible: boolean;
  saving?: boolean;
  readOnly?: boolean;
  onSaveProviderProfile(): void;
  onUpdateProviderField<K extends keyof ProviderDraft>(
    key: K,
    value: ProviderDraft[K],
  ): void;
  onUpdatePrimaryBaseUrl(value: string): void;
  onSetProviderModels(models: string[]): void;
  onUpdateProviderModel(index: number, value: string): void;
  onRemoveProviderModelAt(index: number): void;
  onAddProviderModel(): void;
  onToggleProviderApiKeyVisible(): void;
  onCloseProviderDetail(): void;
  onRemove?(): void;
}) {
  const { t } = useI18n();
  const renderProviderSaveButton = () => {
    const saved = props.providerSaveState === "saved" && !props.saving;
    return (
      <button
        className={saved ? "primary saved" : "primary"}
        type="button"
        disabled={props.saving}
        onClick={props.onSaveProviderProfile}
      >
        {saved ? <Check size={15} /> : <Plus size={15} />}
        {props.saving
          ? t("settings.providerSaving")
          : saved
            ? t("settings.providerSaved")
            : t("settings.saveProvider")}
      </button>
    );
  };

  const renderProviderApiKeyField = (readOnly?: boolean) => {
    const visibilityLabel = props.providerApiKeyVisible
      ? t("settings.hideApiKey")
      : t("settings.showApiKey");
    return (
      <>
        <span className="settings-field-label-row">
          <span>{t("settings.apiKey")}</span>
          <button
            aria-label={visibilityLabel}
            className="settings-secret-visibility-button"
            title={visibilityLabel}
            type="button"
            onClick={props.onToggleProviderApiKeyVisible}
          >
            {props.providerApiKeyVisible ? (
              <Eye size={14} />
            ) : (
              <EyeOff size={14} />
            )}
          </button>
        </span>
        <input
          autoComplete="off"
          type={props.providerApiKeyVisible ? "text" : "password"}
          value={props.detailForm.apiKey}
          readOnly={readOnly}
          onChange={(event) =>
            props.onUpdateProviderField("apiKey", event.target.value)
          }
          onBlur={readOnly ? undefined : props.onSaveProviderProfile}
          placeholder={t("settings.apiKeyPlaceholder")}
        />
      </>
    );
  };

  const renderProviderDetail = (modelKeyPrefix: string, readOnly = false) => (
    <section className="settings-provider-detail inline">
      <div className="settings-detail-section">
        <div className="settings-detail-section-heading">
          <h3>{t("settings.baseConfig")}</h3>
          {props.onRemove && !readOnly ? (
            <button
              className="settings-provider-heading-delete"
              type="button"
              onClick={() => props.onRemove?.()}
              aria-label={t("settings.removeProvider")}
            >
              <Trash2 size={14} />
            </button>
          ) : null}
        </div>
        <div className="settings-form-grid compact">
          <label>
            <span>{t("settings.providerName")}</span>
            <input
              value={props.detailForm.name}
              readOnly={readOnly}
              onChange={(event) =>
                props.onUpdateProviderField("name", event.target.value)
              }
              placeholder="Provider"
            />
          </label>
          <label>
            <span>{t("settings.providerId")}</span>
            <input
              value={props.detailForm.id}
              readOnly={readOnly}
              onChange={(event) =>
                props.onUpdateProviderField("id", event.target.value)
              }
              placeholder="provider"
            />
          </label>
          {!props.credentialsManaged ? (
            <>
              <div className="settings-form-wide">
                <span>{t("settings.protocol")}</span>
                <div className="settings-segmented">
                  {props.protocolOptions.map((option) => (
                    <button
                      key={option.id}
                      className={
                        props.detailForm.protocol === option.id ? "active" : ""
                      }
                      type="button"
                      disabled={readOnly}
                      onClick={() =>
                        props.onUpdateProviderField("protocol", option.id)
                      }
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <label>
                <span>{t("settings.apiBaseUrl")}</span>
                <input
                  value={props.detailForm.baseUrl}
                  readOnly={readOnly}
                  onChange={(event) =>
                    props.onUpdatePrimaryBaseUrl(event.target.value)
                  }
                  placeholder="https://example.com/v1"
                />
              </label>
              <label>{renderProviderApiKeyField(readOnly)}</label>
              <label>
                <span>{t("settings.apiKeyEnv")}</span>
                <input
                  value={props.detailForm.apiKeyEnv}
                  readOnly={readOnly}
                  onChange={(event) =>
                    props.onUpdateProviderField("apiKeyEnv", event.target.value)
                  }
                  onBlur={readOnly ? undefined : props.onSaveProviderProfile}
                  placeholder="PROVIDER_API_KEY"
                />
              </label>
            </>
          ) : null}
          <label className="settings-form-wide">
            <span>{t("settings.description")}</span>
            <input
              value={props.detailForm.description}
              readOnly={readOnly}
              onChange={(event) =>
                props.onUpdateProviderField("description", event.target.value)
              }
              placeholder={t("settings.providerDescriptionPlaceholder")}
            />
          </label>
        </div>
      </div>

      <div className="settings-detail-section">
        <div className="settings-detail-section-heading">
          <h3>{t("settings.availableModels")}</h3>
        </div>
        <div className="settings-model-row">
          {props.editableProviderModels.length ? (
            <span className="settings-provider-models editable">
              {props.editableProviderModels.map((model, index) => (
                <span
                  className="settings-model-chip"
                  key={`${modelKeyPrefix}-model-${index}`}
                >
                  <input
                    className="settings-model-chip-input"
                    value={model}
                    readOnly={readOnly}
                    size={Math.max(model.length, 6)}
                    onBlur={
                      readOnly
                        ? undefined
                        : () =>
                            props.onSetProviderModels(
                              props.editableProviderModels,
                            )
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                    onChange={(event) =>
                      props.onUpdateProviderModel(index, event.target.value)
                    }
                    aria-label={t("settings.models")}
                  />
                  {readOnly ? null : (
                    <button
                      type="button"
                      onClick={() => props.onRemoveProviderModelAt(index)}
                      aria-label={t("settings.removeModel")}
                    >
                      &times;
                    </button>
                  )}
                </span>
              ))}
            </span>
          ) : (
            <p className="settings-help">{t("settings.noProviderModels")}</p>
          )}
          {readOnly ? null : (
            <button
              className="settings-model-add-button"
              type="button"
              onClick={props.onAddProviderModel}
              aria-label={t("settings.addModel")}
            >
              <Plus size={14} />
            </button>
          )}
        </div>
      </div>

      {props.providerFormError ? (
        <p className="settings-warning">{props.providerFormError}</p>
      ) : null}
      <div className="settings-form-actions settings-provider-detail-actions">
        <span />
        <span>
          <button type="button" onClick={props.onCloseProviderDetail}>
            {t("common.cancel")}
          </button>
          {readOnly ? null : renderProviderSaveButton()}
        </span>
      </div>
    </section>
  );

  return renderProviderDetail(props.detailForm.id, props.readOnly);
}
export function SettingsProvidersPanel(props: {
  providers: readonly ProviderView[];
  selectedId?: string;
  disabled?: boolean;
  editor?: ReactNode;
  notice?: ReactNode;
  onSelect(id: string): void;
  onEnabledChange?(id: string, enabled: boolean): void;
  onAdd?(): void;
}) {
  const { t } = useI18n();
  const renderProviderItem = (provider: ProviderView) => {
    const active = props.selectedId === provider.id;
    return (
      <div
        key={provider.id}
        className={[
          "settings-provider-item",
          "settings-list-group",
          active ? "active" : "",
          provider.enabled ? "enabled" : "disabled",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="settings-list-row settings-provider-row choice">
          <button
            className="settings-provider-summary"
            disabled={props.disabled}
            type="button"
            onClick={() => props.onSelect(provider.id)}
          >
            <span className="settings-provider-logo">{provider.icon}</span>
            <span className="settings-provider-main">
              <strong>{provider.name}</strong>
              <small>{provider.detail}</small>
              {provider.source ? (
                <small className="settings-provider-source-line">
                  {provider.source}
                </small>
              ) : null}
            </span>
          </button>
          <span className="settings-provider-row-actions">
            {!!provider.unavailable ? (
              <span className="settings-provider-status-badge">
                {t("common.unavailable")}
              </span>
            ) : null}
            <button
              className={
                provider.enabled
                  ? "settings-provider-enable-button enabled"
                  : "settings-provider-enable-button"
              }
              type="button"
              role="switch"
              aria-checked={provider.enabled}
              aria-label={`${provider.name} ${provider.enabled ? t("settings.provider.enabled") : t("settings.providerDisabled")}`}
              disabled={props.disabled || !props.onEnabledChange}
              onClick={() =>
                props.onEnabledChange?.(provider.id, !provider.enabled)
              }
            >
              <span aria-hidden="true" />
            </button>
            <button
              className="settings-provider-icon-button"
              disabled={props.disabled}
              type="button"
              onClick={() => props.onSelect(provider.id)}
              aria-label={
                active ? t("common.cancel") : t("settings.baseConfig")
              }
            >
              <ChevronDown size={16} />
            </button>
          </span>
        </div>
        {active ? props.editor : null}
      </div>
    );
  };
  return (
    <div className="settings-providers-workspace">
      {props.notice}
      <section className="settings-provider-block">
        <div className="settings-provider-block-heading">
          <h2>{t("settings.reusableProviders")}</h2>
          <p>{t("settings.reusableProvidersCopy")}</p>
        </div>
        <div className="settings-list settings-provider-list">
          {props.providers.map(renderProviderItem)}
          <button
            className="settings-list-row settings-provider-add-row"
            type="button"
            disabled={props.disabled || !props.onAdd}
            onClick={props.onAdd}
          >
            <Plus size={15} />
            <span>{t("settings.addProvider")}</span>
          </button>
        </div>
      </section>
    </div>
  );
}
