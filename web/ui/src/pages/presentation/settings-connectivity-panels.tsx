// Extracted from web/src/components/sidebar/settings-connectivity-panels.tsx at 8b365ed. See source-manifest.json for boundary changes.
import type { KernelProxySettings } from "./settings-view-model";
import type { TranslationFn } from "./i18n";
import {
  effectiveProxyDescription,
  effectiveProxyValue,
} from "./settings-view-model";

export function SettingsNetworkPanel(props: {
  t: TranslationFn;
  kernelProxy: KernelProxySettings;
  showKernelProxy: boolean;
  serviceUrl: string;
  savedServiceUrl: string;
  serviceManaged: boolean;
  onSetServiceUrl(url: string): void;
  onSaveServiceUrl(): void;
  loading: boolean;
  saving: boolean;
  onSetKernelProxyDraft(patch: Partial<KernelProxySettings>): void;
  onSaveKernelProxy(patch?: Partial<KernelProxySettings>): void;
}) {
  const { t } = props;

  return (
    <div className="settings-page-stack">
      <section className="settings-list-section">
        <div className="settings-list-section-heading">
          <h2>{t("settings.remoteAgents")}</h2>
        </div>
        <form
          className="settings-list"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.loading && !props.saving && !props.serviceManaged)
              props.onSaveServiceUrl();
          }}
        >
          <label className="settings-list-row settings-list-row-field settings-router-url">
            <span className="settings-list-row-main">
              <strong>{t("settings.serviceUrl")}</strong>
              <small>{t("settings.serviceHint")}</small>
            </span>
            <input
              type="url"
              value={props.serviceUrl}
              placeholder={t("settings.servicePlaceholder")}
              maxLength={2048}
              autoComplete="off"
              spellCheck={false}
              readOnly={props.serviceManaged}
              disabled={props.loading || props.saving}
              onChange={(event) => props.onSetServiceUrl(event.target.value)}
            />
          </label>
          <div className="settings-list-row">
            <span className="settings-list-row-main">
              <small>
                {props.serviceManaged
                  ? t("settings.serviceManaged")
                  : t("settings.serviceSaveHint")}
              </small>
            </span>
            {!props.serviceManaged ? (
              <button
                type="submit"
                className="ghost-button"
                disabled={
                  props.loading ||
                  props.saving ||
                  props.serviceUrl.trim() === props.savedServiceUrl
                }
              >
                {props.saving
                  ? t("common.saving")
                  : t("settings.saveServiceAddress")}
              </button>
            ) : null}
          </div>
        </form>
      </section>
      {props.showKernelProxy ? (
        <section className="settings-list-section">
          <div className="settings-list-section-heading">
            <h2>{t("settings.proxy")}</h2>
          </div>
          <div className="settings-list">
            <label className="settings-list-row">
              <span className="settings-list-row-main">
                <strong>{t("settings.kernelProxy")}</strong>
                <small>{t("settings.kernelProxyCopy")}</small>
              </span>
              <input
                type="checkbox"
                checked={props.kernelProxy.enabled}
                disabled={props.loading || props.saving}
                onChange={(event) =>
                  props.onSaveKernelProxy({ enabled: event.target.checked })
                }
              />
            </label>
            <label className="settings-list-row settings-list-row-field">
              <span className="settings-list-row-main">
                <strong>{t("settings.proxyUrl")}</strong>
              </span>
              <input
                value={props.kernelProxy.proxyUrl}
                disabled={
                  props.loading || props.saving || !props.kernelProxy.enabled
                }
                placeholder="http://127.0.0.1:7890"
                onBlur={() => props.onSaveKernelProxy()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
                onChange={(event) =>
                  props.onSetKernelProxyDraft({ proxyUrl: event.target.value })
                }
              />
            </label>
            <label className="settings-list-row settings-list-row-field">
              <span className="settings-list-row-main">
                <strong>{t("settings.noProxy")}</strong>
              </span>
              <input
                value={props.kernelProxy.noProxy}
                disabled={
                  props.loading || props.saving || !props.kernelProxy.enabled
                }
                placeholder="127.0.0.1,localhost,::1"
                onBlur={() => props.onSaveKernelProxy()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
                onChange={(event) =>
                  props.onSetKernelProxyDraft({ noProxy: event.target.value })
                }
              />
            </label>
            <label className="settings-list-row">
              <span className="settings-list-row-main">
                <strong>{t("settings.nodeUseEnvProxy")}</strong>
                <small>{t("settings.nodeUseEnvProxyCopy")}</small>
              </span>
              <input
                type="checkbox"
                checked={props.kernelProxy.nodeUseEnvProxy}
                disabled={
                  props.loading || props.saving || !props.kernelProxy.enabled
                }
                onChange={(event) =>
                  props.onSaveKernelProxy({
                    nodeUseEnvProxy: event.target.checked,
                  })
                }
              />
            </label>
            <div className="settings-list-row">
              <span className="settings-list-row-main">
                <strong>{t("settings.effectiveProxy")}</strong>
                <small>{effectiveProxyDescription(props.kernelProxy, t)}</small>
              </span>
              <code>{effectiveProxyValue(props.kernelProxy, t)}</code>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
