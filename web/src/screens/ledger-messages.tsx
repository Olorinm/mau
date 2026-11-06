import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CollectionEmptyState,
  Conversation,
  ItemList,
  ListDetailLayout,
  LoadingSurface,
  PageHeader,
  RoomGroupAvatar,
  RoomHeaderActions,
  SearchField,
  SidebarHeader,
  type ConversationComposer,
  type MessageView,
} from "@olorinm/agent-frontend";
import { Button, Dialog, DialogContent, DialogTitle, EmployeeAvatar, EmptyState } from "@olorinm/agent-ui/app";
import { ChatMarkdown, ImagePreview } from "@olorinm/agent-ui";
import { blockBuildReload } from "../build-version";
import { mauApi } from "../api/client";
import { MauConversations } from "../api/conversations";
import { ApiError } from "../api/http";
import { answerInteraction } from "@olorinm/agent-host/interactions";
import {
  AttachmentDrafts, LedgerClient, attachmentKind, attachmentUrl, cardAnswerBody, foldEvents, formatBytes, ledgerApi,
  type AttachmentRef, type Card, type ChatSummary, type LedgerApi, type LedgerBubble, type LedgerFeature, type LedgerSocket, type LedgerTurn,
  type PendingAnswer,
} from "../api/ledger";
import { beforeAccessReloadEvent, reloadDrafts, saveReloadDrafts, type Session } from "../api/session";
import { errorMessage, useI18n } from "../i18n";
import { TaskSurface, type RunControls, type TaskLike } from "./run-surface";
import { LedgerCreateGroupDialog, LedgerGroupMembersDialog, useLedgerGroup } from "./ledger-group";

const terminalTurn = ["completed", "failed", "canceled", "unknown"];
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

/**
 * A ledger card outside a run surface (Router's own "重新执行 / 不用了" card, or a turn without a loaded run):
 * buttons answer by choice, free-text cards by text. A pending handoff card reads its live text (the private link
 * is never stored in history).
 */
function LedgerCardView({ client, api, chatId, card, answer, answerable }: {
  client: LedgerClient; api: LedgerApi; chatId: string; card: Card; answer: PendingAnswer | undefined; answerable: boolean;
}) {
  const { t, language } = useI18n(), zh = language === "zh-CN";
  const pending = card.status === "pending" && answerable;
  const live = useQuery({ queryKey: ["ledger-card", chatId, card.cardId, card.status], enabled: pending && card.source === "mau-handoff",
    queryFn: ({ signal }) => api.card(chatId, card.cardId, signal), retry: false, refetchOnWindowFocus: false });
  const [draft, setDraft] = useState("");
  const busy = answer?.state === "sending";
  const send = (body: { choiceId: string } | { text: string }) => void client.answerCard(chatId, card.cardId, body).catch(() => undefined);
  return <div className="mau-ledger-card" data-card-id={card.cardId} data-card-status={card.status}>
    <ChatMarkdown markdown={live.data?.text ?? card.text} />
    {pending && card.kind === "sensitive" ? <p className="mau-muted">{zh ? "请在执行内核的原生入口完成敏感输入，不要在聊天中发送密码或令牌。" : "Complete sensitive input in the runtime's native prompt; never send secrets in chat."}</p> : null}
    {pending && card.kind !== "sensitive" && card.choices.length ? <div className="mau-card-actions">
      {card.choices.map((choice) => <Button key={choice.choiceId} disabled={busy} onClick={() => send({ choiceId: choice.choiceId })}>{choice.label}</Button>)}
    </div> : null}
    {pending && card.kind !== "sensitive" && card.freeText ? <form className="mau-card-reply" onSubmit={(event) => {
      event.preventDefault(); if (draft.trim()) { send({ text: draft.trim() }); setDraft(""); } }}>
      <input aria-label={zh ? "回答" : "Answer"} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={zh ? "输入回答…" : "Type an answer…"} />
      <Button type="submit" disabled={busy || !draft.trim()}>{zh ? "回答" : "Answer"}</Button>
    </form> : null}
    {card.status !== "pending" ? <p className="mau-muted">{cardStatusNames[card.status]?.[zh ? 0 : 1] ?? card.status}</p> : null}
    {answer?.state === "stale" ? <p className="mau-muted">{zh ? "已在其他地方回答。" : "Already answered elsewhere."}</p> : null}
    {answer && (answer.state === "failed" || answer.state === "rejected") ? <p role="alert">{errorMessage(t, answer.error ?? "request_failed")}
      {answer.state === "failed" ? <Button onClick={() => send(answer.body as { choiceId: string } | { text: string })}>{t("common.retry")}</Button> : null}
      <Button onClick={() => client.dismissAnswer(chatId, card.cardId)}>{zh ? "放弃" : "Dismiss"}</Button></p> : null}
  </div>;
}

