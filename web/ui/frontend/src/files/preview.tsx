import type { ReactNode } from "react";
import { ChatMarkdown, type ChatMarkdownRenderOptions } from "@olorinm/agent-ui";
import { useI18n } from "../presentation/i18n";
import { StandardFilePreview } from "./standard-file-preview";
import { createFileCapabilities } from "./standard-file-capabilities";
import type { FilePreviewOperations } from "./markdown-preview";
import type { FlowActivity } from "./flow-types";

export type FilePreviewKind = "flow" | "markdown" | "text" | "image" | "video" | "audio" | "pdf" | "unsupported";
export interface FilePreviewProps {
  name: string;
  kind: FilePreviewKind;
  content?: string;
  path?: string;
  mimeType?: string;
  contentTruncated?: boolean;
  /** Caller-resolved URL. No service URL or authorization is synthesized. */
  src?: string;
  unavailable?: ReactNode;
  truncatedNotice?: ReactNode;
  onActivate?(): void;
  fileOperations?: FilePreviewOperations;
  flowActivity?: Readonly<Record<string, FlowActivity>>;
  /** Optional caller-customized chat Markdown rendering; default is the original file renderer. */
  markdownOptions?: ChatMarkdownRenderOptions;
}
/** Compatibility adapter into the original file preview; it defines no alternative media layout. */
export function FilePreview(props: FilePreviewProps) {
  const { t } = useI18n();
  const file = { name: props.name, path: props.path ?? props.name, content: props.content,
    mimeType: props.mimeType, contentTruncated: props.contentTruncated };
  const capability = createFileCapabilities(t).resolveStandardFileCapability(file, file.path);
  capability.preview.kind = props.kind === "text" ? "source" : props.kind;
  capability.canPreview = props.kind !== "unsupported";
  const unavailable = !props.src && ["image", "video", "audio", "pdf", "unsupported"].includes(props.kind);
  return <div className="af-file-preview">
    {unavailable && props.unavailable !== undefined ? props.unavailable : <StandardFilePreview
      file={file} capability={capability} rawUrl={props.src} onActivate={props.onActivate}
      fileOperations={props.fileOperations} flowActivity={props.flowActivity}
      renderMarkdown={props.markdownOptions ? text => <div className="markdown-preview"><ChatMarkdown markdown={text} {...props.markdownOptions} /></div> : undefined} />}
    {props.truncatedNotice}
  </div>;
}
export { StandardFilePreview } from "./standard-file-preview";
export { createFileCapabilities } from "./standard-file-capabilities";
export { FlowPreview, parseFlowPreviewMarkdown } from "./flow-preview";
export { MarkdownPreview, MarkdownProperties, useMarkdownPresentation } from "./markdown-preview";
export type * from "./standard-file-capabilities";
export type * from "./flow-types";
export type * from "./markdown-preview";
