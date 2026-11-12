import {AlertTriangle} from "lucide-react";
import {useI18n} from "../presentation/i18n";
import type {FilePreviewSaveState} from "./panel";
export function FileDraftNotices(props: {
 deleted?: boolean; editable?: boolean; backupCorrupt?: boolean; memoryOnly?: boolean; storageError?: boolean;
 conflict?: boolean; reviewError?: boolean; saveState?: FilePreviewSaveState; canCompare?: boolean;
 onDiscard?(): void; onCompare?(): void; onDownloadDraft?(): void; onRetrySave?(): void;
}) {
 const {t} = useI18n(); const {editable: canEditText, conflict, reviewError, saveState} = props;
 return <>
          {props.deleted ? (
            <div className="file-conflict-banner" role="status">
              {t("filePreview.fileDeleted")}
            </div>
          ) : null}
          {canEditText && props.backupCorrupt ? (
            <div className="file-conflict-banner" role="alert">
              {t("filePreview.draftCorrupt")}
            </div>
          ) : null}
          {canEditText && (props.memoryOnly || props.storageError) ? (
            <div className="file-conflict-banner" role="alert">
              <span>{t(props.memoryOnly ? "filePreview.draftMemoryOnly" : "filePreview.draftStorageError")}</span>
              <button type="button" disabled={!props.onDownloadDraft} onClick={props.onDownloadDraft}>
                {t("filePreview.downloadDraft")}
              </button>
            </div>
          ) : null}
          {conflict ? (
            <div className="file-conflict-banner" role="alert">
              <AlertTriangle size={16} />
              <span>{t("filePreview.conflictNotice")}</span>
              <button
                type="button"
                disabled={saveState === "saving" || !props.onDiscard}
                onClick={props.onDiscard}
              >
                {t("filePreview.discardDraft")}
              </button>
              <button
                type="button"
                disabled={!props.canCompare || !props.onCompare || saveState === "saving"}
                onClick={props.onCompare}
              >
                {t("filePreview.compareChanges")}
              </button>
              <button type="button" disabled={!props.onDownloadDraft} onClick={props.onDownloadDraft}>
                {t("filePreview.downloadDraft")}
              </button>
            </div>
          ) : saveState === "error" ? (
            <div className="file-conflict-banner" role="alert">
              <span>{t("filePreview.saveFailedDraftKept")}</span>
              <button type="button" disabled={!props.onRetrySave} onClick={props.onRetrySave}>
                {t("filePreview.retrySave")}
              </button>
            </div>
          ) : null}
          {reviewError ? (
            <div className="file-conflict-banner" role="alert">
              {t("filePreview.reviewSaveFailed")}
            </div>
          ) : null}

</>;
}