/** One ledger turn rendered with the existing run surface, keyed by turnId instead of Matrix event ids. */
function LedgerTurnSurface({ api, chatId, turn, token, fallback, onInsertPrompt, controls, steers }: {
  api: LedgerApi; chatId: string; turn: LedgerTurn; token: string; fallback: string; onInsertPrompt(prompt: string): void;
  controls?: RunControls | undefined; steers?: readonly string[] | undefined;
}) {
  const { language } = useI18n(), zh = language === "zh-CN";
  const terminal = terminalTurn.includes(turn.state);
  const detail = useQuery({
    queryKey: ["ledger-turn", token, chatId, turn.turnId, turn.state],
    queryFn: ({ signal }) => api.turn(chatId, turn.turnId, signal),
    retry: false,
    ...(terminal ? { staleTime: Infinity } : {}),
    refetchInterval: (query) => query.state.error || terminal ? false : 3000,
  });
  if (!detail.data) return detail.error || terminal
    ? fallback ? <ChatMarkdown markdown={fallback} /> : null
    : <p role="status">{zh ? "等待执行…" : "Queued…"}</p>;
  const task: TaskLike = { id: detail.data.turnId, status: detail.data.state, runs: detail.data.runs };
  return <>
    {steers?.length ? <ul className="mau-run-steers" aria-label={zh ? "补充说明" : "Added instructions"}>
      {steers.map((text, index) => <li key={index}><span className="mau-muted">{zh ? "补充：" : "Added: "}</span>{text}</li>)}
    </ul> : null}
    <TaskSurface task={task} token={token} agentId={detail.data.agentId} fallback={fallback} onInsertPrompt={onInsertPrompt} controls={controls} />
  </>;
}

