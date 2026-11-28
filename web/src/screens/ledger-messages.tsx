import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CollectionEmptyState,
  Conversation,
  ListDetailLayout,
  LoadingSurface,
  MessageFileCard,
  RoomHeaderActions,
  type ConversationComposer,
  type MessageView,
  type PartnerLinkResolver,
} from "@olorinm/agent-ui/pages";
import { Button, Dialog, DialogContent, DialogTitle, PartnerAvatar, EmptyState, PixelAvatarGroup, ProductIcon, StatusLine, TextButton, useCompactLayout, useToast } from "@olorinm/agent-ui/app";
import { ChatMarkdown, ImagePreview } from "@olorinm/agent-ui";
import { blockBuildReload } from "../build-version";
import { mauApi, type PartnerThread } from "../api/client";
import { ApiError, type PartnerRef } from "../api/http";
import { answerInteraction } from "@olorinm/agent-host/interactions";
import {
  AttachmentDrafts, LedgerClient, attachmentKind, attachmentUrl, cardAnswerBody, foldEvents, formatBytes, ledgerApi,
  type AttachmentRef, type Card, type ChatSummary, type LedgerApi, type LedgerBubble, type LedgerChatView, type LedgerFold, type LedgerSocket, type LedgerTurn,
  type MessageDisplay, type PartnerIntent, type PartnerResult, type PendingAnswer,
} from "../api/ledger";
import { beforeAccessReloadEvent, reloadDrafts, reloadReplyKeys, saveReloadDrafts, saveReloadReplyKeys, type Session } from "../api/session";
import { errorMessage, errorSentence, failureMessage, useI18n, type Translate } from "../i18n";
import { TaskSurface, WorkingSurface, type RunControls, type TaskLike } from "./run-surface";
import { PartnerFigureProvider, type PartnerFigureResolver, type RunIncoming } from "@olorinm/agent-ui/pages";
import { LedgerCreateGroupDialog, LedgerGroupMembersDialog, useLedgerGroup } from "./ledger-group";
import { AgentDetail } from "./agent-detail";
import { CreateAgentDialog } from "./create-agent";
import { PurgeChatDialog } from "./purge-chat-dialog";
import { OPEN_THREADS, newestPages, openThreads, withPage, type ThreadBook } from "./thread-paging";
import { liveViewUrl } from "../api/live-view";
import { BrowserSideView, Clamped, DocumentSideView, type PartnerDocument, FileSideView, ThreadSideView } from "./side-views";
import { ChatRoster, type ChatEntry, type ChatSection } from "./chat-switcher";
import { MauMark } from "../mau-mark";
import { openSettings } from "../settings/route";

const terminalTurn = ["completed", "failed", "canceled", "unknown"];
/** The chat of a session a partner works in beside its conversation with the owner (`PartnerThread`). */
const threadChat = (chatId: string) => /^obs:[^:]+:ps-[0-9a-f]{32}$/.test(chatId);
/**
 * The fold of a thread's events, kept until the thread has a newer event: a page with many threads folds each one
 * when it changes, not on every render. The client appends to the same list, so the list alone does not say.
 */
