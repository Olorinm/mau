import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChatMarkdown } from "@olorinm/agent-ui";
import { Button, useToast } from "@olorinm/agent-ui/app";
import { Conversation, FileEditor, type ConversationComposer, type MessageView } from "@olorinm/agent-ui/pages";
import { mauApi, memoryDelimiter } from "../api/client";
import { memoryDocument, memoryEntries, memoryOperations } from "../api/memory-document";
import type { Session } from "../api/session";
import { ApiError } from "../api/http";
import { attachmentKind, attachmentUrl, formatBytes, type AttachmentRef, type LedgerApi } from "../api/ledger";
import { errorMessage, useI18n } from "../i18n";


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

/** A long text that shows its first lines, and the rest when asked. A text that fits is shown whole, with nothing to press. */
export function Clamped({ children, more, less }: { children: ReactNode; more: string; less: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [long, setLong] = useState(false);
  useLayoutEffect(() => { const node = body.current; if (node && !open) setLong(node.scrollHeight > node.clientHeight + 1); }, [children, open]);
  return (
    <div className="mau-clamped" data-open={open || undefined}>
      <div className="mau-clamped-body" ref={body}>{children}</div>
      {long || open ? <button type="button" className="mau-clamped-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? less : more}</button> : null}
    </div>
  );
}

/**
 * A thread of a partner's page, beside the conversation: one piece of work another partner sent it, from its first
 * round to its last, and a box to write in it. What is written there is a turn of that session, not of the
 * conversation it is opened from.
 */
export function ThreadSideView({ chatId, title, detail, messages, composer, onClose }: {
  chatId: string; title: string; detail: string; messages: readonly MessageView[]; composer: ConversationComposer; onClose(): void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <aside className="mau-side-card mau-side-view mau-thread-view" aria-label={t("threads.label")} data-thread-chat={chatId}>
      <Conversation conversationId={chatId} header={<SideHead title={title} detail={detail} onClose={onClose} />} messages={messages} composer={composer} />
    </aside>
  );
}

/** The browser a partner handed over: Cloudflare's live view, operated here; Done or Failed in it ends the handoff. */
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

/** A partner's documents: the fixed instructions and its memory. */
export type PartnerDocument = "AGENTS.md" | "MEMORY.md";
export const partnerDocuments: readonly PartnerDocument[] = ["AGENTS.md", "MEMORY.md"];
export const isMemory = (name: PartnerDocument) => name === "MEMORY.md";
const characters = (text: string) => [...text].length;

/**
 * One of a partner's documents beside the conversation. The instructions are read-only. The memory is edited as
 * one Markdown document with a divider between its entries, and saved as the changes to those entries.
 */
export function DocumentSideView({ session, agentId, name, onClose }: { session: Session; agentId: string; name: PartnerDocument; onClose(): void }) {
  const { t, language } = useI18n(), zh = language === "zh-CN";
  const { toast } = useToast();
  const queries = useQueryClient();
  const api = mauApi(session.token), target = isMemory(name);
  const failure = (error: unknown) => errorMessage(t, error instanceof ApiError ? error.code : "request_failed");
  const instructions = useQuery({ queryKey: ["agent-instructions", agentId], queryFn: () => api.agentInstructions(agentId), enabled: !target });
  const memory = useQuery({ queryKey: ["agent-memory", agentId], queryFn: () => api.agentMemory(agentId), enabled: !!target });
  const file = memory.data;
  const saved = file ? memoryDocument(file.entries) : undefined;
  // The document as the editor last wrote it; nothing until something is typed.
  const [draft, setDraft] = useState<string>();
  useEffect(() => { setDraft(undefined); }, [saved]);
  const operations = file && draft !== undefined ? memoryOperations(file.entries, memoryEntries(draft)) : [];
  const used = !file ? 0 : draft === undefined ? file.usage.used : characters(memoryEntries(draft).join(memoryDelimiter));
  const over = !!file && used > file.usage.limit;
  const save = useMutation({
    mutationFn: async () => {
      // The server takes thirty changes at a time.
      for (let start = 0; start < operations.length; start += 30) await api.changeAgentMemory(agentId, operations.slice(start, start + 30));
    },
    onSuccess: () => toast({ kind: "success", title: zh ? "已保存，新对话开始时生效" : "Saved. It applies from the next new conversation." }),
    onError: (error) => toast({ kind: "error", title: failure(error) }),
    onSettled: () => queries.invalidateQueries({ queryKey: ["agent-memory", agentId] }),
  });
  const loading = target ? memory.isPending : instructions.isPending, error = target ? memory.error : instructions.error;
  return (
    <aside className="mau-side-card mau-side-view mau-side-document" aria-label={zh ? "文档" : "Document"} data-over={over || undefined}>
      <SideHead title={name} detail={target ? (file ? `${used} / ${file.usage.limit}` : undefined) : (zh ? "只读" : "Read-only")} onClose={onClose}>
        {target && file ? <Button variant="primary" disabled={!operations.length || over || save.isPending} onClick={() => save.mutate()}>{zh ? "保存" : "Save"}</Button> : null}
      </SideHead>
      <div className="mau-side-body">
        {loading ? <p className="mau-muted" role="status">{t("common.loading")}</p>
          : error ? <p className="mau-error" role="alert">{failure(error)}</p>
          : target ? <FileEditor key={name} value={saved ?? ""} format="markdown" onChange={setDraft} placeholder={zh ? "还没有内容" : "Nothing here yet"} />
          : instructions.data?.text ? <ChatMarkdown markdown={instructions.data.text} />
          : <p className="mau-muted">{zh ? "这个伙伴还没有固定说明" : "This partner has no fixed instructions"}</p>}
      </div>
    </aside>
  );
}
