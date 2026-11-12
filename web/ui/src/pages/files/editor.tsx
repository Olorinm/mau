import { forwardRef } from "react";
import type { MarkdownCodeEditorFormat, MarkdownEditorSelection } from "./code-editor";
import { StandardFileEditor } from "./standard-file-editor";
import { createFileCapabilities } from "./standard-file-capabilities";
import { useI18n } from "../presentation/i18n";

export interface FileEditorHandle { getValue(): string }
export interface FileEditorProps {
  value: string;
  format: MarkdownCodeEditorFormat;
  richText?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  onChange(value: string): void;
  onSnapshot?(read: () => string): void;
  onTextSelectionChange?(selection: MarkdownEditorSelection | null): void;
  onAttachSelection?(selection: MarkdownEditorSelection): void;
}
/** Value adapter into the original editor. The caller owns file reads, saves and conflicts. */
export const FileEditor = forwardRef<FileEditorHandle, FileEditorProps>(function FileEditor(props, ref) {
  const { t } = useI18n();
  const markdown = props.format === "markdown" && props.richText !== false;
  const capability = createFileCapabilities(t).resolveStandardFileCapability({ name: "document.txt", path: "document.txt" }, "document.txt");
  capability.kind = markdown ? "markdown" : "text";
  capability.editor = { kind: "codemirror", label: props.format, language: props.format };
  return <div className="af-file-editor"><StandardFileEditor {...props} ref={ref} capability={capability} /></div>;
});
