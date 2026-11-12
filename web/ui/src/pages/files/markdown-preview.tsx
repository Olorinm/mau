import { useMemo, useRef, type ComponentProps } from "react";
import { useI18n } from "../presentation/i18n";
import { createMarkdownPresentation } from "./markdown-presentation";

export interface FilePreviewOperations {
  resolveImageUrl?(href: string, basePath?: string): string | undefined;
  onDownloadImage?(src: string, fileName: string): Promise<void>;
  downloadErrorMessage?(error: unknown): string;
}

export function useMarkdownPresentation(operations: FilePreviewOperations = {}) {
  const { t } = useI18n();
  const current = useRef(operations);
  current.current = operations;
  return useMemo(() => createMarkdownPresentation(t, current), [t]);
}

export type MarkdownPreviewProps = ComponentProps<ReturnType<typeof createMarkdownPresentation>["MarkdownPreview"]> & FilePreviewOperations;
export function MarkdownPreview(props: MarkdownPreviewProps) {
  const { MarkdownPreview: View } = useMarkdownPresentation(props);
  return <View {...props} />;
}

export function MarkdownProperties(props: ComponentProps<ReturnType<typeof createMarkdownPresentation>["MarkdownProperties"]>) {
  const { MarkdownProperties: View } = useMarkdownPresentation();
  return <View {...props} />;
}
export type { MarkdownProperty, MarkdownPropertyDefinition, MarkdownPropertyValue } from "./markdown-presentation";