async function saveAttachment(api: LedgerApi, ref: AttachmentRef) {
  const url = URL.createObjectURL(await api.downloadAttachment(ref));
  const link = document.createElement("a");
  link.href = url; link.download = ref.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * An inline image from its same-origin attachment URL. With an edge login (Cloudflare Access, no bearer token) the
 * browser sends the Access cookie itself, so the URL is the `<img src>`. A bearer session needs the header, so the
 * bytes are fetched and shown through an object URL. A click opens the shared image preview.
 */
function LedgerImage({ api, attachment, onError, direct }: { api: LedgerApi; attachment: AttachmentRef; onError(error: unknown): void; direct: boolean }) {
  const { language } = useI18n(), zh = language === "zh-CN";
  const [src, setSrc] = useState<string | undefined>(() => direct ? attachmentUrl(attachment) : undefined);
  const [failed, setFailed] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (direct) { setSrc(attachmentUrl(attachment)); return; }
    const abort = new AbortController();
    let made: string | undefined;
    api.downloadAttachment(attachment, abort.signal).then((blob) => { made = URL.createObjectURL(blob); setSrc(made); })
      .catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => { abort.abort(); if (made) URL.revokeObjectURL(made); setSrc(undefined); };
  }, [api, attachment.attachmentId, direct]);
  if (failed || !src) return <AttachmentChip api={api} attachment={attachment} onError={onError}
    detail={failed ? (zh ? "图片无法显示" : "Image unavailable") : (zh ? "加载中…" : "Loading…")} />;
  return <>
    <button type="button" className="mau-attachment-image" title={attachment.name} onClick={() => setPreviewing(true)}>
      <img src={src} alt={attachment.name} loading="lazy" {...(direct ? { onError: () => setFailed(true) } : {})} />
    </button>
    {previewing ? <ImagePreview image={{ src, alt: attachment.name }} onClose={() => setPreviewing(false)} /> : null}
  </>;
}
/** A file as a download chip (name and size). */
function AttachmentChip({ api, attachment, onError, detail }: { api: LedgerApi; attachment: AttachmentRef; onError(error: unknown): void; detail?: string }) {
  const { language } = useI18n(), zh = language === "zh-CN";
  const meta = detail ?? formatBytes(attachment.size);
  const label = zh ? `下载 ${attachment.name}` : `Download ${attachment.name}`;
  return <Button className="mau-attachment-chip" title={label} aria-label={meta ? `${label}，${meta}` : label}
    onClick={() => void saveAttachment(api, attachment).catch(onError)}>
    <span className="mau-attachment-name">{attachment.name}</span>{meta ? <span className="mau-attachment-meta">{meta}</span> : null}
  </Button>;
}
/** Message attachments: images inline, other files as download chips. */
function LedgerAttachments({ api, attachments, onError, direct }: { api: LedgerApi; attachments: readonly AttachmentRef[]; onError(error: unknown): void; direct: boolean }) {
  return <div className="mau-attachments">
    {attachments.map((ref) => attachmentKind(ref.contentType) === "image"
      ? <LedgerImage key={ref.attachmentId} api={api} attachment={ref} onError={onError} direct={direct} />
      : <AttachmentChip key={ref.attachmentId} api={api} attachment={ref} onError={onError} />)}
  </div>;
}

/**
 * Messages served by Router's owner ledger (agent-router ADR 0005). Each console feature follows the
 * server-advertised phase flags; without `send`, DMs still send through Matrix and return on the socket.
 */
