// Extracted from web/src/components/network/app-store-view.tsx at 8b365ed. See source-manifest.json for boundary changes.
import { useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Search, X } from "lucide-react";
import { ProductIcon, usePortalContainer } from "@olorinm/agent-ui/app";
import { useI18n } from "./presentation/i18n";
export interface CatalogItem {
  id: string;
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  publisher?: ReactNode;
  version?: string;
  metadata?: ReactNode;
  actions?: ReactNode;
  detail?: ReactNode;
  onOpen?(): void;
}

export function Catalog({
  items,
  title,
  actions,
  query,
  onQueryChange,
  searchPlaceholder,
  filters,
  notice,
  empty,
  loading,
  connected = false,
  presentation = "grove",
}: {
  items: readonly CatalogItem[];
  title?: ReactNode;
  actions?: ReactNode;
  query?: string;
  onQueryChange?(value: string): void;
  searchPlaceholder?: string;
  filters?: ReactNode;
  notice?: ReactNode;
  empty?: ReactNode;
  loading?: boolean;
  connected?: boolean;
  presentation?: "grove" | "classic";
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string>();
  const item = items.find((item) => item.id === selected);
  return (
    <section
      className="view-panel tab-view app-store-view"
      data-presentation={presentation}
    >
      <div className="app-store-page">
        <header className="app-store-title">
          <div>
            <h1>
              {presentation === "grove" ? (
                <span className="app-store-title-icon" aria-hidden="true">
                  <ProductIcon name="store" size={24} />
                </span>
              ) : null}
              {title ?? t("app.appStore")}
              <span
                className={
                  connected
                    ? "app-store-title-status ready"
                    : "app-store-title-status"
                }
                role="img"
                aria-label={
                  connected
                    ? t("workspace.kernelConnected")
                    : t("appStore.notConnected")
                }
                title={
                  connected
                    ? t("workspace.kernelConnected")
                    : t("appStore.notConnectedTitle")
                }
              />
            </h1>
          </div>
          <div className="app-store-title-actions">
            {onQueryChange ? (
              <label className="app-store-search">
                <Search size={18} aria-hidden="true" />
                <input
                  value={query ?? ""}
                  onChange={(event) => onQueryChange?.(event.target.value)}
                  placeholder={
                    searchPlaceholder ?? t("appStore.searchPlaceholder")
                  }
                  aria-label={
                    searchPlaceholder ?? t("appStore.searchPlaceholder")
                  }
                />
              </label>
            ) : null}
            {actions}
          </div>
        </header>
        {filters}
        {notice}
        <section className="app-store-section">
          <div className="app-store-catalog-grid">
            {items.map((item) => (
              <CatalogCard
                key={item.id}
                item={item}
                presentation={presentation}
                onOpen={() => {
                  setSelected(item.id);
                  item.onOpen?.();
                }}
              />
            ))}
          </div>
          {loading ? (
            <CatalogLoadingState />
          ) : !items.length ? (
            <div className="app-store-empty">
              {empty ?? t("appStore.empty")}
            </div>
          ) : null}
        </section>
      </div>
      {item ? (
        <CatalogDialog item={item} onClose={() => setSelected(undefined)} />
      ) : null}
    </section>
  );
}
function CatalogCard(props: { item: CatalogItem; presentation: "grove" | "classic"; onOpen(): void }) {
  const { t } = useI18n();
  return (
    <article
      className="og-card app-store-app-card"
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onOpen();
        }
      }}
    >
      {props.presentation === "grove" ? (
        <div className="app-store-app-card-main app-store-app-card-main--grove">
          <span className="app-store-grove-icon">{props.item.icon}</span>
          <span className="app-store-app-card-copy">
            <strong>{props.item.title}</strong>
            <small>{props.item.description}</small>
          </span>
        </div>
      ) : (
        <div className="app-store-app-card-main">
          <strong>{props.item.title}</strong>
          <small>{props.item.description}</small>
        </div>
      )}
      <div className="app-store-package-footer">
        <div className="app-store-package-context">
          {props.item.metadata}
          <div
            className="app-store-package-owner"
            aria-label={t("appStore.ownerAriaLabel")}
          >
            <span>{props.item.publisher}</span>
            {props.item.version ? <span>v{props.item.version}</span> : null}
          </div>
        </div>
        <div
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {props.item.actions}
        </div>
      </div>
    </article>
  );
}
function CatalogDialog({
  item,
  onClose,
}: {
  item: CatalogItem;
  onClose(): void;
}) {
  const { t } = useI18n();
  const container = usePortalContainer();
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal container={container}>
        <div
          className="app-store-dialog-backdrop"
          role="presentation"
          onMouseDown={onClose}
        >
          <Dialog.Popup
            render={<section />}
            className="app-store-dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <Dialog.Close
              className="app-store-dialog-close"
              aria-label={t("mountedApp.close")}
              title={t("mountedApp.close")}
            >
              <X size={28} aria-hidden="true" />
            </Dialog.Close>
            <div className="app-store-dialog-heading">
              <span className="app-store-dialog-hero-icon">{item.icon}</span>
              <Dialog.Title render={<h2 />}>{item.title}</Dialog.Title>
              <p>
                <span>{item.publisher}</span>
                {item.version ? <span>v{item.version}</span> : null}
              </p>
              {item.metadata}
            </div>
            <p className="app-store-dialog-summary">{item.description}</p>
            {item.detail}
            <div className="app-store-dialog-actions">{item.actions}</div>
          </Dialog.Popup>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CatalogLoadingState() {
  const { t } = useI18n();
  return (
    <div
      className="app-store-catalog-grid app-store-catalog-loading"
      role="status"
      aria-label={t("mountedApp.loading")}
    >
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <article
          className="og-card app-store-app-card"
          aria-hidden="true"
          key={index}
        >
          <div className="app-store-app-card-main">
            <span
              className="og-skeleton og-skeleton-line"
              style={{ width: index % 2 ? "48%" : "62%" }}
            />
            <span
              className="og-skeleton og-skeleton-line"
              style={{ width: index % 3 ? "82%" : "70%", marginTop: 10 }}
            />
          </div>
          <div className="app-store-package-footer">
            <span
              className="og-skeleton og-skeleton-line"
              style={{ width: "55%" }}
            />
            <span className="og-skeleton app-store-catalog-loading-action" />
          </div>
        </article>
      ))}
    </div>
  );
}
