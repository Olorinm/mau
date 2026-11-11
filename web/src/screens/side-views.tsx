import { useQuery } from "@tanstack/react-query";
import { ChatMarkdown } from "@olorinm/agent-ui";
import { Button } from "@olorinm/agent-ui/app";
import { ApiError } from "../api/http";
import { attachmentKind, attachmentUrl, formatBytes, type AttachmentRef, type LedgerApi } from "../api/ledger";
import { errorMessage, useI18n } from "../i18n";

/** Where Cloudflare Browser Run serves a live view. Only this origin is ever framed (see the console's `frame-src`). */
const liveViewOrigin = "https://live.browser.run";
/** The private live-view link in a pending handoff card's text, if it points at the live-view origin. */
export function liveViewUrl(text: string | undefined): string | undefined {
  const found = /https:\/\/live\.browser\.run\/[^\s<>"')\]]+/.exec(text ?? "")?.[0];
  if (!found) return undefined;
  try { return new URL(found).origin === liveViewOrigin ? found : undefined; } catch { return undefined; }
}

function SideHead({ title, detail, children, onClose }: { title: string; detail?: string | undefined; children?: React.ReactNode; onClose(): void }) {
  const { t } = useI18n();
  return (
    <header className="mau-side-head">
      <div><strong title={title}>{title}</strong>{detail ? <small>{detail}</small> : null}</div>
      {children}
      <button type="button" className="mau-side-close" aria-label={t("common.close")} title={t("common.close")} onClick={onClose}>×</button>
    </header>
  );
}

/** The browser an employee handed over: Cloudflare's live view, operated here; Done or Failed in it ends the handoff. */
export function BrowserSideView({ url, onClose }: { url: string; onClose(): void }) {
  const { language } = useI18n(), zh = language === "zh-CN";
  return (
    <aside className="mau-side-card mau-side-view" aria-label={zh ? "接管浏览器" : "Browser handoff"}>
      <SideHead title={zh ? "接管浏览器" : "Browser handoff"} detail={zh ? "操作完成后点画面里的 Done" : "Press Done in the view when finished"} onClose={onClose}>
        <a className="mau-side-link" href={url} target="_blank" rel="noopener noreferrer">{zh ? "新窗口打开" : "Open in a window"}</a>
      </SideHead>
      <iframe className="mau-side-frame" src={url} title={zh ? "浏览器实时画面" : "Live browser view"}
        allow="clipboard-read; clipboard-write" referrerPolicy="no-referrer" />
    </aside>
  );
}

const textLimit = 512 * 1024;
const readable = /\.(?:md|markdown|txt|csv|tsv|log|json|ya?ml|toml|xml|html?|css|[cm]?[jt]sx?|py|go|rs|java|kt|swift|rb|php|sh|sql)$/i;
/** A message's file beside the conversation: images and text are shown, anything else is offered as a download. */
export function FileSideView({ api, attachment, onDownload, onClose }: {
  api: LedgerApi; attachment: AttachmentRef; onDownload(): void; onClose(): void;
}) {
  const { t, language } = useI18n(), zh = language === "zh-CN";
  const kind = attachmentKind(attachment.contentType);
  const text = kind !== "image" && (kind === "text" || readable.test(attachment.name));
  const tooLarge = text && (attachment.size ?? 0) > textLimit;
  const content = useQuery({
    queryKey: ["attachment-text", attachment.attachmentId], enabled: text && !tooLarge, retry: false, staleTime: Infinity,
    queryFn: async ({ signal }) => (await api.downloadAttachment(attachment, signal)).text(),
  });
  const markdown = /\.(?:md|markdown)$/i.test(attachment.name);
  return (
    <aside className="mau-side-card mau-side-view" aria-label={zh ? "文件" : "File"}>
      <SideHead title={attachment.name} detail={formatBytes(attachment.size)} onClose={onClose}>
        <Button onClick={onDownload}>{zh ? "下载" : "Download"}</Button>
      </SideHead>
      <div className="mau-side-body">
        {kind === "image" ? <img className="mau-side-image" src={attachmentUrl(attachment)} alt={attachment.name} />
          : !text ? <p className="mau-muted">{zh ? "这种文件不能在这里预览，可以下载后查看。" : "This kind of file cannot be previewed here. Download it to view it."}</p>
          : tooLarge ? <p className="mau-muted">{zh ? "文件太大，不在这里预览，可以下载后查看。" : "The file is too large to preview here. Download it to view it."}</p>
          : content.isPending ? <p className="mau-muted" role="status">{t("common.loading")}</p>
          : content.isError ? <p className="mau-error" role="alert">{errorMessage(t, content.error instanceof ApiError ? content.error.code : "request_failed")}</p>
          : markdown ? <ChatMarkdown markdown={content.data} />
          : <pre className="mau-side-text">{content.data}</pre>}
      </div>
    </aside>
  );
}
