import type { ReactNode } from 'react';
import { ChatMarkdown, type ChatMarkdownRenderOptions } from '@olorinm/agent-ui';

export type FilePreviewKind = 'markdown' | 'text' | 'image' | 'video' | 'audio' | 'pdf';
export interface FilePreviewProps {
  name: string; kind: FilePreviewKind; content?: string;
  /** Caller-resolved URL. No vault paths, service URLs or auth headers are synthesized. */
  src?: string; unavailable?: ReactNode; truncatedNotice?: ReactNode;
  markdownOptions?: ChatMarkdownRenderOptions;
}
export function FilePreview({ name, kind, content, src, unavailable, truncatedNotice, markdownOptions }: FilePreviewProps) {
  let preview: ReactNode = unavailable;
  if (kind === 'markdown') preview = <div className="markdown-preview"><ChatMarkdown markdown={content ?? ''} {...markdownOptions} /></div>;
  else if (kind === 'text') preview = <pre className="standard-source-preview"><code>{content}</code></pre>;
  else if (src) {
    if (kind === 'image') preview = <img className="file-preview-media" src={src} alt={name} />;
    if (kind === 'audio') preview = <audio src={src} aria-label={name} controls />;
    if (kind === 'video') preview = <video className="file-preview-media" src={src} aria-label={name} controls playsInline />;
    if (kind === 'pdf') preview = <iframe className="file-preview-embed" src={src} title={name} sandbox="" />;
  }
  return <div className="af-file-preview">{preview}{truncatedNotice}</div>;
}
