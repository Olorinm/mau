// Presentation extracted from OpenGrove 8b365ed; caller owns data and service operations.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Plus, Search } from "lucide-react";
export interface ProviderChoice { id: string; name: string; icon?: ReactNode; description: ReactNode; disabled?: boolean }
import type { TranslationFn } from "./i18n";
import { Dialog, DialogContent, DialogSubpage, DialogTitle } from "@olorinm/agent-ui/app";

export function SettingsProviderPickerDialog(props: {
  t: TranslationFn;
  open: boolean;
  providers: ProviderChoice[];
  detailOpen: boolean;
  detailTitle: string;
  renderDetail(): ReactNode;
  onClose(): void;
  onBack(): void;
  onSelectProvider(provider: ProviderChoice): void;
  onSelectCustom(): void;
}) {
  const { t } = props;
  const [query, setQuery] = useState("");
  const visibleProviders = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return props.providers;
    return props.providers.filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(normalized));
  }, [props.providers, query]);
  const normalizedQuery = query.trim().toLowerCase();
  const customMatches =
    !normalizedQuery ||
    `${t("settings.addCustomProvider")} ${t("settings.customProvider")}`.toLowerCase().includes(normalizedQuery);

  useEffect(() => {
    if (!props.open) setQuery("");
  }, [props.open]);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="settings-provider-picker-dialog" aria-label={t("settings.addProvider")}>
        <DialogTitle>{t("settings.addProvider")}</DialogTitle>
        <label className="settings-provider-picker-search">
          <Search size={16} aria-hidden="true" />
          <input
            autoFocus
            type="search"
            value={query}
            placeholder={t("settings.searchProviders")}
            aria-label={t("settings.searchProviders")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="settings-list settings-provider-picker-list">
          {visibleProviders.map((provider) => {
            return (
              <button
                className="settings-list-row settings-provider-catalog-row choice"
                key={provider.id}
                type="button"
                disabled={provider.disabled}
                onClick={() => props.onSelectProvider(provider)}
              >
                <span className="settings-provider-logo">{provider.icon}</span>
                <span className="settings-provider-main">
                  <strong>{provider.name}</strong>
                  <small>{provider.description}</small>
                </span>
                <Plus size={15} />
              </button>
            );
          })}
          {customMatches ? (
            <button
              className="settings-list-row settings-provider-catalog-row choice"
              type="button"
              onClick={props.onSelectCustom}
            >
              <span className="settings-provider-avatar" aria-hidden="true">
                +
              </span>
              <span className="settings-provider-main">
                <strong>{t("settings.addCustomProvider")}</strong>
                <small>{t("settings.customProvider")}</small>
              </span>
              <Plus size={15} />
            </button>
          ) : null}
          {!visibleProviders.length && !customMatches ? (
            <p className="settings-provider-picker-empty">{t("settings.noProvidersFound")}</p>
          ) : null}
        </div>
        <div className="modal-actions">
          <button className="ghost-button" type="button" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
        </div>
        {props.detailOpen ? (
          <DialogSubpage title={props.detailTitle} backLabel={t("common.back")} onBack={props.onBack}>
            {props.renderDetail()}
          </DialogSubpage>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