export function LedgerMessagesScreen({ session, initialAgentId, onStartHandled, features, limits }: {
  session: Session; initialAgentId?: string | undefined; onStartHandled?(): void; features: ReadonlySet<LedgerFeature>;
  /** `GET /me` attachment limits (ADR 0005 16.5). */
  limits?: { bytes: number; perMessage: number } | undefined;
}) {
  const { t, language } = useI18n();
  const zh = language === "zh-CN";
  const agents = useQuery({ queryKey: ["agents", session.owner], queryFn: () => mauApi(session.token).agents() });
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
  const matrix = useMemo(() => new MauConversations(session, agents.data ?? []), [session.token, agents.data]);
  const names = new Map(agents.data?.map(({ agent }) => [agent.id, agent.name]) ?? []);

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [target, setTarget] = useState("");
  const [grouping, setGrouping] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  // Text kept across an Access re-login reload ("重新登录") is restored once.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => reloadDrafts());
  const latestDrafts = useRef(drafts);
  latestDrafts.current = drafts;
  useEffect(() => {
    reloadDrafts(sessionStorage, true);
    const save = () => saveReloadDrafts(latestDrafts.current);
    globalThis.addEventListener(beforeAccessReloadEvent, save);
    return () => globalThis.removeEventListener(beforeAccessReloadEvent, save);
  }, []);
  const [outgoing, setOutgoing] = useState<{ chatId: string; text: string; transaction: string }>();
  const [withdrawing, setWithdrawing] = useState<{ chatId: string; eventId: string }>();
  // Phase 4 control: "新对话" asks to stop a running turn first; purge needs the chat's name typed.
  const [busyReset, setBusyReset] = useState<string>();
  const [purging, setPurging] = useState<{ chatId: string; title: string; typed: string; busy: boolean }>();

  useEffect(() => {
    if (!selected) return;
    void client.openChat(selected).catch(() => undefined);
    return () => client.closeChat(selected);
  }, [client, selected]);
  const list = client.chatList();
  useEffect(() => {
    if (!selected && list.length && matchMedia("(min-width: 901px)").matches) setSelected(list[0]!.chatId);
  }, [list.length, selected]);

  const current: ChatSummary | undefined = selected ? client.chats.get(selected) : undefined;
  const view = selected ? client.view(selected) : undefined;
  const fold = useMemo(() => view ? foldEvents(view.events) : undefined, [view?.events, view?.lastSeq]);
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
    onSuccess: (summary) => { onStartHandled?.(); setStarting(false); open(summary); },
  });
  const requested = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (initialAgentId && agents.data?.some(({ agent }) => agent.id === initialAgentId) && requested.current !== initialAgentId) {
      requested.current = initialAgentId;
      start.mutate(initialAgentId);
    }
    if (!initialAgentId) requested.current = undefined;
  }, [initialAgentId, agents.data]);

  // Phase 2: Router serves history, sending still goes through the Matrix DM room (same transaction id on retry).
  const matrixSend = useMutation({
    mutationFn: async (message: { chatId: string; text: string; transaction: string }) => {
      const agentId = client.chats.get(message.chatId)?.agentIds[0];
      if (!agentId) throw new ApiError("conversation_not_found", 404);
      await matrix.send(await matrix.start(agentId), message.text, message.transaction);
    },
    onSuccess: (_, message) => {
      setOutgoing(undefined);
      setDrafts((values) => ({ ...values, [message.chatId]: values[message.chatId] === message.text ? "" : values[message.chatId] ?? "" }));
    },
  });
  const pendingSends = view?.pending ?? [];
  useEffect(() => blockBuildReload(!!outgoing || pendingSends.length > 0 || Object.values(drafts).some((value) => !!value.trim())), [outgoing, pendingSends.length, drafts]);

  const [uploadError, setUploadError] = useState<unknown>();

  const reset = useMutation({
    mutationFn: (input: { chatId: string; cancelActive: boolean }) => client.reset(input.chatId, input.cancelActive),
    onSuccess: () => setBusyReset(undefined),
    onError: (failed, input) => { if (failed instanceof ApiError && failed.code === "session_busy") setBusyReset(input.chatId); },
  });
  const purge = useMutation({
    mutationFn: (input: { chatId: string; cancelActive: boolean }) => client.purge(input.chatId, input.chatId, input.cancelActive),
    onSuccess: () => setPurging(undefined),
    onError: (failed) => { if (failed instanceof ApiError && failed.code === "session_busy") setPurging((value) => value ? { ...value, busy: true } : value); },
  });
  const quiet = (failed: unknown) => failed instanceof ApiError && failed.code === "session_busy" ? null : failed;
  const connectionError = client.connection.state === "closed" && client.connection.error;
  const error = agents.error ?? chats.error ?? start.error ?? matrixSend.error ?? uploadError ?? quiet(reset.error)
    ?? (connectionError ? new ApiError(connectionError, 401) : null) ?? (view?.error ? new ApiError(view.error, 0) : null);
  const failure = error ? (
    <p role="alert" className="mau-error">
      {errorMessage(t, error instanceof ApiError ? error.code : "request_failed")}
      {chats.error || view?.error ? <Button onClick={() => { void chats.refetch(); if (selected) void client.openChat(selected).catch(() => undefined); }}>{zh ? "重新连接" : "Reconnect"}</Button> : null}
    </p>
  ) : null;

  const avatar = (chat: ChatSummary, size: number) => chat.kind === "group" ? (
    <RoomGroupAvatar title={chat.title} className="mau-room-avatar"
      members={chat.agentIds.map((id) => ({ id, name: names.get(id) ?? id, avatarSeed: id }))} />
  ) : <EmployeeAvatar seed={chat.agentIds[0] ?? chat.chatId} fallbackName={chat.title} size={size} />;
  const visible = list.filter((chat) => chat.title.toLowerCase().includes(search.toLowerCase()));

  const insertPrompt = (value: string) => { if (selected) setDrafts((values) => ({ ...values, [selected]: value })); };
  const actorAvatar = (bubble: LedgerBubble) => <EmployeeAvatar seed={bubble.sender.id} fallbackName={bubble.sender.name} size={28} />;
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
  const attachmentsOf = (refs: readonly AttachmentRef[]) => refs.length ? <LedgerAttachments api={api} attachments={refs} onError={setUploadError} direct={!session.token} /> : undefined;

  const sendable = features.has("send");
  const cardsOn = sendable && features.has("cards"), controlOn = sendable && features.has("reset");
  const answers = new Map(view?.answers.map((item) => [item.cardId, item]) ?? []);
  // Only the owner's own web messages can be withdrawn (no edit); the key is present only on those (§8.2).
  const canRedact = (item: LedgerBubble) => sendable && item.kind === "message" && item.role === "user" && !item.redacted
    && !!item.idempotencyKey && (item.channel?.kind ?? "web") === "web";
  const redactions = new Map(view?.redactions.map((item) => [item.eventId, item]) ?? []);
  const messages: MessageView[] = [];
  if (current && view && fold) {
    const shown = new Set(fold.items.map((item) => item.eventId));
    const finals = new Map(fold.items.flatMap((item) => item.kind === "message" && item.turnId && item.role === "assistant" ? [[item.turnId, item.text] as const] : []));
    const turnsByInput = new Map<string, LedgerTurn[]>();
    const placed = new Set<string>();
    for (const turn of fold.turns.values()) {
      const input = turn.inputEventIds.find((id) => shown.has(id));
      if (!input) continue;
      turnsByInput.set(input, [...(turnsByInput.get(input) ?? []), turn]);
      placed.add(turn.turnId);
    }
    // Steered text belongs to its turn's run surface (ADR 0005 16.2), not to the message list.
    const steers = new Map<string, string[]>();
    for (const item of fold.items) if (item.steer && item.turnId && !item.redacted) steers.set(item.turnId, [...(steers.get(item.turnId) ?? []), item.text]);
    const chatId = current.chatId;
    // The run surface answers through the card (one record for every surface); cancel and steer use the turn routes.
    const controlsFor = (turn: LedgerTurn): RunControls | undefined => !cardsOn && !controlOn ? undefined : {
      ...(cardsOn ? { answer: async (callId: string, request: Parameters<NonNullable<RunControls["answer"]>>[1], answer: Parameters<NonNullable<RunControls["answer"]>>[2]) => {
        const card = [...fold.cards.values()].find((item) => item.callId === callId && item.turnId === turn.turnId);
        if (!card) throw new ApiError("card_not_found", 404);
        const allows = "choice" in answer ? request.choices?.find((choice) => choice.id === answer.choice)?.allows
          : "action" in answer ? answer.action === "accept" : undefined;
        const response = await client.answerCard(chatId, card.cardId, cardAnswerBody(card, answerInteraction(request, answer), allows));
        if (response?.status === "stale") throw new ApiError("card_answer_stale", 409);
      } } : {}),
      ...(controlOn ? { cancel: () => client.cancelTurn(chatId, turn.turnId),
        steer: async (text: string) => (await client.steer(chatId, turn.turnId, text)).status } : {}),
    };
    const turnView = (turn: LedgerTurn): MessageView => {
      const name = agentName(turn.agentId);
      return {
        id: "turn:" + turn.turnId, role: "assistant", title: name,
        avatar: <EmployeeAvatar seed={turn.agentId} fallbackName={name} size={28} />,
        copyText: finals.get(turn.turnId) ?? "",
        body: <LedgerTurnSurface api={api} chatId={current.chatId} turn={turn} token={session.token}
          fallback={finals.get(turn.turnId) ?? ""} onInsertPrompt={insertPrompt} controls={controlsFor(turn)} steers={steers.get(turn.turnId)} />,
      };
    };
    for (const item of fold.items) {
      const turn = item.turnId ? fold.turns.get(item.turnId) : undefined;
      if (item.steer && turn) continue;
      // Replies and Host cards of a turn are shown inside its run surface; Router's own cards have no Host call there.
      if (turn && item.role !== "user" && (item.kind === "message" || item.kind === "card" && item.card?.source !== "router")) {
        if (!placed.has(turn.turnId)) { placed.add(turn.turnId); messages.push(turnView(turn)); }
        continue;
      }
      const system = item.kind === "notice" || item.kind === "window" || item.kind === "member" || item.kind === "action";
      const text = item.kind === "window" ? (zh ? "—— 新的会话窗口 ——" : "—— New session window ——")
        : item.kind === "member" ? room.memberText(item.eventId) ?? item.text : item.text;
      const details = describe(item), channel = badge(item), addressed = item.redacted ? "" : room.addressedLine(item.eventId);
      const withdrawal = redactions.get(item.eventId);
      messages.push({
        id: item.eventId, role: item.role === "user" ? "user" : "assistant",
        ...(item.redacted ? {} : { copyText: text }),
        title: system ? "Mau" : item.sender.name,
        ...(system ? {} : { avatar: actorAvatar(item) }),
        ...(channel || details ? { subtitle: <>{channel}{channel && details ? " " : null}{details}</> } : {}),
        content: system ? <p className="mau-muted">{text}</p>
          : item.kind === "card" && item.card ? <LedgerCardView client={client} api={api} chatId={current.chatId} card={item.card} answer={answers.get(item.card.cardId)} answerable={cardsOn} />
          : item.redacted ? <p className="mau-muted mau-redacted">{item.sender.type === "person" ? (zh ? "消息已撤回" : "Message withdrawn") : (zh ? "消息已删除" : "Message deleted")}</p>
          : <ChatMarkdown markdown={text} />,
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
    // Active turns whose input and replies are not loaded (older page) still show their run surface.
    for (const turn of fold.turns.values()) if (!placed.has(turn.turnId) && !terminalTurn.includes(turn.state)) messages.push(turnView(turn));
    // Streams of turns not yet in the loaded page (accumulated text; durable events replace it).
    for (const item of view.inflight) if (!fold.turns.has(item.turnId)) {
      const name = agentName(item.agentId);
      messages.push({ id: "inflight:" + item.turnId, role: "assistant", title: name, state: "streaming",
        avatar: <EmployeeAvatar seed={item.agentId} fallbackName={name} size={28} />, content: <ChatMarkdown markdown={item.text} /> });
    }
    for (const item of view.pending) messages.push({
      id: "pending:" + item.idempotencyKey, role: "user", title: session.owner, copyText: item.text,
      content: <ChatMarkdown markdown={item.text} />,
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
  }

  const groupWritable = features.has("groups") && features.has("send");
  const canSend = !!current && !current.readOnly && (current.kind === "dm" || (current.kind === "group" && groupWritable));
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
  const attachable = features.has("attachments") && sendable && canSend;
  const failedDrafts = current ? uploads.list(current.chatId).filter((item) => item.state === "failed") : [];
  const onSend = () => {
    if (!current) return;
    const text = drafts[current.chatId] ?? "", chatId = current.chatId;
    // Wait for uploads; a send carries only uploaded files.
    if (uploads.busy(chatId)) return;
    const ready = uploads.ready(chatId);
    if (!text.trim() && !ready.length) return;
    // Phase 3: Router stores the message (one key per intent, reused on retry); no Matrix room is touched.
    if (sendable) {
      const attachments = uploads.take(chatId);
      setDrafts((values) => ({ ...values, [chatId]: "" }));
      // Groups: the client resolves mentions (ADR 0005 17.1); the addressed state is shown under the message.
      void client.send(chatId, { text, attachments, ...(current.kind === "group" ? { mentions: room.mentions(text) } : {}) })
        .then(room.record, () => undefined);
      return;
    }
    const message = { chatId: current.chatId, text, transaction: crypto.randomUUID() };
    setOutgoing(message);
    matrixSend.mutate(message);
  };

  const sidebar = (
    <>
      <SidebarHeader title={zh ? "对话" : "Conversations"} actions={[
        { id: "conversation", label: zh ? "发起单聊" : "New chat", onSelect: () => setStarting(true) },
        ...(groupWritable ? [{ id: "group", label: zh ? "新建群聊" : "New group", onSelect: () => setGrouping(true) }] : []),
      ]} />
      <SearchField value={search} onChange={setSearch} placeholder={zh ? "搜索对话" : "Search conversations"} />
      {failure}
      {!failure && chats.isPending ? <LoadingSurface label={t("common.loading")} /> : null}
      <ItemList label={zh ? "对话" : "Conversations"} {...(selected ? { selectedId: selected } : {})} onSelect={setSelected}
        items={visible.map((chat) => ({
          id: chat.chatId, title: chat.title, description: chat.lastEvent?.preview ?? "", leading: avatar(chat, 24),
          ...(chat.unread ? { trailing: <span className="mau-badge">{chat.unread}</span> } : {}),
        }))} />
    </>
  );

  return (
    <>
      {!list.length ? (
        <CollectionEmptyState label={zh ? "消息" : "Messages"} loading={!failure && chats.isPending} illustration="messages"
          title={zh ? "还没有员工会话" : "No conversations yet"}
          description={zh ? "创建员工后，它会出现在通讯录；打开私聊或群聊后，这里显示对话。" : "Agents appear in Contacts. Open a conversation to see messages here."}
          actions={[{ label: zh ? "发起单聊" : "Start a chat", variant: "primary", onClick: () => setStarting(true) },
            ...(groupWritable ? [{ label: zh ? "新建群聊" : "New group", onClick: () => setGrouping(true) }] : [])]}
          notice={failure} />
      ) : (
        <ListDetailLayout list={sidebar} detailOpen={!!current} onBack={() => setSelected(undefined)} backLabel={zh ? "消息" : "Messages"}
          empty={<EmptyState illustration="messages" title={zh ? "选择员工开始对话" : "Select an Agent to begin"} />}
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
            <Conversation conversationId={current.chatId}
              header={<PageHeader avatar={avatar(current, 30)} title={current.title}
                description={current.kind === "group" ? `${current.agentIds.length + 1} ${zh ? "位成员" : "participants"}` : undefined}
                actions={<>
                  {controlOn && current.kind === "dm" && !current.readOnly ? <>
                    <Button disabled={reset.isPending} onClick={() => reset.mutate({ chatId: current.chatId, cancelActive: false })}>{zh ? "新对话" : "New chat"}</Button>
                    <Button onClick={() => { purge.reset(); setPurging({ chatId: current.chatId, title: current.title, typed: "", busy: false }); }}>{zh ? "清空聊天记录" : "Clear history"}</Button>
                  </> : null}
                  <RoomHeaderActions roomId={current.chatId} roomTitle={current.title}
                  messages={messages.flatMap((message) => message.copyText ? [{ id: message.id, sender: String(message.title ?? ""), text: message.copyText }] : [])}
                  onLocateMessage={(id) => document.querySelector(`[data-room-message-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" })}
                  {...(room.group && groupWritable ? {
                    onRename: (title: string) => void room.rename(title, (summary) => client.updateSummary(summary)).catch(setUploadError),
                    onOpenSettings: () => setMembersOpen(true),
                  } : {})} />
                </>} />}
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
                {view.hasOlder ? <Button onClick={() => void client.loadOlder(current.chatId).catch(setUploadError)}>{zh ? "加载更早的消息" : "Load earlier messages"}</Button> : null}
                {matrixSend.isError && outgoing?.chatId === current.chatId ? <>
                  <Button onClick={() => matrixSend.mutate(outgoing)}>{t("common.retry")}</Button>
                  <Button onClick={() => { setOutgoing(undefined); matrixSend.reset(); }}>{zh ? "放弃重试" : "Dismiss retry"}</Button>
                </> : null}
              </>}
              {...(!view.loaded ? { empty: <LoadingSurface label={t("common.loading")} /> } : {})}
              messages={messages}
              {...(canSend && room.hint(drafts[current.chatId] ?? "") ? { trailing: <p role="status" className="mau-mention-hint">{room.hint(drafts[current.chatId] ?? "")}</p> } : {})}
              composer={{
                value: drafts[current.chatId] ?? "",
                onChange: (value) => setDrafts((values) => ({ ...values, [current.chatId]: value })),
                disabled: !canSend || matrixSend.isPending || !!outgoing,
                placeholder: !canSend ? (zh ? "此对话只读" : "This conversation is read-only")
                  : current.kind === "group" ? (zh ? "@员工 让他回答，@所有人 让大家都回答…" : "@an employee to ask them, @all to ask everyone…")
                  : (zh ? "发送消息…" : "Send a message…"),
                ...(attachable ? {
                  onFiles: (picked: File[]) => { setUploadError(undefined); uploads.add(current.chatId, picked); },
                  attachments: composerFiles(current.chatId),
                } : {}),
                ...(current.kind === "group" && canSend ? { mentions: [
                  ...room.candidates.map(({ id, name }) => ({ id, label: name,
                    avatar: <EmployeeAvatar seed={id} fallbackName={name} size={20} />,
                    onSelect: () => insertMention(current.chatId, name) })),
                  { id: "all", kind: "all" as const, label: zh ? "所有人" : "all", detail: zh ? "群里的员工都回答" : "Every employee in the group answers",
                    onSelect: () => insertMention(current.chatId, zh ? "所有人" : "all") },
                ] } : {}),
                onSend,
              }} />
            </div>
          ) : null} />
      )}
      {starting ? (
        <Dialog open onOpenChange={setStarting}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>{zh ? "发起单聊" : "New chat"}</DialogTitle>
            <label className="mau-field">
              <span>{zh ? "选择员工" : "Select an Agent"}</span>
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">{zh ? "选择员工" : "Select an Agent"}</option>
                {agents.data?.map(({ agent }) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </label>
            {failure}
            <div className="modal-actions">
              <Button disabled={!target || start.isPending} onClick={() => start.mutate(target)}>{zh ? "打开对话" : "Open conversation"}</Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
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
      {purging ? (
        <Dialog open onOpenChange={(value) => { if (!value) setPurging(undefined); }}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>{zh ? "清空聊天记录？" : "Clear chat history?"}</DialogTitle>
            <p>{zh ? "聊天记录将被永久删除；Agent 已经写入的记忆不会被删除。" : "The chat history is deleted permanently; memories the Agent already wrote are kept."}</p>
            <p className="mau-muted">{zh ? "这会删除你在所有渠道（网页、飞书、邮件、Matrix）与它的对话记录，并开始新对话。无法撤销。"
              : "This deletes your messages with it from every channel (web, Feishu, mail, Matrix) and starts a new chat. It cannot be undone."}</p>
            <label className="mau-field">
              <span>{zh ? `输入“${purging.title}”确认` : `Type “${purging.title}” to confirm`}</span>
              <input value={purging.typed} onChange={(event) => setPurging({ ...purging, typed: event.target.value })} autoComplete="off" />
            </label>
            {purge.error && !(purge.error instanceof ApiError && purge.error.code === "session_busy")
              ? <p role="alert">{errorMessage(t, purge.error instanceof ApiError ? purge.error.code : "request_failed")}</p> : null}
            {purging.busy ? <p className="mau-muted">{zh ? "当前任务进行中，清空前需要先停止它。" : "A task is running; it must stop first."}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setPurging(undefined)}>{t("common.cancel")}</Button>
              <Button disabled={purging.typed.trim() !== purging.title || purge.isPending}
                onClick={() => purge.mutate({ chatId: purging.chatId, cancelActive: purging.busy })}>
                {purging.busy ? (zh ? "停止任务并清空" : "Stop and clear") : (zh ? "永久清空" : "Clear permanently")}</Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
      {groupWritable ? <LedgerCreateGroupDialog token={session.token} open={grouping} agents={agents.data ?? []}
        onOpenChange={setGrouping} onCreated={(summary) => { setGrouping(false); open(summary); }} /> : null}
      {groupWritable && room.group && membersOpen ? <LedgerGroupMembersDialog token={session.token} open chat={room.group}
        members={room.members} agents={agents.data ?? []} onOpenChange={setMembersOpen}
        onChanged={(change) => room.applyChange(change, (summary) => client.updateSummary(summary))} /> : null}
    </>
  );
}
