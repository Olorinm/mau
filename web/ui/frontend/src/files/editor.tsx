import { forwardRef, lazy, Suspense, useImperativeHandle, useRef } from 'react';
import type { MarkdownCodeEditorHandle, MarkdownCodeEditorFormat, MarkdownEditorSelection } from './code-editor';
import type { MarkdownRichEditorHandle } from './rich-editor';
import { useFrontendLabels } from '../provider';

const CodeEditor = /* @__PURE__ */ lazy(() => import('./code-editor').then(module => ({ default: module.MarkdownCodeEditor })));
const RichEditor = /* @__PURE__ */ lazy(() => import('./rich-editor').then(module => ({ default: module.MarkdownRichEditor })));
export interface FileEditorHandle { getValue(): string }
export interface FileEditorProps {
  value: string; format: MarkdownCodeEditorFormat; richText?: boolean; autoFocus?: boolean;
  placeholder?: string; onChange(value: string): void;
  onSnapshot?(read: () => string): void;
  onTextSelectionChange?(selection: MarkdownEditorSelection | null): void;
  onAttachSelection?(selection: MarkdownEditorSelection): void;
}
/** Edits caller-provided text. Reading, saving and revision conflict policy live outside the UI. */
export const FileEditor = /* @__PURE__ */ forwardRef<FileEditorHandle, FileEditorProps>(function FileEditor(props, ref) {
  const code = useRef<MarkdownCodeEditorHandle>(null);
  const rich = useRef<MarkdownRichEditorHandle>(null);
  const { t } = useFrontendLabels();
  useImperativeHandle(ref, () => ({ getValue: () => rich.current?.getValue() ?? code.current?.getValue() ?? props.value }), [props.value]);
  return <div className="af-file-editor"><Suspense fallback={<p role="status">{t('loading')}</p>}>
    {props.richText && props.format === 'markdown'
      ? <RichEditor {...props} ref={rich} /> : <CodeEditor {...props} ref={code} />}
  </Suspense></div>;
});
