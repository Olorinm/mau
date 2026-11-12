import { File, Image, FileText } from "lucide-react";

/** Display metadata only. Reading, uploading and authorizing resources belong to the caller. */
export interface AttachmentView {
  id: string;
  kind: "image" | "text" | "file";
  name: string;
  previewUrl?: string;
  description?: string;
}

export function attachmentIcon(attachment: AttachmentView) {
  return attachment.kind === "image"
    ? Image
    : attachment.kind === "text"
      ? FileText
      : File;
}
export function attachmentImagePreviewUrl(attachment: AttachmentView) {
  return attachment.previewUrl;
}
export function formatAttachmentMeta(attachment: AttachmentView) {
  return attachment.description;
}
