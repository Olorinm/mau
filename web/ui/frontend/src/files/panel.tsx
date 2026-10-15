// Extracted from web/src/components/shared/file-preview-panel.tsx at 8b365ed. See source-manifest.json for boundary changes.
import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Download,
  Eye,
  FolderOpen,
  Loader2,
  Pencil,
  Share2,
} from "lucide-react";
import { useI18n, type TranslationFn } from "../presentation/i18n";
import { AnimatedBackground } from "../ui/animated-background";
type PreviewMode = "preview" | "edit";
export type FilePreviewSaveState =
  | "idle"
  | "dirty"
  | "saving"
  | "saved"
  | "error";
export function FilePanel({
  title,
  mode = "preview",
  onModeChange,
  children,
  loading,
  notice,
  saveState,
  saveStatus,
  onDownload,
  onOpenLocal,
  actions,
  downloading,
  downloadError,
  selectionAction,
}: {
  title: string;
  mode?: PreviewMode;
  onModeChange?(mode: PreviewMode): void;
  children: ReactNode;
  loading?: boolean;
  notice?: ReactNode;
  saveState?: ReactNode;
  saveStatus?: FilePreviewSaveState;
  onDownload?(): void;
  onOpenLocal?(): void;
  actions?: ReactNode;
  downloading?: boolean;
  downloadError?: string;
  selectionAction?: ReactNode;
}) {
  return (
    <div className="file-preview-workbench" aria-label={title}>
      <div className="file-preview-surface" data-has-toolbar={"true"}>
        <PreviewToolbar
          canEdit={!!onModeChange}
          mode={mode}
          onModeChange={onModeChange}
          customSaveState={saveState}
          saveState={saveStatus}
          onDownload={onDownload}
          downloading={downloading}
          downloadError={downloadError}
          onOpenLocal={onOpenLocal}
          actions={actions}
        />
        {notice}
        <div className="file-preview-content">
          {loading ? <FilePreviewLoadingState /> : children}
        </div>
      </div>
      {selectionAction}
    </div>
  );
}
function PreviewToolbar(props: {
  canEdit?: boolean;
  dirty?: boolean;
  onDownload?(): void;
  downloading?: boolean;
  downloadError?: string;
  actions?: ReactNode;
  customSaveState?: ReactNode;
  mode?: PreviewMode;
  onOpenLocal?(): void;
  rawUrl?: string;
  saving?: boolean;
  saveState?: FilePreviewSaveState;
  showModeTabs?: boolean;
  onModeChange?(mode: PreviewMode): void;
}) {
  const { t } = useI18n();
  const { downloading, downloadError } = props;
  const showModeTabs = props.canEdit && props.showModeTabs !== false;
  return (
    <div className="file-preview-toolbar">
      {showModeTabs ? (
        <div
          className="file-preview-mode-tabs"
          role="tablist"
          aria-label={t("filePreview.modeLabel")}
        >
          <AnimatedBackground
            value={props.mode ?? "preview"}
            backgroundClassName="file-preview-mode-tab-background"
          >
            <button
              type="button"
              role="tab"
              aria-selected={(props.mode ?? "preview") === "preview"}
              data-id="preview"
              data-active={
                (props.mode ?? "preview") === "preview" ? "true" : "false"
              }
              title={t("filePreview.preview")}
              onClick={() => props.onModeChange?.("preview")}
            >
              <Eye size={14} />
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={props.mode === "edit"}
              data-id="edit"
              data-active={props.mode === "edit" ? "true" : "false"}
              title={t("filePreview.edit")}
              onClick={() => props.onModeChange?.("edit")}
            >
              <Pencil size={14} />
            </button>
          </AnimatedBackground>
        </div>
      ) : (
        <span />
      )}
      <div className="file-preview-actions">
        {downloadError ? (
          <span className="file-preview-download-error" role="alert">
            {downloadError}
          </span>
        ) : null}
        {props.customSaveState}
        {props.canEdit &&
        props.mode === "edit" &&
        props.saveState &&
        props.saveState !== "idle" ? (
          <span
            className="file-preview-save-state"
            data-state={props.saveState}
            title={filePreviewSaveStateLabel(props.saveState, t)}
            aria-label={filePreviewSaveStateLabel(props.saveState, t)}
            role="status"
          >
            {filePreviewSaveStateIcon(props.saveState)}
          </span>
        ) : null}
        {props.onOpenLocal || props.rawUrl || props.onDownload ? (
          <>
            {props.onOpenLocal ? (
              <button
                className="file-preview-action"
                type="button"
                title={t("thread.resourceReveal")}
                aria-label={t("thread.resourceReveal")}
                onClick={props.onOpenLocal}
              >
                <FolderOpen size={14} />
              </button>
            ) : props.rawUrl ? (
              <a
                className="file-preview-action"
                href={props.rawUrl}
                target="_blank"
                rel="noreferrer"
                title={t("filePreview.openOrShare")}
                aria-label={t("filePreview.openOrShare")}
              >
                <Share2 size={14} />
              </a>
            ) : null}
            {props.onDownload ? (
              <button
                className="file-preview-action"
                type="button"
                disabled={downloading}
                title={t("filePreview.download")}
                aria-label={t("filePreview.download")}
                onClick={props.onDownload}
              >
                {downloading ? (
                  <Loader2
                    size={14}
                    className="file-preview-download-spinner"
                  />
                ) : (
                  <Download size={14} />
                )}
              </button>
            ) : null}
          </>
        ) : null}
        {props.actions}
      </div>
    </div>
  );
}
function FilePreviewLoadingState() {
  const { t } = useI18n();
  return (
    <div
      className="og-skeleton-stack file-preview-loading-state"
      role="status"
      aria-label={t("filePreview.loadingTitle")}
    >
      <span className="og-skeleton og-skeleton-line" style={{ width: "28%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "92%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "84%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "71%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "88%" }} />
    </div>
  );
}
function filePreviewSaveStateIcon(state: FilePreviewSaveState): ReactNode {
  switch (state) {
    case "dirty":
      return <Circle size={14} strokeWidth={2.1} aria-hidden="true" />;
    case "saving":
      return <Loader2 size={14} strokeWidth={2.1} aria-hidden="true" />;
    case "saved":
      return <CheckCircle2 size={15} strokeWidth={2.1} aria-hidden="true" />;
    case "error":
      return <AlertTriangle size={15} strokeWidth={2.1} aria-hidden="true" />;
    case "idle":
      return null;
  }
}
function filePreviewSaveStateLabel(
  state: FilePreviewSaveState,
  t: TranslationFn,
): string {
  switch (state) {
    case "dirty":
      return t("filePreview.saveDirty");
    case "saving":
      return t("filePreview.saveSaving");
    case "saved":
      return t("filePreview.saveSaved");
    case "error":
      return t("filePreview.saveError");
    case "idle":
      return "";
  }
}
