import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChatMarkdown } from "@olorinm/agent-ui";
import { Button, TextButton, useConfirm, useToast } from "@olorinm/agent-ui/app";
import { FileEditor } from "@olorinm/agent-ui/pages";
import { mauApi, memoryDelimiter, type MemoryFile, type MemoryOperation } from "../api/client";
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

/** An employee's documents: the fixed instructions and the two memory files. */
export type EmployeeDocument = "AGENTS.md" | "MEMORY.md" | "USER.md";
export const employeeDocuments: readonly EmployeeDocument[] = ["AGENTS.md", "MEMORY.md", "USER.md"];
export const memoryTarget = (name: EmployeeDocument): MemoryFile["target"] | undefined => name === "MEMORY.md" ? "memory" : name === "USER.md" ? "user" : undefined;
const characters = (text: string) => [...text].length;

/**
 * One of an employee's documents beside the conversation. The instructions are read-only. A memory file is its
 * entries, one block each: an entry is edited on its own in the Markdown editor, so saving one never rewrites another.
 */
export function DocumentSideView({ session, agentId, name, onClose }: { session: Session; agentId: string; name: EmployeeDocument; onClose(): void }) {
  const { t, language } = useI18n(), zh = language === "zh-CN";
  const { toast } = useToast();
  const confirm = useConfirm();
  const queries = useQueryClient();
  const api = mauApi(session.token), target = memoryTarget(name);
  const failure = (error: unknown) => errorMessage(t, error instanceof ApiError ? error.code : "request_failed");
  const instructions = useQuery({ queryKey: ["agent-instructions", agentId], queryFn: () => api.agentInstructions(agentId), enabled: !target });
  const memory = useQuery({ queryKey: ["agent-memory", agentId], queryFn: () => api.agentMemory(agentId), enabled: !!target });
  const file = memory.data?.files.find((item) => item.target === target);
  // The entry being edited (its index, or "new") and its text in the editor.
  const [editing, setEditing] = useState<number | "new">(), [draft, setDraft] = useState("");
  const original = typeof editing === "number" ? file?.entries[editing] : undefined;
  const text = draft.trim();
  // What the file would hold with this entry saved, counted as the server counts it.
  const used = !file ? 0 : editing === undefined ? file.usage.used
    : characters((editing === "new" ? [...file.entries, text] : file.entries.map((entry, index) => index === editing ? text : entry)).filter(Boolean).join(memoryDelimiter));
  const over = !!file && used > file.usage.limit;
  const change = useMutation({
    mutationFn: (operation: MemoryOperation) => api.changeAgentMemory(agentId, target!, operation),
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ["agent-memory", agentId] });
      setEditing(undefined);
      toast({ kind: "success", title: zh ? "已保存，新对话开始时生效" : "Saved. It applies from the next new conversation." });
    },
    onError: (error) => toast({ kind: "error", title: failure(error) }),
  });
  const start = (index: number | "new") => { setEditing(index); setDraft(index === "new" ? "" : file?.entries[index] ?? ""); };
  const save = () => {
    if (editing === "new") change.mutate({ action: "add", content: text });
    else if (original !== undefined) text === original ? setEditing(undefined) : change.mutate({ action: "replace", old_text: original, content: text });
  };
  const remove = async (entry: string) => {
    const result = await confirm({ title: zh ? "删除这条记忆？" : "Delete this entry?", body: entry.length > 120 ? entry.slice(0, 120) + "…" : entry,
      confirmLabel: zh ? "删除" : "Delete", danger: true });
    if (result === "primary") change.mutate({ action: "remove", old_text: entry });
  };
  const editor = (
    <div className="mau-document-entry" data-editing="">
      <FileEditor key={String(editing)} value={draft} format="markdown" autoFocus onChange={setDraft} />
      <div className="mau-document-entry-actions">
        <TextButton tone="neutral" disabled={change.isPending} onClick={() => setEditing(undefined)}>{t("common.cancel")}</TextButton>
        <Button variant="primary" disabled={!text || over || change.isPending} onClick={save}>{zh ? "保存" : "Save"}</Button>
      </div>
    </div>
  );
  const loading = target ? memory.isPending : instructions.isPending, error = target ? memory.error : instructions.error;
  return (
    <aside className="mau-side-card mau-side-view mau-side-document" aria-label={zh ? "文档" : "Document"} data-over={over || undefined}>
      <SideHead title={name} detail={target ? (file ? `${used} / ${file.usage.limit}` : undefined) : (zh ? "只读" : "Read-only")} onClose={onClose}>
        {target && file ? <Button disabled={editing !== undefined} onClick={() => start("new")}>{zh ? "添加" : "Add"}</Button> : null}
      </SideHead>
      <div className="mau-side-body">
        {loading ? <p className="mau-muted" role="status">{t("common.loading")}</p>
          : error ? <p className="mau-error" role="alert">{failure(error)}</p>
          : !target ? (instructions.data?.text ? <ChatMarkdown markdown={instructions.data.text} />
            : <p className="mau-muted">{zh ? "这个员工还没有固定说明" : "This employee has no fixed instructions"}</p>)
          : <>
            {file?.entries.map((entry, index) => editing === index ? <div key={index}>{editor}</div> : (
              <article key={index} className="mau-document-entry">
                <ChatMarkdown markdown={entry} />
                <div className="mau-document-entry-actions">
                  <TextButton disabled={editing !== undefined || change.isPending} onClick={() => start(index)}>{zh ? "编辑" : "Edit"}</TextButton>
                  <TextButton tone="danger" disabled={editing !== undefined || change.isPending} onClick={() => void remove(entry)}>{zh ? "删除" : "Delete"}</TextButton>
                </div>
              </article>
            ))}
            {editing === "new" ? editor : null}
            {!file?.entries.length && editing !== "new" ? <p className="mau-muted">{zh ? "还没有内容" : "Nothing here yet"}</p> : null}
          </>}
      </div>
    </aside>
  );
}
