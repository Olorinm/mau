// Extracted from web/src/components/app-shell/app-titlebar.tsx at 8b365ed. See source-manifest.json for boundary changes.
import type { ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useI18n } from "./i18n";
export function AppTitlebar(props: {
  brand: ReactNode;
  logo?: ReactNode;
  toolbar?: ReactNode;
  updates?: ReactNode;
  accountStatus?: ReactNode;
  toggleId: string;
  navigationId: string;
  railVisible: boolean;
  onToggleRail?: () => void;
  desktopPlatform?: string;
  desktopFullscreen?: boolean;
  officialRelease?: boolean;
}) {
  const { t } = useI18n();
  return (
    <header
      className="app-titlebar"
      data-desktop-platform={props.desktopPlatform || undefined}
      data-desktop-fullscreen={props.desktopFullscreen ? "true" : undefined}
      aria-label={typeof props.brand === "string" ? props.brand : undefined}
    >
      <div className="app-titlebar-left">
        {props.onToggleRail ? (
          <button
            id={props.toggleId}
            className="app-titlebar-control"
            type="button"
            onClick={props.onToggleRail}
            aria-controls={props.navigationId}
            aria-expanded={props.railVisible}
            aria-label={
              props.railVisible
                ? t("shell.collapseMainNav")
                : t("shell.expandMainNav")
            }
            title={
              props.railVisible
                ? t("shell.collapseMainNav")
                : t("shell.expandMainNav")
            }
          >
            {props.railVisible ? (
              <PanelLeftClose size={16} aria-hidden="true" />
            ) : (
              <PanelLeftOpen size={16} aria-hidden="true" />
            )}
          </button>
        ) : null}
        <span
          className="app-titlebar-brand"
          title={typeof props.brand === "string" ? props.brand : undefined}
        >
          <span className="app-titlebar-brand-mark" aria-hidden="true">
            {props.logo}
          </span>
          <span className="app-titlebar-brand-word">{props.brand}</span>
          {props.officialRelease === false ? (
            <span className="app-titlebar-dev-badge">DEV</span>
          ) : null}
        </span>
        {props.updates}
      </div>
      {props.accountStatus}
      <div className="app-titlebar-drag-space" aria-hidden="true" />
      {props.toolbar}
    </header>
  );
}
