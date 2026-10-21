// Original MCP App frame and confirmation presentation. Caller owns the MCP connection, permissions and downloads.
import {useId, type Ref} from "react";
import {Button, Dialog, DialogContent, DialogTitle} from "@olorinm/agent-ui/app";
import {useI18n} from "../presentation/i18n";
export interface AppDownloadView {name: string; href?: string; mimeType?: string}
export function McpAppFrame(props: {
 title: string; url?: string; allow?: string; empty?: boolean; error?: string; loading?: boolean; active?: boolean;
 frameRef?: Ref<HTMLIFrameElement>; displayMode?: "inline" | "fullscreen";
 onDisplayModeChange?(mode: "inline" | "fullscreen"): void; onRetry?(): void; onLoad?(): void; onError?(): void;
 externalLink?: {href: string; origin: string; displayUrl: string}; download?: {files: AppDownloadView[]};
 onExternalLinkResult?(result: {isError?: boolean}): void; onDownloadResult?(result: {isError?: boolean}): void; onSaveFiles?(): void;
}) {
 const {t} = useI18n(); const instanceId = useId();
 const {error, frameRef: iframeRef, externalLink: pendingExternalLink, download: pendingFileDownload} = props;
 const active = props.active !== false, displayMode = props.displayMode ?? "inline";
 const updateDisplayMode = (mode: "inline" | "fullscreen") => props.onDisplayModeChange?.(mode);
 const settleExternalLink = (result: {isError?: boolean}) => props.onExternalLinkResult?.(result);
 const settleFileDownload = (result: {isError?: boolean}) => props.onDownloadResult?.(result);
  if (props.empty) {
    return (
      <div className="mounted-app-empty">
        <strong>{t("mountedApp.emptyTitle")}</strong>
        <p>{t("mountedApp.emptyCopy")}</p>
      </div>
    );
  }
  const visibleError = error;
  if (visibleError) {
    return (
      <div className="mounted-app-empty" role="alert">
        <strong>{t("mountedApp.mcpAppOpenFailed")}</strong>
        <p>{visibleError}</p>
        {error ? (
          <Button
            onClick={props.onRetry}
          >
            {t("mountedApp.retry")}
          </Button>
        ) : null}
      </div>
    );
  }
  if (!props.url || props.loading) {
    return (
      <div className="mounted-app-empty">
        <p>{t("mountedApp.mcpAppConnecting")}</p>
      </div>
    );
  }

  return (
    <div className="mounted-app-web-view" data-mcp-app="true" data-display-mode={displayMode}>
      {displayMode === "fullscreen" ? (
        <button type="button" className="mounted-app-fullscreen-exit" onClick={() => updateDisplayMode("inline")}>
          {t("mountedApp.exitFullscreen")}
        </button>
      ) : null}
      <div className="mounted-app-web-frame-shell">
        <iframe
          ref={iframeRef}
          className="mounted-app-web-frame"
          src={props.url}
          title={props.title}
          sandbox="allow-forms allow-scripts"
          allow={props.allow}
          referrerPolicy="no-referrer"
          onLoad={props.onLoad}
          onError={props.onError}
        />
      </div>
      <Dialog
        open={active && !!pendingExternalLink}
        onOpenChange={(open) => {
          if (!open) settleExternalLink({ isError: true });
        }}
      >
        <DialogContent
          className="mounted-app-external-link-dialog"
          aria-describedby={`${instanceId}-link-description`}
        >
          <DialogTitle>{t("mountedApp.openExternalLinkTitle")}</DialogTitle>
          <p className="mounted-app-external-link-description" id={`${instanceId}-link-description`}>
            {t("mountedApp.openExternalLinkBody")}
          </p>
          <div className="mounted-app-external-link-target">
            <span>{t("mountedApp.openExternalLinkOrigin")}</span>
            <strong>{pendingExternalLink?.origin}</strong>
            <small>{pendingExternalLink?.displayUrl}</small>
          </div>
          <div className="modal-actions">
            <Button onClick={() => settleExternalLink({ isError: true })}>{t("common.cancel")}</Button>
            <Button asChild variant="primary">
              <a
                href={pendingExternalLink?.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  // Let the anchor's browser-default navigation run before the
                  // resolved MCP request unmounts this confirmation portal.
                  window.setTimeout(() => settleExternalLink({}), 0);
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  window.setTimeout(() => settleExternalLink({}), 0);
                }}
              >
                {t("mountedApp.openExternalLinkOpen")}
              </a>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={active && !!pendingFileDownload}
        onOpenChange={(open) => {
          if (!open) settleFileDownload({ isError: true });
        }}
      >
        <DialogContent className="mounted-app-external-link-dialog" aria-describedby={`${instanceId}-download-description`}>
          <DialogTitle>{t("mountedApp.downloadFilesTitle")}</DialogTitle>
          <p className="mounted-app-external-link-description" id={`${instanceId}-download-description`}>
            {t("mountedApp.downloadFilesBody")}
          </p>
          <ul className="mounted-app-download-list">
            {pendingFileDownload?.files.map((file, index) => (
              <li key={`${file.name}-${index}`}>
                <strong>{file.name}</strong>
                <small>{file.href ?? file.mimeType}</small>
              </li>
            ))}
          </ul>
          <div className="modal-actions">
            <Button onClick={() => settleFileDownload({ isError: true })}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              onClick={props.onSaveFiles}
            >
              {t("mountedApp.downloadFilesSave")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