const threadFolds = new WeakMap<object, { lastSeq: number; fold: LedgerFold }>();
const foldOnce = (view: LedgerChatView) => {
  const kept = threadFolds.get(view.events);
  if (kept?.lastSeq === view.lastSeq) return kept.fold;
  const fold = foldEvents(view.events);
  threadFolds.set(view.events, { lastSeq: view.lastSeq, fold });
  return fold;
};
/** How a chat that is a thread of a partner's page is shown: its first round on the page, or all of it in the panel. */
interface ThreadMode { rounds: number; root?: boolean; panel?: boolean; title?: string | undefined }
/** A reply following one from the same sender drops the repeated avatar and name. */
const grouped = (messages: MessageView[]) => messages.map((message, index) => {
  const previous = messages[index - 1];
  return previous && message.role === "assistant" && previous.role === "assistant" && message.title === previous.title ? { ...message, continued: true } : message;
});
/** The words of a reply on one line, without the marks of its formatting. */
const oneLine = (text: string) => text.replace(/```[\s\S]*?```/g, " ").replace(/[#*`>_~|]/g, "").replace(/\s+/g, " ").trim().slice(0, 240);
const channelNames: Record<string, [string, string]> = {
  matrix: ["Matrix", "Matrix"], feishu: ["飞书", "Feishu"], "grove-mail": ["邮件", "Mail"], agentmail: ["邮件", "Mail"],
  telegram: ["Telegram", "Telegram"], weixin: ["微信", "WeChat"], schedule: ["定时", "Schedule"],
};
const deliveryNames: Record<string, [string, string]> = {
  queued: ["排队中", "queued"], sending: ["发送中", "sending"], sent: ["已送达", "sent"], suppressed: ["未发送", "not sent"],
  rejected: ["发送失败", "failed"], unknown: ["送达未知", "unknown"], replied: ["已回复", "replied"],
};

const cardStatusNames: Record<string, [string, string]> = {
  answered: ["已回答", "Answered"], approved: ["已允许", "Approved"], rejected: ["已拒绝", "Rejected"],
  expired: ["已过期", "Expired"], canceled: ["已取消", "Canceled"],
};
/** How a request of a partner closed; one that is closed before it was answered was withdrawn by the partner's side. */
const requestStatusKeys = { approved: "card.approved", rejected: "card.rejected", expired: "card.expired", canceled: "card.withdrawn" } as const;
/**
 * A request of the product in words, its title first. A partner's request carries its members and is worded in the
 * interface's language; the operation's arguments are shown as they are written. Any other is the server's text.
 */
function requestText(t: Translate, card: Card): string[] {
  const schedule = card.display?.scheduleConfirmation;
  if (schedule) {
    const list = (items: readonly string[]) => items.join(t("list.separator")) || t("card.schedule.none");
    return [t(`card.schedule.title.${schedule.kind}`), [
      t("card.schedule.name", { name: schedule.name }),
      schedule.schedule.type === "daily" ? t("card.schedule.daily", { at: schedule.schedule.at, timeZone: schedule.timeZone })
        : t("card.schedule.interval", { minutes: String(schedule.schedule.minutes), timeZone: schedule.timeZone }),
      t(schedule.execution === "direct" ? "card.schedule.message" : "card.schedule.instruction", { text: schedule.instruction }),
      schedule.operations ? t("card.schedule.operations", { connections: list(schedule.connections), operations: list(schedule.operations) })
        : t("card.schedule.connections", { connections: list(schedule.connections) }),
      ...(schedule.skills.length ? [t("card.schedule.skills", { skills: list(schedule.skills) })] : []),
      ...(schedule.precheck ? [t("card.schedule.precheck", { precheck: schedule.precheck })] : []),
      schedule.notify === null ? t("card.schedule.notify.none") : schedule.notify === "web" ? t("card.schedule.notify.web") : t("card.schedule.notify.connection", { connection: schedule.notify }),
    ].join("\n")];
  }
  const approval = card.display?.partnerApproval;
  if (!approval) return card.text.split("\n\n");
  return [t("card.partnerApproval.title", { partner: approval.partner.name }), [
    t("card.partnerApproval.operation", { from: approval.from.name, summary: approval.summary }),
    // A connector operation names its connection and arguments; what a partner's kernel asks is its text alone.
    ...(approval.connection !== undefined ? [t("card.partnerApproval.connection", { connection: approval.connection }), t("card.partnerApproval.arguments", { arguments: approval.arguments ?? "" })] : []),
  ].join("\n")];
}

/**
 * A ledger card outside a run surface (Router's own "重新执行 / 不用了" card, a partner's request for approval, or a
 * turn without a loaded run): buttons answer by choice, free-text cards by text. A pending handoff card reads its
 * live text (the private link is never stored in history).
 */
function LedgerCardView({ client, api, chatId, card, answer }: {
  client: LedgerClient; api: LedgerApi; chatId: string; card: Card; answer: PendingAnswer | undefined;
}) {
  const { t, language } = useI18n(), zh = language === "zh-CN";
  const pending = card.status === "pending";
  const live = useQuery({ queryKey: ["ledger-card", chatId, card.cardId, card.status], enabled: pending && card.source === "mau-handoff",
    queryFn: ({ signal }) => api.card(chatId, card.cardId, signal), retry: false, refetchOnWindowFocus: false });
  const [draft, setDraft] = useState("");
  const busy = answer?.state === "sending";
  const send = (body: { choiceId: string } | { text: string }) => void client.answerCard(chatId, card.cardId, body).catch(() => undefined);
  const request = card.source === "product", [heading, ...rest] = request ? requestText(t, card) : [];
  const closed = request ? requestStatusKeys[card.status as keyof typeof requestStatusKeys] : undefined;
  // A partner's request is answered by approving or rejecting, in that order.
  const labels = card.display?.partnerApproval?.connection !== undefined ? [t("card.partnerApproval.approve"), t("card.partnerApproval.reject")]
    : card.display?.scheduleConfirmation ? [t("card.schedule.confirm"), t("card.schedule.reject")] : [];
  return <div className="mau-ledger-card" data-density="compact" data-card-id={card.cardId} data-card-status={card.status} data-card-source={card.source}>
    {request ? <div className="mau-card-text">{rest.length ? <strong>{heading}</strong> : null}<p>{rest.length ? rest.join("\n\n") : heading}</p></div>
      : <ChatMarkdown markdown={live.data?.text ?? card.text} />}
    {pending && card.kind === "sensitive" ? <p className="mau-muted">{zh ? "请在执行内核的原生入口完成敏感输入，不要在聊天中发送密码或令牌。" : "Complete sensitive input in the runtime's native prompt; never send secrets in chat."}</p> : null}
    {pending && card.kind !== "sensitive" && card.choices.length && answer?.state !== "stale" ? <div className="mau-card-actions">
      {card.choices.map((choice, index) => <TextButton key={choice.choiceId} tone={choice.style === "danger" ? "danger" : "primary"} disabled={busy}
        onClick={() => send({ choiceId: choice.choiceId })}>{labels[index] ?? choice.label}</TextButton>)}
    </div> : null}
    {pending && card.kind !== "sensitive" && card.freeText ? <form className="mau-card-reply" onSubmit={(event) => {
      event.preventDefault(); if (draft.trim()) { send({ text: draft.trim() }); setDraft(""); } }}>
      <input aria-label={zh ? "回答" : "Answer"} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={zh ? "输入回答…" : "Type an answer…"} />
      <Button type="submit" disabled={busy || !draft.trim()}>{zh ? "回答" : "Answer"}</Button>
    </form> : null}
    {card.status !== "pending" ? <p className="mau-muted mau-card-status"><StatusLine tone={card.status === "approved" ? "success" : "neutral"}>
      {closed ? t(closed) : cardStatusNames[card.status]?.[zh ? 0 : 1] ?? card.status}</StatusLine></p> : null}
    {answer?.state === "stale" ? <p className="mau-muted">{t("card.answeredElsewhere")}</p> : null}
    {answer && (answer.state === "failed" || answer.state === "rejected") ? <p role="alert">{errorMessage(t, answer.error ?? "request_failed")}
      {answer.state === "failed" ? <Button onClick={() => send(answer.body as { choiceId: string } | { text: string })}>{t("common.retry")}</Button> : null}
      <Button onClick={() => client.dismissAnswer(chatId, card.cardId)}>{zh ? "放弃" : "Dismiss"}</Button></p> : null}
  </div>;
}

/** One ledger turn rendered with the existing run surface, keyed by turnId. */
function LedgerTurnSurface({ api, chatId, turn, token, fallback, onInsertPrompt, controls, partnerLink, waiting, incoming }: {
  api: LedgerApi; chatId: string; turn: LedgerTurn; token: string; fallback: string; onInsertPrompt(prompt: string): void;
  /** What another partner sent that this turn answers. */
  incoming?: RunIncoming[] | undefined;
  /** What a turn that has not started waits for. */
  waiting?: string | undefined;
  controls?: RunControls | undefined; partnerLink?: PartnerLinkResolver | undefined;
}) {
  const terminal = terminalTurn.includes(turn.state);
  const detail = useQuery({
    queryKey: ["ledger-turn", token, chatId, turn.turnId, turn.state],
    queryFn: ({ signal }) => api.turn(chatId, turn.turnId, signal),
    retry: false,
    // A state change (running → completed) refetches; keep the run on screen meanwhile instead of remounting it.
    placeholderData: keepPreviousData,
    ...(terminal ? { staleTime: Infinity } : {}),
    refetchInterval: (query) => query.state.error || terminal ? false : 3000,
  });
  if (!detail.data && !incoming) return detail.error || terminal
    ? fallback ? <ChatMarkdown markdown={fallback} /> : null
    : <WorkingSurface fallback={fallback} waiting={waiting} />;
  const task: TaskLike = { id: turn.turnId, status: detail.data?.state ?? turn.state, runs: detail.data?.runs ?? [] };
  return <TaskSurface task={task} token={token} agentId={turn.agentId} fallback={fallback} onInsertPrompt={onInsertPrompt} controls={controls} partnerLink={partnerLink} waiting={waiting} incoming={incoming} />;
}

async function saveAttachment(api: LedgerApi, ref: AttachmentRef) {
  const url = URL.createObjectURL(await api.downloadAttachment(ref));
  const link = document.createElement("a");
  link.href = url; link.download = ref.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * An inline image from its same-origin attachment URL: the browser sends the Access cookie itself (edge login, no
 * bearer token), so the URL is the `<img src>`. A click opens the shared image preview.
 */
function LedgerImage({ api, attachment, onError }: { api: LedgerApi; attachment: AttachmentRef; onError(error: unknown): void }) {
  const { language } = useI18n(), zh = language === "zh-CN";
  const src = attachmentUrl(attachment);
  const [failed, setFailed] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => { setFailed(false); }, [attachment.attachmentId]);
  if (failed) return <AttachmentChip api={api} attachment={attachment} onError={onError} detail={zh ? "图片无法显示" : "Image unavailable"} />;
  return <>
    <button type="button" className="mau-attachment-image" title={attachment.name} onClick={() => setPreviewing(true)}>
      <img src={src} alt={attachment.name} loading="lazy" onError={() => setFailed(true)} />
    </button>
    {previewing ? <ImagePreview image={{ src, alt: attachment.name }} onClose={() => setPreviewing(false)} /> : null}
  </>;
}
/** A file as a download chip (name and size). */
const codeExtensions = /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|py|go|rs|java|kt|swift|rb|php|sh|css|html?|xml|sql)$/i;
/** "Text", "PDF", "PNG"…: the file's kind, from its type or extension. */
function fileKind(attachment: AttachmentRef, zh: boolean) {
  const extension = /\.([a-z0-9]{1,8})$/i.exec(attachment.name)?.[1];
  if (attachment.contentType.startsWith("text/") && !codeExtensions.test(attachment.name)) return zh ? "文本" : "Text";
  if (extension) return extension.toUpperCase();
  return attachment.contentType.split("/")[1]?.toUpperCase() ?? (zh ? "文件" : "File");
}
/** A file in a message: a card with its kind; a click downloads it. */
function AttachmentChip({ api, attachment, onError, detail, onPreview }: { api: LedgerApi; attachment: AttachmentRef; onError(error: unknown): void; detail?: string;
  /** Opens the file beside the conversation instead of downloading it. */
  onPreview?: ((attachment: AttachmentRef) => void) | undefined }) {
  const { language } = useI18n(), zh = language === "zh-CN";
  const size = formatBytes(attachment.size);
  const kind = attachmentKind(attachment.contentType);
  return <MessageFileCard name={attachment.name} title={onPreview ? (zh ? `查看 ${attachment.name}` : `View ${attachment.name}`) : (zh ? `下载 ${attachment.name}` : `Download ${attachment.name}`)}
    kind={kind === "image" ? "image" : codeExtensions.test(attachment.name) ? "code" : kind === "text" ? "text" : "file"}
    detail={detail ?? (size ? `${fileKind(attachment, zh)} · ${size}` : fileKind(attachment, zh))}
    onOpen={() => onPreview ? onPreview(attachment) : void saveAttachment(api, attachment).catch(onError)} />;
}
/** Message attachments: images inline, other files as download chips. */
function LedgerAttachments({ api, attachments, onError, onPreview }: { api: LedgerApi; attachments: readonly AttachmentRef[]; onError(error: unknown): void;
  onPreview?: ((attachment: AttachmentRef) => void) | undefined }) {
  return <div className="mau-attachments">
    {attachments.map((ref) => attachmentKind(ref.contentType) === "image"
      ? <LedgerImage key={ref.attachmentId} api={api} attachment={ref} onError={onError} />
      : <AttachmentChip key={ref.attachmentId} api={api} attachment={ref} onError={onError} onPreview={onPreview} />)}
  </div>;
}

/**
 * Messages served by Router's owner ledger (agent-router ADR 0005).
 */
export function LedgerMessagesScreen({ session, initialAgentId, onStartHandled, limits }: {
  session: Session; initialAgentId?: string | undefined; onStartHandled?(): void;
  /** `GET /me` attachment limits (ADR 0005 16.5). */
  limits?: { bytes: number; perMessage: number } | undefined;
}) {
  const { t, language } = useI18n();
  const zh = language === "zh-CN";
  const { toast } = useToast();
  const queries = useQueryClient();
  const agents = useQuery({ queryKey: ["agents", session.owner], queryFn: () => mauApi(session.token).agents(),
    // Provisioning and lifecycle changes are durable server operations; poll faster only while one runs.
    refetchInterval: (query) => query.state.data?.some((item) => item.environment?.busy) ? 1000
      // A computer that is pairing shows up within seconds.
      : query.state.data?.some((item) => item.connection === "pairing" && !item.dismissed) ? 3000 : 10_000 });
  // The partners as they work together: who recruited whom, and what waits at each. Read more often while something waits.
  const partnerViews = useQuery({ queryKey: ["partners", session.owner], queryFn: () => mauApi(session.token).partners(), retry: false,
    refetchInterval: (query) => query.state.data?.some((item) => item.waiting.messages || item.waiting.approvals) ? 3000 : 10_000 });
  const api = useMemo(() => ledgerApi(session.token), [session.token]);
  const client = useMemo(() => new LedgerClient(api, { socket: (url) => new WebSocket(url) as unknown as LedgerSocket }), [api]);
  useSyncExternalStore(client.subscribe, client.getVersion);
  // Composer uploads (ADR 0005 16.5): each file is uploaded when it is picked, pasted or dropped.
  const limitsRef = useRef(limits);
  limitsRef.current = limits;
  const uploads = useMemo(() => new AttachmentDrafts((file, name, options) => api.uploadAttachment(file, name, options), {
    limits: () => limitsRef.current ?? { bytes: 25 * 1024 * 1024, perMessage: 10 },
    preview: (file) => URL.createObjectURL(file), revoke: (url) => URL.revokeObjectURL(url),
  }), [api]);
  useSyncExternalStore(uploads.subscribe, uploads.getVersion);
  const [dragging, setDragging] = useState(false);
  useEffect(() => { client.connect(); return () => client.disconnect(); }, [client]);
  const chats = useQuery({ queryKey: ["ledger-chats", session.token], queryFn: ({ signal }) => client.loadChats(signal), retry: false });
  const names = new Map(agents.data?.map(({ agent }) => [agent.id, agent.name]) ?? []);

  const [selected, setSelected] = useState<string>();
  // The partner whose profile stands in place of the list of conversations, and the new-partner dialog.
  const [profile, setProfile] = useState<string>();
  // A narrow screen shows one thing at a time: the list, then a conversation, then a profile on top of either.
  const compact = useCompactLayout();
  const [creating, setCreating] = useState(false);
  // On the right of the conversation: a message's file, or the browser a partner handed over.
  const [sideView, setSideView] = useState<{ kind: "file"; attachment: AttachmentRef } | { kind: "browser"; cardId: string }
    | { kind: "document"; agentId: string; name: PartnerDocument } | { kind: "thread"; agentId: string; sessionId: string; chatId: string }>();
  const dismissedHandoff = useRef<string | undefined>(undefined);
  const [grouping, setGrouping] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  // Text kept across an Access re-login reload ("重新登录") is restored once.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => reloadDrafts());
  const latestDrafts = useRef(drafts);
  latestDrafts.current = drafts;
  // What was last sent in each thread and has not been answered for: sending the same words again is the same message,
  // so a reply whose answer was lost on the way back does not become a second turn. Kept across that reload with the text.
  const replyKeys = useRef(new Map(Object.entries(reloadReplyKeys())));
  useEffect(() => {
    reloadDrafts(sessionStorage, true); reloadReplyKeys(sessionStorage, true);
    const save = () => { saveReloadDrafts(latestDrafts.current); saveReloadReplyKeys(Object.fromEntries(replyKeys.current)); };
    globalThis.addEventListener(beforeAccessReloadEvent, save);
    return () => globalThis.removeEventListener(beforeAccessReloadEvent, save);
  }, []);
  const [withdrawing, setWithdrawing] = useState<{ chatId: string; eventId: string }>();
  // Phase 4 control: "新对话" asks to stop a running turn first; purge needs the chat's name typed.
  const [busyReset, setBusyReset] = useState<string>();
  const [purging, setPurging] = useState<{ chatId: string; title: string }>();

  useEffect(() => {
    if (!selected) return;
    void client.openChat(selected).catch(() => undefined);
    return () => client.closeChat(selected);
  }, [client, selected]);
  const list = client.chatList();
  // A turn that starts or ends, or a card that opens or closes, changes what waits at the partners.
  const activity = list.map((chat) => `${chat.chatId}:${chat.activeTurns}:${chat.pendingCards}`).join("\n");
  useEffect(() => {
    void queries.invalidateQueries({ queryKey: ["partners", session.owner] });
    void queries.invalidateQueries({ queryKey: ["partner-sessions", session.owner] });
  }, [activity]);
  // On a wide screen the first conversation opens by itself: a chat with a partner before another channel's session.
  useEffect(() => {
    if (selected || !agents.isSuccess || !matchMedia("(min-width: 901px)").matches) return;
    const partners = new Set(agents.data.flatMap(({ agent, dismissed }) => dismissed ? [] : [agent.id]));
    const first = list.find((chat) => chat.kind === "dm" && partners.has(chat.agentIds[0] ?? ""))
      ?? list.find((chat) => chat.kind === "group") ?? list.find((chat) => !observedKey(chat)?.startsWith("work:") && !threadChat(chat.chatId));
    if (first) setSelected(first.chatId);
  }, [list.length, selected, agents.isSuccess]);

  const current: ChatSummary | undefined = selected ? client.chats.get(selected) : undefined;
  const view = selected ? client.view(selected) : undefined;
  const fold = useMemo(() => view ? foldEvents(view.events) : undefined, [view?.events, view?.lastSeq]);
  // A pending browser handoff: its private live-view link is read from the live card (history never stores it) and the
  // view opens beside the conversation, where the owner operates the page.
  const handoffCard = fold ? [...fold.cards.values()].find((card) => card.source === "mau-handoff" && card.status === "pending") : undefined;
  const handoffLive = useQuery({ queryKey: ["ledger-card", current?.chatId, handoffCard?.cardId, "pending"], enabled: !!current && !!handoffCard,
    queryFn: ({ signal }) => api.card(current!.chatId, handoffCard!.cardId, signal), retry: false, refetchOnWindowFocus: false });
  const handoffUrl = handoffCard ? liveViewUrl(handoffLive.data) : undefined;
  useEffect(() => {
    if (handoffCard && handoffUrl && dismissedHandoff.current !== handoffCard.cardId) { setProfile(undefined); setSideView({ kind: "browser", cardId: handoffCard.cardId }); }
    else if (!handoffCard) setSideView((view) => view?.kind === "browser" ? undefined : view);
  }, [handoffCard?.cardId, handoffUrl]);
  useEffect(() => { setSideView((view) => view?.kind === "file" || view?.kind === "document" || view?.kind === "thread" ? undefined : view); }, [current?.chatId]);
  const room = useLedgerGroup({ token: session.token, chat: current, view, agents: agents.data ?? [] });
  const agentName = (agentId: string) => room.group ? room.nameOf(agentId) : names.get(agentId) ?? current?.title ?? agentId;

  // Read up to the newest event while the chat is on screen.
  useEffect(() => {
    if (!selected || !view?.loaded || view.lastSeq <= view.readSeq || document.visibilityState !== "visible") return;
    void client.markRead(selected, view.lastSeq).catch(() => undefined);
  }, [client, selected, view?.loaded, view?.lastSeq, view?.readSeq]);

  const open = (summary: ChatSummary) => { client.updateSummary(summary); setSelected(summary.chatId); };
  const start = useMutation({
    mutationFn: (agentId: string) => api.openDm(agentId),
    onSuccess: (summary) => { onStartHandled?.(); open(summary); },
  });
  const requested = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (initialAgentId && agents.data?.some(({ agent }) => agent.id === initialAgentId) && requested.current !== initialAgentId) {
      requested.current = initialAgentId;
      start.mutate(initialAgentId);
    }
    if (!initialAgentId) requested.current = undefined;
  }, [initialAgentId, agents.data]);

  const pendingSends = view?.pending ?? [];
  useEffect(() => blockBuildReload(pendingSends.length > 0 || Object.values(drafts).some((value) => !!value.trim())), [pendingSends.length, drafts]);

  const [uploadError, setUploadError] = useState<unknown>();

  const reset = useMutation({
    mutationFn: (input: { chatId: string; cancelActive: boolean }) => client.reset(input.chatId, input.cancelActive),
    onSuccess: () => setBusyReset(undefined),
    onError: (failed, input) => { if (failed instanceof ApiError && failed.code === "session_busy") setBusyReset(input.chatId); },
  });
  const quiet = (failed: unknown) => failed instanceof ApiError && failed.code === "session_busy" ? null : failed;
  const connectionError = client.connection.state === "closed" && client.connection.error;
  const error = agents.error ?? chats.error ?? start.error ?? uploadError ?? quiet(reset.error)
    ?? (connectionError ? new ApiError(connectionError, 401) : null) ?? (view?.error ? new ApiError(view.error, 0) : null);
  const failure = error ? (
    <p role="alert" className="mau-error">
      {errorMessage(t, error instanceof ApiError ? error.code : "request_failed")}
      {chats.error || view?.error ? <Button onClick={() => { void chats.refetch(); if (selected) void client.openChat(selected).catch(() => undefined); }}>{zh ? "重新连接" : "Reconnect"}</Button> : null}
    </p>
  ) : null;

  // Observed sessions are titled by their session key when they have no label. Feishu groups read as the channel;
  // an Agent's own work sessions ("work:…") are not conversations and stay out of the list.
  // Router titles an unlabeled session with its session key ("feishu:group:<chat>[:<thread>]", "work:<name>"); the chat id
  // itself is opaque.
  const observedKey = (chat: ChatSummary) => chat.kind !== "observed" ? undefined
    : /^[a-z][a-z-]*:\S+$/.test(chat.title) ? chat.title : /^obs:[^:]+:(.+)$/.exec(chat.chatId)?.[1];
  const titleOf = (chat: ChatSummary) => {
    const key = observedKey(chat);
    if (!key || chat.title !== key && chat.title !== chat.chatId) return chat.title;
    const agent = names.get(chat.agentIds[0] ?? "");
    const parts = key.split(":");
    const channel = parts[0] === "feishu" && parts[1] === "group" ? (parts[3] ? (zh ? "飞书话题" : "Feishu thread") : (zh ? "飞书群聊" : "Feishu group"))
      : parts[0] === "feishu" ? (zh ? "飞书" : "Feishu")
      : channelNames[parts[0]!]?.[zh ? 0 : 1] ?? (zh ? "其他渠道" : "Other channel");
    // Several sessions of one channel are told apart by the tail of their own id.
    const tail = (parts[3] ?? parts[2] ?? parts[1] ?? "").slice(-4);
    return `${agent ? `${agent} · ` : ""}${channel}${tail ? ` ${tail}` : ""}`;
  };

  // Everyone the owner can talk to: each partner (with or without a chat yet), then groups and other channels' sessions.
  type Entry = ChatEntry & { chat?: ChatSummary | undefined; agentId?: string | undefined };
  const clock = (at: string | undefined) => {
    if (!at) return undefined;
    const date = new Date(at);
    return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleDateString(language, { month: "numeric", day: "numeric" });
  };
  const known = new Set((agents.data ?? []).map(({ agent }) => agent.id));
  const dms = new Map(list.flatMap((chat) => chat.kind === "dm" && chat.agentIds[0] ? [[chat.agentIds[0], chat] as const] : []));
  const unavailable = ["unconfigured", "paused", "deleting", "deleted", "needs_action"];
  const views = new Map(partnerViews.data?.map((item) => [item.id, item]) ?? []);
  // The last event is a preview of the conversation when somebody in it wrote it: a person, or a partner the chat is
  // with. What another partner sent into it is recorded as the text its model reads, and a system line is not a message.
  const preview = (chat: ChatSummary | undefined) => {
    const last = chat?.lastEvent;
    if (!chat || !last) return undefined;
    const { type, id } = last.sender;
    return type === "person" || type === "external" || type === "agent" && chat.agentIds.includes(id) ? last.preview : undefined;
  };
  const partnerEntry = ({ agent, environment, dismissed, kind, connection }: NonNullable<typeof agents.data>[number]): Entry => {
    const chat = dms.get(agent.id), state = environment?.state ?? "unconfigured", waiting = dismissed ? undefined : views.get(agent.id)?.waiting;
    // A partner on the owner's computer is online or offline; a computer that is off is not working, whatever waits for it.
    const device = kind === "external" ? connection ?? "pairing" : undefined, away = device !== undefined && device !== "online";
    // Its sessions are threads of its page, not conversations of their own: what is new or running in one shows here.
    const sessions = list.filter((item) => threadChat(item.chatId) && item.agentIds[0] === agent.id);
    const working = !away && (!!chat?.activeTurns || !!waiting?.messages || sessions.some((item) => item.activeTurns));
    // The row shows the newest thing on the partner's page, in its conversation or in one of its threads.
    const latest = [chat, ...sessions].reduce<ChatSummary | undefined>((newest, item) =>
      item?.lastEvent && (!newest?.lastEvent || item.lastEvent.at > newest.lastEvent.at) ? item : newest, undefined) ?? chat;
    // The figure's eyes carry the state: aside while a reply runs (the owner's or another partner's message), closed
    // when the environment cannot take messages or the partner is dismissed.
    const figure = dismissed || away ? "offline" : working ? "working" : !device && unavailable.includes(state) ? "offline" : "idle";
    return { key: "agent:" + agent.id, title: agent.name,
      status: dismissed ? t("partners.dismissedState") : waiting?.approvals ? t("partners.waitingApproval") : working ? (zh ? "正在处理" : "Working") : t(device ? `device.${device}` : `state.${state}`),
      preview: preview(latest), time: clock(latest?.lastEvent?.at), unread: (chat?.unread ?? 0) + sessions.reduce((sum, item) => sum + item.unread, 0), chat, agentId: agent.id,
      ...(waiting?.approvals ? { note: t("partners.waitingApproval") } : {}),
      avatar: (size) => <PartnerAvatar seed={agent.id} fallbackName={agent.name} size={size} state={figure} /> };
  };
  // A dismissed partner keeps its conversation and is put away from the list.
  const activeAgents = (agents.data ?? []).filter((item) => !item.dismissed);
  const agentEntries: Entry[] = activeAgents.map(partnerEntry);
  const dismissedEntries: Entry[] = (agents.data ?? []).filter((item) => item.dismissed).map(partnerEntry);
  const chatEntry = (chat: ChatSummary): Entry => ({ key: "chat:" + chat.chatId, title: titleOf(chat), preview: preview(chat),
    time: clock(chat.lastEvent?.at), unread: chat.unread, chat,
    ...(chat.kind === "group" ? { status: `${chat.agentIds.length + 1} ${zh ? "位成员" : "participants"}` }
      : { agentId: chat.agentIds[0], status: zh ? "只读" : "Read-only" }),
    avatar: (size) => chat.kind === "group" ? <PixelAvatarGroup seeds={chat.agentIds} size={size} />
      : <PartnerAvatar seed={chat.agentIds[0] ?? chat.chatId} fallbackName={chat.title} size={size} /> });
  const groupEntries = list.filter((chat) => chat.kind === "group").map(chatEntry);
  // Sessions on other channels (a Feishu group, a chat with a partner that no longer exists) can be read here.
  const otherEntries = list.filter((chat) => chat.kind !== "group" && !(chat.kind === "dm" && known.has(chat.agentIds[0] ?? ""))
    && !observedKey(chat)?.startsWith("work:") && !threadChat(chat.chatId)).map(chatEntry);
  const allEntries = [...agentEntries, ...groupEntries, ...otherEntries];
  const currentKey = !current ? undefined : current.kind === "dm" && known.has(current.agentIds[0] ?? "") ? "agent:" + current.agentIds[0] : "chat:" + current.chatId;
  // The profile card follows the conversation; it closes on one that has no single partner.
  const currentAgent = current && current.kind !== "group" ? current.agentIds[0] : undefined;
  useEffect(() => { setProfile((open) => open === undefined ? open : currentAgent && known.has(currentAgent) ? currentAgent : undefined); }, [current?.chatId]);
  const profileSummary = profile ? agents.data?.find(({ agent }) => agent.id === profile) : undefined;
  // The sessions the partner on screen works in beside this conversation. Each is a thread of this page: its first
  // round stands in the conversation where it began, and the rest opens beside it.
  const threadAgent = current?.kind === "dm" && currentAgent && known.has(currentAgent) ? currentAgent : undefined;
  // The threads of each partner the page has been given, page by page: the list is the server's, which keeps it however long it grows.
  const [books, setBooks] = useState<Record<string, ThreadBook<PartnerThread>>>({});
  const given = useRef(books);
  given.current = books;
  const threads = useQuery({ queryKey: ["partner-sessions", session.owner, threadAgent], enabled: !!threadAgent, retry: false,
    queryFn: () => newestPages(given.current[threadAgent!], (before) => mauApi(session.token).sessions(threadAgent!, before ? { before, limit: OPEN_THREADS } : {})),
    refetchInterval: (query) => [...query.state.data?.data ?? [], ...query.state.data?.active ?? []].some((item) => item.working) ? 3000 : 15_000 });
  useEffect(() => {
    const page = threads.data;
    if (threadAgent && page) setBooks((values) => ({ ...values, [threadAgent]: withPage(values[threadAgent], page, true) }));
  }, [threads.data, threadAgent]);
  const book = threadAgent ? books[threadAgent] : undefined, earlierThreads = !!book?.earlier;
  const pagingThreads = useRef<Promise<void>>(undefined);
  const moreThreads = () => pagingThreads.current ??= (async () => {
    const before = book?.earlier;
    if (!threadAgent || !before) return;
    const page = await mauApi(session.token).sessions(threadAgent, { before, limit: OPEN_THREADS });
    setBooks((values) => ({ ...values, [threadAgent]: withPage(values[threadAgent], page, false) }));
  })().finally(() => { pagingThreads.current = undefined; });
  const openThreadId = sideView?.kind === "thread" ? sideView.sessionId : undefined;
  const { live: liveThreads, read: readThreads, from: threadsFrom } = useMemo(() => openThreads(book, threadAgent ? threads.data?.active ?? [] : [], openThreadId), [book, threads.data, threadAgent, openThreadId]);
  const threadList = useMemo(() => [...liveThreads, ...readThreads], [liveThreads, readThreads]);
  // Threads the page follows are subscribed to; the others are read once, and followed when something happens in them.
  const threadChats = liveThreads.map((item) => item.chatId).join("\n"), readChats = readThreads.map((item) => item.chatId).join("\n");
  useEffect(() => {
    const ids = threadChats ? threadChats.split("\n") : [];
    for (const id of ids) void client.openChat(id).catch(() => undefined);
    return () => { for (const id of ids) client.closeChat(id); };
  }, [client, threadChats]);
  useEffect(() => { for (const id of readChats ? readChats.split("\n") : []) void client.readChat(id).catch(() => undefined); }, [client, readChats]);
  // A thread is read from its first round: the page shows where it began, and counts its rounds. One at a time; a
  // thread whose earlier part could not be read is shown from what was read, and tried again when the page is opened again.
  const [stalled, setStalled] = useState<ReadonlySet<string>>(new Set());
  const unreadHead = threadList.find((item) => { const read = client.view(item.chatId); return read.loaded && read.hasOlder && !read.error && !stalled.has(item.chatId); })?.chatId;
  useEffect(() => {
    if (unreadHead) void client.loadOlder(unreadHead).catch(() => setStalled((values) => new Set(values).add(unreadHead)));
  }, [client, unreadHead, unreadHead ? client.view(unreadHead).events.length : 0]);
  const threadsLoading = threadList.some((item) => { const read = client.view(item.chatId); return !read.error && !stalled.has(item.chatId) && (!read.loaded || read.hasOlder); });
  const show = (entry: Entry) => {
    setProfile(undefined);
    if (entry.chat) setSelected(entry.chat.chatId);
    else if (entry.agentId) start.mutate(entry.agentId);
  };
  // The name in a conversation's header leads to who is in it: the partner's profile, or the members of a group.
  const currentEntry = [...allEntries, ...dismissedEntries].find((entry) => entry.key === currentKey);
  const about = !current ? undefined : current.kind === "group" ? () => setMembersOpen(true)
    : currentAgent && known.has(currentAgent) ? () => setProfile((open) => open === currentAgent ? undefined : currentAgent) : undefined;
  // The current conversation's row again does the same.
  const pick = (entry: Entry) => entry.key === currentKey && about ? about() : show(entry);
  const page = !compact ? undefined : profileSummary ? "profile" : selected ? "chat" : "list";
  // Another partner named in a conversation (the sender of a message, a recruit, the one that asks for approval)
  // leads to the conversation with it.
  const openPartner = (agentId: string | undefined) => {
    const entry = agentId && agentId !== currentAgent ? [...agentEntries, ...dismissedEntries].find((item) => item.agentId === agentId) : undefined;
    return entry ? () => show(entry) : undefined;
  };
  // A run's activity names partners as its tool was given them: by name.
  const partnerIds = new Map((agents.data ?? []).map(({ agent }) => [agent.name, agent.id]));
  const partnerLink: PartnerLinkResolver = (name) => openPartner(partnerIds.get(name));
  // A row about a partner carries that partner's figure where a step of another kind has its icon.
  const partnerFigure: PartnerFigureResolver = (name) => {
    const id = partnerIds.get(name);
    return id ? <PartnerAvatar seed={id} fallbackName={name} size={16} animated={false} /> : undefined;
  };
  const partnerAuthor = ({ id, name }: PartnerRef) => {
    const open = openPartner(id);
    return { title: name, avatar: <PartnerAvatar seed={id} fallbackName={name} size={28} animated={false} />, ...(open ? { onAuthorClick: open } : {}) };
  };
  // A result that is not completed says so under the partner's name, with the reason in words where there is one.
  /** What is said of a result that is not a whole answer: that it is not completed (and why), or that it was cut. */
  const resultNote = (result: PartnerResult) => {
    const cut = result.cut ? t("partners.result.cut", { name: result.partner.name }) : "";
    if (result.status === "completed") return { failed: false, text: cut };
    const status = t(`partners.result.${result.status}`), reason = result.error;
    // A reason that is a code has a sentence here, or stays behind the status as its tooltip; the runtime's own words are shown.
    const code = reason && /^[A-Za-z0-9_.:-]+$/.test(reason) ? reason : undefined;
    const said = code ? errorSentence(t, code) : reason;
    const text = said ? t("partners.result.reason", { status, reason: said }) : status;
    return { failed: true, text: [text, cut].filter(Boolean).join(" "), ...(code && !said ? { code } : {}) };
  };
  const resultStatus = (result: PartnerResult) => {
    const note = resultNote(result);
    if (!note.text) return {};
    return note.failed ? { state: "failed", status: <span {...(note.code ? { title: note.code } : {})}>{note.text}</span> } : { state: "note", status: note.text };
  };
  /**
   * What another partner sent, as the first steps of the reply it started: a row under that partner's figure that
   * names it and opens the message as it was written.
   */
  const incomingRows = (eventId: string, display: MessageDisplay | undefined, title?: string): RunIncoming[] | undefined => {
    const { partnerMessage: sent, partnerResults: results } = display ?? {};
    const row = (key: string, partner: PartnerRef, kind: "reply" | PartnerIntent, text: string, note?: { text: string; code?: string }): RunIncoming => {
      const [before = "", after = ""] = t(`partners.incoming.${kind}`, { name: "\u0000" }).split("\u0000");
      const summary = before + partner.name + after;
      return { key, icon: <PartnerAvatar seed={partner.id} fallbackName={partner.name} size={16} animated={false} />, before, name: partner.name, after,
        summary: title ? t("partners.incoming.titled", { summary, title }) : summary,
        ...(text ? { content: <ChatMarkdown markdown={text} />, contentLabel: t(kind === "reply" ? "partners.incoming.replyText" : "partners.incoming.messageText") } : {}),
        ...(note?.text ? { note: note.text, ...(note.code ? { noteTitle: note.code } : {}) } : {}) };
    };
    if (results) return results.map((result, index) => row(`${eventId}:${index}`, result.partner, "reply", result.answer, resultNote(result)));
    return sent ? [row(eventId, sent.from, sent.intent, sent.text)] : undefined;
  };
  const restore = useMutation({
    mutationFn: (entry: Entry) => mauApi(session.token).restoreAgent(entry.agentId!),
    onSuccess: (_summary, entry) => {
      toast({ kind: "success", title: t("partners.restored", { name: entry.title }) });
      return Promise.all([agents.refetch(), partnerViews.refetch()]);
    },
    onError: (failed) => { if (!(failed instanceof ApiError && failed.status === 401)) toast({ kind: "error", title: failureMessage(t, failed) }); },
  });

  const insertPrompt = (value: string) => { if (selected) setDrafts((values) => ({ ...values, [selected]: value })); };
  const actorAvatar = (bubble: LedgerBubble) => <PartnerAvatar seed={bubble.sender.id} fallbackName={bubble.sender.name} size={28} animated={false} {...(bubble.sender.type === "person" ? { appearance: "illustrated" as const } : {})} />;
  // The DM merges the owner's messages from every channel; non-web origins carry a small badge.
  const badge = (bubble: LedgerBubble) => bubble.channel && bubble.channel.kind !== "web" && bubble.channel.kind !== "room" ? (
    <span className="mau-channel-badge" data-channel={bubble.channel.kind}>
      {bubble.channel.label ?? channelNames[bubble.channel.kind]?.[zh ? 0 : 1] ?? bubble.channel.kind}
    </span>
  ) : null;
  const describe = (bubble: LedgerBubble) => {
    const parts: string[] = [];
    if (bubble.redacted) return "";
    if (bubble.edited) parts.push(zh ? "已编辑" : "edited");
    if (bubble.possibleDuplicate) parts.push(zh ? "可能重复执行" : "may be a duplicate run");
    for (const delivery of bubble.deliveries)
      parts.push(`${channelNames[delivery.channel.kind]?.[zh ? 0 : 1] ?? delivery.channel.kind} · ${deliveryNames[delivery.status]?.[zh ? 0 : 1] ?? delivery.status}`);
    for (const reaction of bubble.reactions) parts.push(`${reaction.key} ${reaction.senders.length}`);
    return parts.join(" · ");
  };
  const attachmentsOf = (refs: readonly AttachmentRef[]) => refs.length ? <LedgerAttachments api={api} attachments={refs} onError={setUploadError}
    onPreview={(attachment) => { setProfile(undefined); setSideView({ kind: "file", attachment }); }} /> : undefined;

  // Only the owner's own web messages can be withdrawn (no edit); the key is present only on those (§8.2).
  const canRedact = (item: LedgerBubble) => item.kind === "message" && item.role === "user" && !item.redacted
    && !!item.idempotencyKey && (item.channel?.kind ?? "web") === "web";
  /**
   * What stands in one chat, as the messages of a conversation. `thread`: the chat is a session of the partner, shown
   * as a thread of its page. Its first round stands on the page as any reply does (`root`); in the panel beside it
   * (`panel`) what the other partner asked is a message of that partner, so that the thread reads as the two of them.
   */
  const transcript = (current: ChatSummary, view: LedgerChatView, fold: LedgerFold, thread?: ThreadMode): MessageView[] => {
    const answers = new Map(view.answers.map((item) => [item.cardId, item]));
    const redactions = new Map(view.redactions.map((item) => [item.eventId, item]));
    const messages: MessageView[] = [];
    let rounds = 0;
    const shown = new Set(fold.items.map((item) => item.eventId));
    const finals = new Map(fold.items.flatMap((item) => item.kind === "message" && item.turnId && item.role === "assistant" ? [[item.turnId, item.text] as const] : []));
    // Text Router already streamed for a turn stays on screen while its run loads (no blank between the two).
    for (const item of view.inflight) if (!finals.has(item.turnId) && item.text) finals.set(item.turnId, item.text);
    const turnsByInput = new Map<string, LedgerTurn[]>();
    const placed = new Set<string>();
    for (const turn of fold.turns.values()) {
      const input = turn.inputEventIds.find((id) => shown.has(id));
      if (!input) continue;
      turnsByInput.set(input, [...(turnsByInput.get(input) ?? []), turn]);
      placed.add(turn.turnId);
    }
    const chatId = current.chatId;
    // The run surface answers through the card (one record for every surface); cancel and steer use the turn routes.
    const controlsFor = (turn: LedgerTurn): RunControls => ({
      answer: async (callId: string, request: Parameters<NonNullable<RunControls["answer"]>>[1], answer: Parameters<NonNullable<RunControls["answer"]>>[2]) => {
        const card = [...fold.cards.values()].find((item) => item.callId === callId && item.turnId === turn.turnId);
        if (!card) throw new ApiError("card_not_found", 404);
        const allows = "choice" in answer ? request.choices?.find((choice) => choice.id === answer.choice)?.allows
          : "action" in answer ? answer.action === "accept" : undefined;
        const response = await client.answerCard(chatId, card.cardId, cardAnswerBody(card, answerInteraction(request, answer), allows));
        if (response?.status === "stale") throw new ApiError("card_answer_stale", 409);
      },
      cancel: () => client.cancelTurn(chatId, turn.turnId),
      ...(current.kind === "dm" && !current.readOnly ? { stopInComposer: true } : {}),
    });
    const turnView = (turn: LedgerTurn, incoming?: RunIncoming[]): MessageView => {
      const name = agentName(turn.agentId), partner = agents.data?.find(({ agent }) => agent.id === turn.agentId);
      // A partner on the owner's computer starts the turn when that computer is paired and connected.
      const waiting = partner?.kind === "external" && partner.connection !== "online" ? t(`device.${partner.connection ?? "pairing"}`) : undefined;
      return {
        id: "turn:" + turn.turnId, role: "assistant", title: name,
        avatar: <PartnerAvatar seed={turn.agentId} fallbackName={name} size={28} animated={false} />,
        copyText: finals.get(turn.turnId) ?? "",
        body: <LedgerTurnSurface api={api} chatId={current.chatId} turn={turn} token={session.token}
          fallback={finals.get(turn.turnId) ?? ""} onInsertPrompt={insertPrompt} controls={controlsFor(turn)} partnerLink={partnerLink} waiting={waiting} incoming={incoming} />,
      };
    };
    for (const item of fold.items) {
      const turn = item.turnId ? fold.turns.get(item.turnId) : undefined;
      if (thread && item.kind === "message" && item.role === "user" && !item.steer && ++rounds === 2) {
        if (thread.root) break;
        // Below the round the thread began with, the line a thread's replies stand under.
        if (thread.panel) messages.push({ id: "thread-replies", role: "system",
          content: <span className="mau-chat-divider mau-thread-rule">{t("threads.replies", { count: String(thread.rounds - 1) })}</span> });
      }
      // Replies and Host cards of a turn are shown inside its run surface; Router's own cards have no Host call there.
      if (turn && item.role !== "user" && (item.kind === "message" || item.kind === "card" && item.card?.source !== "router")) {
        if (!placed.has(turn.turnId)) { placed.add(turn.turnId); messages.push(turnView(turn)); }
        continue;
      }
      // What partners sent each other is recorded as an input no person wrote, with what to show of it beside the text
      // written for the model. Where it started a reply, it is the first step of that reply: a row that names the
      // partner and opens what it wrote, so the conversation stays between the owner and this partner. Where no reply
      // followed, a message stands under the sender's figure as the sender wrote it and each result under the figure
      // of the partner that answered. An input recorded without that is shown as its whole text.
      if (item.kind === "message" && item.role === "user" && item.origin === "delegation" && !item.redacted) {
        const { partnerMessage: sent, partnerResults: results } = item.display ?? {};
        const answering = turnsByInput.get(item.eventId) ?? [], incoming = answering.length && !thread?.panel ? incomingRows(item.eventId, item.display, thread?.title) : undefined;
        if (incoming) { answering.forEach((turn, index) => messages.push(turnView(turn, index === 0 ? incoming : undefined))); continue; }
        if (results) results.forEach((result, index) => messages.push({
          id: `${item.eventId}:${index}`, role: "assistant", ...partnerAuthor(result.partner),
          ...(result.answer ? { copyText: result.answer, content: <ChatMarkdown markdown={result.answer} /> } : {}), ...resultStatus(result) }));
        else if (sent) messages.push({ id: item.eventId, role: "assistant", copyText: sent.text,
          content: thread?.panel ? <Clamped more={t("threads.more")} less={t("threads.less")}><ChatMarkdown markdown={sent.text} /></Clamped> : <ChatMarkdown markdown={sent.text} />,
          ...partnerAuthor(sent.from), subtitle: t(`partners.intent.${sent.intent}`) });
        else messages.push({ id: item.eventId, role: "assistant", copyText: item.text, content: item.text,
          ...(item.sender.type === "agent" ? partnerAuthor(item.sender) : { title: t("partners.results"), avatar: actorAvatar(item) }) });
        for (const attached of turnsByInput.get(item.eventId) ?? []) messages.push(turnView(attached));
        continue;
      }
      const system = item.kind === "notice" || item.kind === "window" || item.kind === "member" || item.kind === "action";
      const text = item.kind === "window" ? (zh ? "新对话" : "New chat")
        : item.kind === "member" ? room.memberText(item.eventId) ?? item.text
        : item.card?.source === "product" ? requestText(t, item.card).join("\n\n") : item.text;
      const details = describe(item), channel = badge(item), addressed = item.redacted ? "" : room.addressedLine(item.eventId);
      const withdrawal = redactions.get(item.eventId);
      // Window, notice and member lines are centred, like a time separator, with no sender.
      if (system) { messages.push({ id: item.eventId, role: "system",
        content: <span className="mau-chat-divider" data-kind={item.kind}>{text}</span> });
        for (const attached of turnsByInput.get(item.eventId) ?? []) messages.push(turnView(attached));
        continue; }
      // A partner's request for approval stands under that partner's figure, in the conversation it was asked in.
      const requester = item.card?.display?.partnerApproval?.partner;
      messages.push({
        id: item.eventId, role: item.role === "user" ? "user" : "assistant",
        ...(item.redacted ? {} : { copyText: text }),
        ...(requester ? partnerAuthor(requester) : { title: item.sender.name, avatar: actorAvatar(item) }),
        ...(channel || details ? { subtitle: <>{channel}{channel && details ? " " : null}{details}</> } : {}),
        content: item.kind === "card" && item.card ? <LedgerCardView client={client} api={api} chatId={current.chatId} card={item.card} answer={answers.get(item.card.cardId)} />
          : item.redacted ? <p className="mau-muted mau-redacted">{item.sender.type === "person" ? (zh ? "消息已撤回" : "Message withdrawn") : (zh ? "消息已删除" : "Message deleted")}</p>
          : text ? <ChatMarkdown markdown={text} /> : undefined,
        ...(canRedact(item) && !withdrawal ? { menuActions: [{ id: "redact", label: zh ? "撤回" : "Withdraw",
          onSelect: () => setWithdrawing({ chatId: current.chatId, eventId: item.eventId }) }] } : {}),
        // A state keeps the line visible; a stateless status is a hover-only timestamp.
        ...(addressed && !withdrawal ? { state: "addressed", status: <span className="mau-addressed">{addressed}</span> } : {}),
        ...(withdrawal ? {
          state: withdrawal.state === "sending" ? "pending" : "failed",
          status: withdrawal.state === "sending" ? (zh ? "撤回中…" : "Withdrawing…") : errorMessage(t, withdrawal.error ?? "request_failed"),
          ...(withdrawal.state !== "sending" ? { actions: <>
            {withdrawal.state === "failed" ? <Button onClick={() => void client.redact(current.chatId, item.eventId).catch(() => undefined)}>{t("common.retry")}</Button> : null}
            <Button onClick={() => client.dismissRedaction(current.chatId, item.eventId)}>{zh ? "放弃" : "Dismiss"}</Button>
          </> } : {}),
        } : {}),
        ...(item.attachments.length ? { attachments: attachmentsOf(item.attachments) } : {}),

      });
      for (const attached of turnsByInput.get(item.eventId) ?? []) messages.push(turnView(attached));
    }
    if (thread?.root) return messages;
    // Active turns whose input and replies are not loaded (older page) still show their run surface.
    for (const turn of fold.turns.values()) if (!placed.has(turn.turnId) && !terminalTurn.includes(turn.state)) messages.push(turnView(turn));
    // Streams of turns not yet in the loaded page (accumulated text; durable events replace it).
    for (const item of view.inflight) if (!fold.turns.has(item.turnId)) {
      const name = agentName(item.agentId);
      messages.push({ id: "inflight:" + item.turnId, role: "assistant", title: name, state: "streaming",
        avatar: <PartnerAvatar seed={item.agentId} fallbackName={name} size={28} animated={false} />, content: <ChatMarkdown markdown={item.text} /> });
    }
    for (const item of view.pending) messages.push({
      id: "pending:" + item.idempotencyKey, role: "user", title: session.owner, copyText: item.text,
      ...(item.text ? { content: <ChatMarkdown markdown={item.text} /> } : {}),
      ...(item.attachments.length ? { attachments: attachmentsOf(item.attachments) } : {}),
      state: item.state === "accepted" ? "sent" : item.state === "sending" ? "pending" : "failed",
      status: item.state === "sending" ? (zh ? "发送中…" : "Sending…") : item.state === "accepted" ? (zh ? "已发送" : "Sent")
        : item.retryAt !== undefined ? (zh ? "发送失败，正在重试…" : "Not sent, retrying…")
        : errorMessage(t, item.error ?? "request_failed"),
      ...(item.state === "failed" || item.state === "rejected" ? { actions: <>
        {item.state === "failed" ? <Button onClick={() => void client.retry(item.idempotencyKey).catch(() => undefined)}>{t("common.retry")}</Button> : null}
        <Button onClick={() => client.discard(item.idempotencyKey)}>{zh ? "放弃" : "Dismiss"}</Button>
      </> } : {}),
    });
    return messages;
  };
  const openThread = (thread: PartnerThread) => { if (threadAgent) { setProfile(undefined); setSideView({ kind: "thread", agentId: threadAgent, sessionId: thread.id, chatId: thread.chatId }); } };
  // Each thread of the partner on screen, once its chat is read: how many rounds it has, and how its last one stands.
  const threadViews = threadList.flatMap((thread) => {
    const chat = client.chats.get(thread.chatId) ?? { chatId: thread.chatId, kind: "observed" as const, title: thread.title, agentIds: [threadAgent!], readOnly: true,
      lastSeq: 0, generation: 0, readSeq: 0, unread: 0, lastEvent: null, activeTurns: 0, pendingCards: 0, updatedAt: thread.lastAt };
    const threadView = client.view(thread.chatId);
    if (!threadView.loaded || threadView.hasOlder && !stalled.has(thread.chatId)) return [];
    const threadFold = foldOnce(threadView);
    const inputs = threadFold.items.filter((item) => item.kind === "message" && item.role === "user" && !item.steer);
    if (!inputs.length) return [];
    const last = threadFold.items.filter((item) => item.kind === "message" && item.role === "assistant" && item.text).at(-1);
    return [{ thread, chat, view: threadView, fold: threadFold, rounds: inputs.length, at: inputs[0]!.at, last,
      running: [...threadFold.turns.values()].some((turn) => !terminalTurn.includes(turn.state)),
      open: sideView?.kind === "thread" && sideView.sessionId === thread.id, unread: chat.unread }];
  });
  // On the page, a thread is the round it began with. When more followed, a line under it names the work, says how
  // many rounds there are and how the last one stands, and opens the thread.
  const roots = threadViews.map((item) => {
    const views = transcript(item.chat, item.view, item.fold, { root: true, rounds: item.rounds, title: item.rounds > 1 ? undefined : item.thread.title })
      .map((message) => ({ ...message, id: `thread:${item.thread.id}:${message.id}` }));
    const entry = item.rounds > 1 ? (
      <button type="button" className="mau-thread-entry" data-thread={item.thread.id} data-open={item.open || undefined}
        aria-expanded={item.open} onClick={() => openThread(item.thread)}>
        <span className="mau-thread-entry-title">
          <strong>{item.thread.title}</strong>
          <span>{t("threads.rounds", { count: String(item.rounds) })}</span>
          {item.unread && !item.open ? <i className="mau-thread-dot" role="img" aria-label={t("threads.unread")} /> : null}
          <ProductIcon name="next" size={14} />
        </span>
        <span className="mau-thread-entry-last">
          <span>{item.running ? t("threads.working", { count: String(item.rounds) }) : oneLine(item.last?.text ?? "")}</span>
          {!item.running && item.last ? <time>{clock(item.last.at)}</time> : null}
        </span>
      </button>
    ) : null;
    const index = views.length - 1;
    if (entry && index >= 0) views[index] = views[index]!.body ? { ...views[index]!, body: <>{views[index]!.body}{entry}</> } : { ...views[index]!, actions: entry };
    return { at: item.at, views };
  });
  // The page: the conversation, and each thread where it began.
  const conversation = current && view && fold ? transcript(current, view, fold) : [];
  const times = new Map<string, string>();
  for (const item of fold?.items ?? []) { times.set(item.eventId, item.at); if (item.turnId && !times.has("turn:" + item.turnId)) times.set("turn:" + item.turnId, item.at); }
  for (const turn of fold?.turns.values() ?? []) { const at = turn.inputEventIds.map((id) => times.get(id)).find(Boolean); if (at) times.set("turn:" + turn.turnId, at); }
  let latest = "";
  const timed = conversation.map((message) => {
    const at = /^(pending|inflight):/.test(message.id) ? "\uffff" : times.get(message.id) ?? times.get(message.id.split(":")[0]!) ?? "";
    if (at > latest) latest = at;
    return { at: latest, message };
  });
  // The page shows the conversation and its threads from one moment on, and what is before it once the reader comes
  // to the top: the oldest message read so far while the conversation has earlier ones, and after that the threads
  // that are open. A thread that began within what is read of the conversation is opened without being asked for.
  const oldest = timed[0]?.at;
  const behind = !!view?.hasOlder && earlierThreads && oldest !== undefined && threadsFrom > oldest;
  useEffect(() => { if (behind) void moreThreads().catch(() => undefined); }, [behind, book?.earlier]);
  const since = view?.hasOlder ? oldest : threadsFrom;
  const messages = grouped([...timed.filter((item) => view?.hasOlder || item.at >= threadsFrom), ...roots.filter((root) => since !== undefined && root.at >= since)
    .flatMap((root) => root.views.map((message) => ({ at: root.at, message })))]
    .sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0).map((item) => item.message));
  // What the top of the page loads next: earlier messages of the conversation, then earlier threads. Not while threads are being read.
  const pageEarlier = !current || threadsLoading ? undefined : view?.hasOlder ? () => client.loadOlder(current.chatId).catch((failed: unknown) => { setUploadError(failed); throw failed; })
    : earlierThreads ? moreThreads : undefined;
  // The thread open beside the conversation: all of it, and a place to write in it.
  const opened = sideView?.kind === "thread" ? threadViews.find((item) => item.thread.id === sideView.sessionId) : undefined;
  const openedMessages = opened ? grouped(transcript(opened.chat, opened.view, opened.fold, { panel: true, rounds: opened.rounds })) : [];
  useEffect(() => {
    if (!opened || opened.view.lastSeq <= opened.view.readSeq || document.visibilityState !== "visible") return;
    void client.markRead(opened.chat.chatId, opened.view.lastSeq).catch(() => undefined);
  }, [client, opened?.chat.chatId, opened?.view.lastSeq, opened?.view.readSeq]);
  const replyInThread = useMutation({
    mutationFn: (input: { agentId: string; sessionId: string; chatId: string; text: string; key: string }) =>
      mauApi(session.token).replyInSession(input.agentId, input.sessionId, { text: input.text, key: input.key }),
    onSuccess: (_sent, input) => {
      if (replyKeys.current.get(input.chatId)?.key === input.key) replyKeys.current.delete(input.chatId);
      return queries.invalidateQueries({ queryKey: ["partner-sessions", session.owner] });
    },
    // What was written is not lost: it goes back into the box.
    onError: (failed, input) => {
      setDrafts((values) => values[input.chatId] ? values : { ...values, [input.chatId]: input.text });
      if (!(failed instanceof ApiError && failed.status === 401)) toast({ kind: "error", title: failureMessage(t, failed) });
      void threads.refetch();
    },
  });
  // A thread of one round stands whole on the page: reading the page reads it.
  const shownWhole = threadViews.filter((item) => item.rounds === 1 && item.view.lastSeq > item.view.readSeq).map((item) => `${item.chat.chatId} ${item.view.lastSeq}`).join("\n");
  useEffect(() => {
    if (!shownWhole || document.visibilityState !== "visible") return;
    for (const line of shownWhole.split("\n")) { const [chatId, seq] = line.split(" "); void client.markRead(chatId!, Number(seq)).catch(() => undefined); }
  }, [client, shownWhole]);
  // Threads with something new that are not open: one line above the box says which, and opens it.
  const unreadThreads = threadViews.filter((item) => item.rounds > 1 && item.unread > 0 && !item.open);
  const threadHint = unreadThreads.length ? (
    <div className="mau-thread-hint"><button type="button" onClick={() => openThread(unreadThreads.at(-1)!.thread)}>
      <i className="mau-thread-dot" aria-hidden="true" />
      {unreadThreads.length > 1 ? t("threads.newReplies", { count: String(unreadThreads.length) }) : t("threads.newReply", { title: unreadThreads[0]!.thread.title })}
    </button></div>
  ) : null;
  // The search of a conversation reaches into its threads: a match there opens the thread.
  const threadSearch = threadViews.flatMap((item) => item.fold.items.filter((bubble) => bubble.kind === "message" && !bubble.redacted && bubble.text)
    .map((bubble) => ({ id: `thread:${item.thread.id}:${bubble.role !== "user" && bubble.turnId ? "turn:" + bubble.turnId : bubble.eventId}`,
      sender: bubble.sender.name, text: bubble.display?.partnerMessage?.text ?? bubble.text })));
  const locate = (id: string) => {
    const found = /^thread:([^:]+):(.+)$/.exec(id), inPage = document.querySelector(`[data-room-message-id="${CSS.escape(id)}"]`);
    if (inPage || !found) return inPage?.scrollIntoView({ block: "center", behavior: "smooth" });
    const thread = threadViews.find((item) => item.thread.id === found[1])?.thread;
    if (!thread) return;
    openThread(thread);
    setTimeout(() => document.querySelector(`.mau-thread-view [data-room-message-id="${CSS.escape(found[2]!)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
  };

  const canSend = !!current && !current.readOnly && (current.kind === "dm" || current.kind === "group");
  const insertMention = (chatId: string, name: string) => setDrafts((values) => {
    const draft = values[chatId] ?? "";
    const base = draft.endsWith("@") ? draft.slice(0, -1) : draft;
    return { ...values, [chatId]: `${base}${base && !/\s$/.test(base) ? " " : ""}@${name} ` };
  });
  // Uploading files show their progress, failed ones their error (with a retry where it can help).
  const draftDetail = (item: ReturnType<typeof uploads.list>[number]) => item.state === "uploading"
    ? `${zh ? "上传中" : "Uploading"} ${item.size ? Math.min(99, Math.floor(item.loaded / item.size * 100)) : 0}%`
    : item.state === "failed" ? errorMessage(t, item.error ?? "request_failed") : formatBytes(item.size);
  // The composer type intersects ChatComposer's ReactNode slot; the room composer reads this list.
  const composerFiles = (chatId: string) => uploads.list(chatId).map((item) => ({ id: item.id, name: item.name, kind: item.kind,
    ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}), detail: draftDetail(item),
    onRemove: () => uploads.remove(chatId, item.id),
  })) as unknown as NonNullable<ConversationComposer["attachments"]>;
  const attachable = canSend;
  const failedDrafts = current ? uploads.list(current.chatId).filter((item) => item.state === "failed") : [];
  // While a DM reply runs, the send button stops it and text sent goes into it (steer, ADR 0005 16.2).
  const activeTurn = current?.kind === "dm" && fold
    ? [...fold.turns.values()].reverse().find((turn) => !terminalTurn.includes(turn.state)) : undefined;
  const runningTurn = canSend ? activeTurn : undefined;
  const clearDraft = (chatId: string) => setDrafts((values) => ({ ...values, [chatId]: "" }));
  // Slash commands in a DM: "/new" is Router's reset (the same as typing it in Feishu), "/clear" asks before purging.
  const commands = current?.kind === "dm" && !current.readOnly ? [
    { id: "new", name: "new", description: zh ? "开始新对话，之前的上下文不再带入" : "Start a new chat without the earlier context",
      onSelect: () => { clearDraft(current.chatId); reset.mutate({ chatId: current.chatId, cancelActive: false }); } },
    { id: "clear", name: "clear", description: zh ? "永久清空与它的聊天记录" : "Permanently clear the chat history",
      onSelect: () => { clearDraft(current.chatId); setPurging({ chatId: current.chatId, title: current.title }); } },
  ] : undefined;
  const onSend = () => {
    if (!current) return;
    const text = drafts[current.chatId] ?? "", chatId = current.chatId;
    // Wait for uploads; a send carries only uploaded files.
    if (uploads.busy(chatId)) return;
    const ready = uploads.ready(chatId);
    if (!text.trim() && !ready.length) return;
    // Text alone goes into the running reply. When the kernel cannot take it, or the reply has just ended, it is an
    // ordinary message instead (the next turn), with the usual sending state and retry.
    if (runningTurn && !ready.length) {
      clearDraft(chatId);
      const asMessage = () => void client.send(chatId, { text }).then(room.record, () => undefined);
      void client.steer(chatId, runningTurn.turnId, text.trim())
        .then(({ status }) => { if (status === "unsupported") asMessage(); }, asMessage);
      return;
    }
    // Router stores the message (one key per intent, reused on retry).
    const attachments = uploads.take(chatId);
    setDrafts((values) => ({ ...values, [chatId]: "" }));
    // Groups: the client resolves mentions (ADR 0005 17.1); the addressed state is shown under the message.
    void client.send(chatId, { text, attachments, ...(current.kind === "group" ? { mentions: room.mentions(text) } : {}) })
      .then(room.record, () => undefined);
  };

  const sections: ChatSection[] = [
    { id: "agents", title: zh ? "伙伴" : "Partners", entries: agentEntries,
      action: { label: t("agents.create"), onSelect: () => setCreating(true) },
      ...(dismissedEntries.length ? { archived: { label: t("partners.dismissedState"), entries: dismissedEntries,
        action: { label: t("partners.restoreShort"), pending: restore.isPending, onSelect: (entry: Entry) => restore.mutate(entry) } } } : {}) },
    { id: "groups", title: zh ? "群聊" : "Groups", entries: groupEntries,
      action: { label: zh ? "新建群聊" : "New group", onSelect: () => setGrouping(true) } },
    { id: "others", title: zh ? "其他渠道" : "Other channels", entries: otherEntries },
  ];
  const header = (
    <header className="room-header mau-chat-header">
      {compact ? <button type="button" className="mau-header-button" aria-label={zh ? "返回" : "Back"} title={zh ? "返回" : "Back"}
        onClick={() => { setProfile(undefined); setSelected(undefined); }}><ProductIcon name="back" /></button> : null}
      {currentEntry ? <button type="button" className="mau-chat-title" data-chat-key={currentEntry.key} title={currentEntry.title} disabled={!about} onClick={about}>
        {currentEntry.avatar(32)}
        <span><strong>{currentEntry.title}</strong>{currentEntry.status ? <small>{currentEntry.status}</small> : null}</span>
      </button> : <span className="mau-chat-title" />}
      {current ? <div className="room-header-actions">
        {handoffCard && handoffUrl && sideView?.kind !== "browser" ? <button type="button" className="mau-header-button" aria-label={zh ? "接管浏览器" : "Browser handoff"}
          title={zh ? "接管浏览器" : "Browser handoff"} onClick={() => { setProfile(undefined); setSideView({ kind: "browser", cardId: handoffCard.cardId }); }}><ProductIcon name="globe" /></button> : null}
        <RoomHeaderActions roomId={current.chatId} roomTitle={current.title}
          messages={[...conversation.flatMap((message) => message.copyText ? [{ id: message.id, sender: String(message.title ?? ""), text: message.copyText }] : []), ...threadSearch]}
          onLocateMessage={locate}
          {...(room.group ? {
            onRename: (title: string) => void room.rename(title, (summary) => client.updateSummary(summary)).catch(setUploadError),
            onOpenSettings: () => setMembersOpen(true),
          } : {})} />
      </div> : null}
    </header>
  );

  return (
    <>
      {!allEntries.length && !dismissedEntries.length ? (
        <CollectionEmptyState label={zh ? "对话" : "Conversations"} loading={!failure && (chats.isPending || agents.isPending)} illustration="messages"
          title={t("agents.empty")} description={t("agents.emptyDetail")}
          actions={[{ label: t("agents.create"), variant: "primary", onClick: () => setCreating(true) }]}
          notice={failure} />
      ) : (
        <div className="mau-stage" data-page={page} data-read-only={current && !canSend ? "" : undefined}
          {...(page === "chat" || page === "profile" ? { "data-app-page": "" } : {})}>
          <ChatRoster sections={sections} current={currentKey} onPick={pick}
            label={zh ? "全部对话" : "All conversations"} searchLabel={zh ? "搜索" : "Search"} emptyLabel={zh ? "没有找到" : "Nothing found"}
            {...(compact ? { lead: <div className="mau-roster-lead">
              <MauMark size={30} />
              <button type="button" className="mau-roster-account" aria-label={zh ? "设置" : "Settings"} title={zh ? "设置" : "Settings"} onClick={() => openSettings({ section: null })}>
                <PartnerAvatar seed={session.owner} fallbackName={session.owner} size={32} appearance="illustrated" />
              </button>
            </div> } : {})}
            onProfile={{ label: zh ? "伙伴资料" : "Partner profile", available: (entry) => entry.key.startsWith("agent:") && known.has(entry.key.slice(6)),
              open: (entry) => setProfile(entry.key.slice(6)) }}
            onBack={() => setProfile(undefined)}
            profile={profileSummary ? { label: zh ? "伙伴资料" : "Partner profile", backLabel: zh ? "全部对话" : "All conversations",
              content: <AgentDetail key={profileSummary.agent.id} session={session} summary={profileSummary}
                partners={agents.data ?? []} partner={views.get(profileSummary.agent.id)} onPartner={setProfile}
                document={sideView?.kind === "document" && sideView.agentId === profileSummary.agent.id ? sideView.name : undefined}
                onDocument={(name) => setSideView(name ? { kind: "document", agentId: profileSummary.agent.id, name } : undefined)} /> } : undefined} />
          <ListDetailLayout list={null} detailOpen onBack={() => undefined}
            {...(sideView?.kind === "browser" && handoffUrl ? { inspector: (
              <BrowserSideView url={handoffUrl} onClose={() => { dismissedHandoff.current = sideView.cardId; setSideView(undefined); }} />
            ) } : sideView?.kind === "file" ? { inspector: (
              <FileSideView key={sideView.attachment.attachmentId} api={api} attachment={sideView.attachment} onClose={() => setSideView(undefined)}
                onDownload={() => void saveAttachment(api, sideView.attachment).catch(setUploadError)} />
            ) } : sideView?.kind === "thread" && opened ? { inspector: (
              <PartnerFigureProvider value={partnerFigure}><ThreadSideView key={opened.thread.id} chatId={opened.chat.chatId} title={opened.thread.title}
                detail={t("threads.detail", { partner: names.get(sideView.agentId) ?? "", starter: names.get(opened.thread.startedBy.id) ?? opened.thread.startedBy.name, count: String(opened.rounds) })}
                messages={openedMessages} onClose={() => setSideView(undefined)}
                composer={{
                  value: drafts[opened.chat.chatId] ?? "",
                  onChange: (value) => setDrafts((values) => ({ ...values, [opened.chat.chatId]: value })),
                  placeholder: t("threads.reply"),
                  onSend: () => {
                    const text = (drafts[opened.chat.chatId] ?? "").trim(), chatId = opened.chat.chatId;
                    if (!text) return;
                    const kept = replyKeys.current.get(chatId), key = kept?.text === text ? kept.key : crypto.randomUUID();
                    replyKeys.current.set(chatId, { text, key });
                    clearDraft(chatId);
                    replyInThread.mutate({ agentId: sideView.agentId, sessionId: opened.thread.id, chatId, text, key });
                  },
                }} /></PartnerFigureProvider>
            ) } : sideView?.kind === "document" ? { inspector: (
              <DocumentSideView key={sideView.agentId + sideView.name} session={session} agentId={sideView.agentId} name={sideView.name} onClose={() => setSideView(undefined)} />
            ) } : {})}
            detail={current && view ? (
            // Files dropped anywhere on the conversation are attached (the composer handles its button and paste).
            <div className="mau-dropzone" data-dragging={dragging || undefined}
              {...(attachable ? {
                onDragOver: (event: DragEvent) => { if ([...event.dataTransfer.types].includes("Files")) { event.preventDefault(); setDragging(true); } },
                onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); },
                onDrop: (event: DragEvent) => {
                  const dropped = [...event.dataTransfer.files];
                  setDragging(false);
                  if (!dropped.length) return;
                  event.preventDefault(); setUploadError(undefined); uploads.add(current.chatId, dropped);
                },
              } : {})}>
            <PartnerFigureProvider value={partnerFigure}><Conversation conversationId={current.chatId}
              {...(pageEarlier ? { onReachStart: pageEarlier } : {})}
              header={header}
              notice={<>
                {failure}
                {dragging ? <p className="mau-muted" role="status">{zh ? "松开以添加附件" : "Drop to attach"}</p> : null}
                {uploads.busy(current.chatId) ? <p className="mau-muted" role="status">{zh ? "附件上传完成后才能发送。" : "Files are uploading; send when they are done."}</p> : null}
                {failedDrafts.length ? <p role="alert" className="mau-error">
                  {failedDrafts.map((item) => <span key={item.id} className="mau-attachment-error">
                    {item.name}：{errorMessage(t, item.error ?? "request_failed")}
                    {["too_many_attachments", "attachment_too_large"].includes(item.error ?? "") ? null
                      : <Button onClick={() => uploads.retry(current.chatId, item.id)}>{t("common.retry")}</Button>}
                    <Button onClick={() => uploads.remove(current.chatId, item.id)}>{zh ? "移除" : "Remove"}</Button>
                  </span>)}
                </p> : null}
                {client.connection.state === "reconnecting" ? <p className="mau-muted">{zh ? "正在重新连接…" : "Reconnecting…"}</p> : null}
              </>}
              {...(!view.loaded ? { empty: <LoadingSurface label={t("common.loading")} /> } : {})}
              messages={messages}
              {...(!canSend ? { trailing: <p className="mau-read-only-note">{zh ? "这个对话只能查看，不能在这里回复。" : "This conversation can be read here, not replied to."}</p> }
                : room.hint(drafts[current.chatId] ?? "") ? { trailing: <p role="status" className="mau-mention-hint">{room.hint(drafts[current.chatId] ?? "")}</p> }
                : threadHint ? { trailing: threadHint } : {})}
              composer={{
                value: drafts[current.chatId] ?? "",
                onChange: (value) => setDrafts((values) => ({ ...values, [current.chatId]: value })),
                disabled: !canSend,
                placeholder: !canSend ? (zh ? "此对话只读" : "This conversation is read-only")
                  : current.kind === "group" ? (zh ? "@伙伴 让他回答，@所有人 让大家都回答…" : "@a partner to ask them, @all to ask everyone…")
                  : (zh ? "发送消息…" : "Send a message…"),
                ...(attachable ? {
                  onFiles: (picked: File[]) => { setUploadError(undefined); uploads.add(current.chatId, picked); },
                  attachments: composerFiles(current.chatId),
                } : {}),
                ...(current.kind === "group" && canSend ? { mentions: [
                  ...room.candidates.map(({ id, name }) => ({ id, label: name,
                    avatar: <PartnerAvatar seed={id} fallbackName={name} size={20} animated={false} />,
                    onSelect: () => insertMention(current.chatId, name) })),
                  { id: "all", kind: "all" as const, label: zh ? "所有人" : "all", detail: zh ? "群里的伙伴都回答" : "Every partner in the group answers",
                    onSelect: () => insertMention(current.chatId, zh ? "所有人" : "all") },
                ] } : {}),
                ...(commands ? { commands } : {}),
                ...(runningTurn ? { running: true, onStop: () => void client.cancelTurn(current.chatId, runningTurn.turnId).catch(setUploadError) } : {}),
                onSend,
              }} /></PartnerFigureProvider>
            </div>
          ) : (
            <>
              {header}
              {failure}
              {start.isPending || chats.isPending ? <LoadingSurface label={t("common.loading")} />
                : <EmptyState illustration="messages" title={zh ? "选一个伙伴开始对话" : "Pick a partner to start"} />}
            </>
          )} />
        </div>
      )}
      {creating ? <CreateAgentDialog session={session} partners={activeAgents} onClose={() => setCreating(false)}
        onCreated={(id) => { setCreating(false); void agents.refetch().then(() => start.mutate(id)); }} /> : null}
      {withdrawing ? (
        <Dialog open onOpenChange={(value) => { if (!value) setWithdrawing(undefined); }}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>{zh ? "撤回这条消息？" : "Withdraw this message?"}</DialogTitle>
            <p className="mau-muted">{zh ? "撤回后，对话里只显示“消息已撤回”。" : "The chat will show “Message withdrawn” in its place."}</p>
            <div className="modal-actions">
              <Button onClick={() => setWithdrawing(undefined)}>{t("common.cancel")}</Button>
              <Button onClick={() => { const target = withdrawing; setWithdrawing(undefined);
                void client.redact(target.chatId, target.eventId).catch(() => undefined); }}>{zh ? "撤回" : "Withdraw"}</Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
      {busyReset ? (
        <Dialog open onOpenChange={(value) => { if (!value) { setBusyReset(undefined); reset.reset(); } }}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>{zh ? "当前任务进行中" : "A task is running"}</DialogTitle>
            <p className="mau-muted">{zh ? "开始新对话前，需要先停止正在执行的任务。新对话对所有渠道（网页、飞书、邮件等）生效。"
              : "Starting a new chat stops the running task first. The new chat applies to every channel."}</p>
            <div className="modal-actions">
              <Button onClick={() => { setBusyReset(undefined); reset.reset(); }}>{t("common.cancel")}</Button>
              <Button disabled={reset.isPending} onClick={() => reset.mutate({ chatId: busyReset, cancelActive: true })}>{zh ? "停止并开始新对话" : "Stop and start a new chat"}</Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
      <PurgeChatDialog chat={purging} onClose={() => setPurging(undefined)}
        purge={(chatId, cancelActive) => client.purge(chatId, chatId, cancelActive)} />
      <LedgerCreateGroupDialog token={session.token} open={grouping} agents={activeAgents}
        onOpenChange={setGrouping} onCreated={(summary) => { setGrouping(false); open(summary); }} />
      {room.group && membersOpen ? <LedgerGroupMembersDialog token={session.token} open chat={room.group}
        members={room.members} agents={activeAgents} onOpenChange={setMembersOpen}
        onChanged={(change) => room.applyChange(change, (summary) => client.updateSummary(summary))} /> : null}
    </>
  );
}
