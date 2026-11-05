import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CollectionEmptyState,
  Conversation,
  CreateGroupDialog,
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
import { ChatMarkdown } from "@olorinm/agent-ui";
import { blockBuildReload } from "../build-version";
import { mauApi } from "../api/client";
import { MauConversations } from "../api/conversations";
import { ApiError } from "../api/http";
import {
  LedgerClient, foldEvents, ledgerApi,
  type AttachmentRef, type ChatSummary, type LedgerApi, type LedgerBubble, type LedgerFeature, type LedgerSocket, type LedgerTurn,
} from "../api/ledger";
import type { Session } from "../api/session";
import { errorMessage, useI18n } from "../i18n";
import { TaskSurface, type TaskLike } from "./run-surface";

const terminalTurn = ["completed", "failed", "canceled", "unknown"];
const channelNames: Record<string, [string, string]> = {
  matrix: ["Matrix", "Matrix"], feishu: ["飞书", "Feishu"], "grove-mail": ["邮件", "Mail"], agentmail: ["邮件", "Mail"],
  telegram: ["Telegram", "Telegram"], weixin: ["微信", "WeChat"], schedule: ["定时", "Schedule"],
};
const deliveryNames: Record<string, [string, string]> = {
  queued: ["排队中", "queued"], sending: ["发送中", "sending"], sent: ["已送达", "sent"], suppressed: ["未发送", "not sent"],
  rejected: ["发送失败", "failed"], unknown: ["送达未知", "unknown"], replied: ["已回复", "replied"],
};

/** One ledger turn rendered with the existing run surface, keyed by turnId instead of Matrix event ids. */
function LedgerTurnSurface({ api, chatId, turn, token, fallback, onInsertPrompt }: {
  api: LedgerApi; chatId: string; turn: LedgerTurn; token: string; fallback: string; onInsertPrompt(prompt: string): void;
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
  return <TaskSurface task={task} token={token} agentId={detail.data.agentId} fallback={fallback} onInsertPrompt={onInsertPrompt} />;
}

async function saveAttachment(api: LedgerApi, ref: AttachmentRef) {
  const url = URL.createObjectURL(await api.downloadAttachment(ref.attachmentId));
  const link = document.createElement("a");
  link.href = url; link.download = ref.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Messages served by Router's owner ledger (agent-router ADR 0005). Each console feature follows the
 * server-advertised phase flags; without `send`, DMs still send through Matrix and return on the socket.
 */
export function LedgerMessagesScreen({ session, initialAgentId, onStartHandled, features }: {
  session: Session; initialAgentId?: string | undefined; onStartHandled?(): void; features: ReadonlySet<LedgerFeature>;
}) {
  const { t, language } = useI18n();
  const zh = language === "zh-CN";
  const agents = useQuery({ queryKey: ["agents", session.owner], queryFn: () => mauApi(session.token).agents() });
  const api = useMemo(() => ledgerApi(session.token), [session.token]);
  const client = useMemo(() => new LedgerClient(api, { socket: (url) => new WebSocket(url) as unknown as LedgerSocket }), [api]);
  useSyncExternalStore(client.subscribe, client.getVersion);
  useEffect(() => { client.connect(); return () => client.disconnect(); }, [client]);
  const chats = useQuery({ queryKey: ["ledger-chats", session.token], queryFn: ({ signal }) => client.loadChats(signal), retry: false });
  const matrix = useMemo(() => new MauConversations(session, agents.data ?? []), [session.token, agents.data]);
  const names = new Map(agents.data?.map(({ agent }) => [agent.id, agent.name]) ?? []);

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [target, setTarget] = useState("");
  const [grouping, setGrouping] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [groupMembers, setGroupMembers] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, AttachmentRef[]>>({});
  const [uploading, setUploading] = useState(false);
  const [outgoing, setOutgoing] = useState<{ chatId: string; text: string; transaction: string }>();

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
  const createGroup = useMutation({
    mutationFn: () => api.createGroup(groupTitle.trim(), groupMembers),
    onSuccess: (summary) => { setGrouping(false); setGroupTitle(""); setGroupMembers([]); open(summary); },
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

  const upload = async (chatId: string, picked: File[]) => {
    setUploading(true);
    try {
      for (const file of picked.slice(0, 10 - (files[chatId]?.length ?? 0))) {
        const ref = await api.uploadAttachment(file, file.name);
        setFiles((values) => ({ ...values, [chatId]: [...(values[chatId] ?? []), ref] }));
      }
    } finally { setUploading(false); }
  };
  const [uploadError, setUploadError] = useState<unknown>();

  const connectionError = client.connection.state === "closed" && client.connection.error;
  const error = agents.error ?? chats.error ?? start.error ?? createGroup.error ?? matrixSend.error ?? uploadError
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
  const describe = (bubble: LedgerBubble) => {
    const parts: string[] = [];
    if (bubble.channel && bubble.channel.kind !== "web" && bubble.channel.kind !== "room")
      parts.push(bubble.channel.label ?? channelNames[bubble.channel.kind]?.[zh ? 0 : 1] ?? bubble.channel.kind);
    if (bubble.edited) parts.push(zh ? "已编辑" : "edited");
    if (bubble.possibleDuplicate) parts.push(zh ? "可能重复执行" : "may be a duplicate run");
    for (const delivery of bubble.deliveries)
      parts.push(`${channelNames[delivery.channel.kind]?.[zh ? 0 : 1] ?? delivery.channel.kind} · ${deliveryNames[delivery.status]?.[zh ? 0 : 1] ?? delivery.status}`);
    for (const reaction of bubble.reactions) parts.push(`${reaction.key} ${reaction.senders.length}`);
    return parts.join(" · ");
  };
  const attachmentsOf = (refs: readonly AttachmentRef[]) => refs.length ? (
    <div className="mau-attachments">
      {refs.map((ref) => <Button key={ref.attachmentId} onClick={() => void saveAttachment(api, ref).catch(setUploadError)}>{ref.name}</Button>)}
    </div>
  ) : undefined;

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
    const turnView = (turn: LedgerTurn): MessageView => {
      const name = names.get(turn.agentId) ?? current.title;
      return {
        id: "turn:" + turn.turnId, role: "assistant", title: name,
        avatar: <EmployeeAvatar seed={turn.agentId} fallbackName={name} size={28} />,
        copyText: finals.get(turn.turnId) ?? "",
        body: <LedgerTurnSurface api={api} chatId={current.chatId} turn={turn} token={session.token}
          fallback={finals.get(turn.turnId) ?? ""} onInsertPrompt={insertPrompt} />,
      };
    };
    for (const item of fold.items) {
      const turn = item.turnId ? fold.turns.get(item.turnId) : undefined;
      // Replies and cards of a turn are shown inside its run surface.
      if (turn && item.role !== "user" && (item.kind === "message" || item.kind === "card")) {
        if (!placed.has(turn.turnId)) { placed.add(turn.turnId); messages.push(turnView(turn)); }
        continue;
      }
      const system = item.kind === "notice" || item.kind === "window" || item.kind === "member" || item.kind === "action";
      const text = item.kind === "window" ? (zh ? "—— 新的会话窗口 ——" : "—— New session window ——") : item.text;
      const subtitle = describe(item);
      messages.push({
        id: item.eventId, role: item.role === "user" ? "user" : "assistant", copyText: text,
        title: system ? "Mau" : item.sender.name,
        ...(system ? {} : { avatar: actorAvatar(item) }),
        ...(subtitle ? { subtitle } : {}),
        content: system ? <p className="mau-muted">{text}</p> : <ChatMarkdown markdown={text} />,
        ...(item.attachments.length ? { attachments: attachmentsOf(item.attachments) } : {}),
        ...(item.kind === "card" && item.card && features.has("cards") && item.card.status === "pending" && item.card.kind !== "sensitive" ? {
          actions: <>{item.card.choices.map((choice) => <Button key={choice.choiceId}
            onClick={() => void api.answerCard(current.chatId, item.card!.cardId, { idempotencyKey: crypto.randomUUID(), choiceId: choice.choiceId }).catch(setUploadError)}>
            {choice.label}</Button>)}</>,
        } : {}),
      });
      for (const attached of turnsByInput.get(item.eventId) ?? []) messages.push(turnView(attached));
    }
    // Streams of turns not yet in the loaded page (accumulated text; durable events replace it).
    for (const item of view.inflight) if (!fold.turns.has(item.turnId)) {
      const name = names.get(item.agentId) ?? current.title;
      messages.push({ id: "inflight:" + item.turnId, role: "assistant", title: name, state: "streaming",
        avatar: <EmployeeAvatar seed={item.agentId} fallbackName={name} size={28} />, content: <ChatMarkdown markdown={item.text} /> });
    }
    for (const item of view.pending) messages.push({
      id: "pending:" + item.idempotencyKey, role: "user", title: session.owner, copyText: item.text,
      content: <ChatMarkdown markdown={item.text} />,
      ...(item.attachments.length ? { attachments: attachmentsOf(item.attachments) } : {}),
      status: item.state === "sending" ? (zh ? "发送中…" : "Sending…") : item.state === "accepted" ? (zh ? "已发送" : "Sent")
        : errorMessage(t, item.error ?? "request_failed"),
      ...(item.state === "failed" || item.state === "rejected" ? { actions: <>
        {item.state === "failed" ? <Button onClick={() => void client.retry(item.idempotencyKey).catch(() => undefined)}>{t("common.retry")}</Button> : null}
        <Button onClick={() => client.discard(item.idempotencyKey)}>{zh ? "放弃" : "Dismiss"}</Button>
      </> } : {}),
    });
  }

  const groupWritable = features.has("groups");
  const canSend = !!current && !current.readOnly && (current.kind === "dm" || (current.kind === "group" && groupWritable));
  const draftMentions = (chat: ChatSummary, text: string) => ({
    all: /(^|\s)@(所有人|all|全部)(?=\s|$)/i.test(text),
    agentIds: chat.agentIds.filter((id) => names.has(id) && text.includes("@" + names.get(id)!)),
  });
  const insertMention = (chatId: string, name: string) => setDrafts((values) => {
    const draft = values[chatId] ?? "";
    const base = draft.endsWith("@") ? draft.slice(0, -1) : draft;
    return { ...values, [chatId]: `${base}${base && !/\s$/.test(base) ? " " : ""}@${name} ` };
  });
  // The composer type intersects ChatComposer's ReactNode slot; the room composer reads this list.
  const composerFiles = (chatId: string) => (files[chatId] ?? []).map((ref) => ({ id: ref.attachmentId, name: ref.name,
    kind: ref.contentType.startsWith("image/") ? "image" as const : ref.contentType.startsWith("text/") ? "text" as const : "file" as const,
    onRemove: () => setFiles((values) => ({ ...values, [chatId]: (values[chatId] ?? []).filter((item) => item.attachmentId !== ref.attachmentId) })),
  })) as unknown as NonNullable<ConversationComposer["attachments"]>;
  const onSend = () => {
    if (!current) return;
    const text = drafts[current.chatId] ?? "", attachments = files[current.chatId] ?? [];
    if (!text.trim() && !attachments.length) return;
    if (features.has("send")) {
      setDrafts((values) => ({ ...values, [current.chatId]: "" }));
      setFiles((values) => ({ ...values, [current.chatId]: [] }));
      void client.send(current.chatId, { text, attachments, ...(current.kind === "group" ? { mentions: draftMentions(current, text) } : {}) }).catch(() => undefined);
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
        ...(groupWritable ? [{ id: "group", label: zh ? "发起群聊" : "New group", onSelect: () => setGrouping(true) }] : []),
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
          actions={[{ label: zh ? "发起单聊" : "Start a chat", variant: "primary", onClick: () => setStarting(true) }]}
          notice={failure} />
      ) : (
        <ListDetailLayout list={sidebar} detailOpen={!!current} onBack={() => setSelected(undefined)} backLabel={zh ? "消息" : "Messages"}
          empty={<EmptyState illustration="messages" title={zh ? "选择员工开始对话" : "Select an Agent to begin"} />}
          detail={current && view ? (
            <Conversation conversationId={current.chatId}
              header={<PageHeader avatar={avatar(current, 30)} title={current.title}
                description={current.kind === "group" ? `${current.agentIds.length + 1} ${zh ? "位成员" : "participants"}` : undefined}
                actions={<RoomHeaderActions roomId={current.chatId} roomTitle={current.title}
                  messages={messages.flatMap((message) => message.copyText ? [{ id: message.id, sender: String(message.title ?? ""), text: message.copyText }] : [])}
                  onLocateMessage={(id) => document.querySelector(`[data-room-message-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" })} />} />}
              notice={<>
                {failure}
                {client.connection.state === "reconnecting" ? <p className="mau-muted">{zh ? "正在重新连接…" : "Reconnecting…"}</p> : null}
                {view.hasOlder ? <Button onClick={() => void client.loadOlder(current.chatId).catch(setUploadError)}>{zh ? "加载更早的消息" : "Load earlier messages"}</Button> : null}
                {matrixSend.isError && outgoing?.chatId === current.chatId ? <>
                  <Button onClick={() => matrixSend.mutate(outgoing)}>{t("common.retry")}</Button>
                  <Button onClick={() => { setOutgoing(undefined); matrixSend.reset(); }}>{zh ? "放弃重试" : "Dismiss retry"}</Button>
                </> : null}
              </>}
              {...(!view.loaded ? { empty: <LoadingSurface label={t("common.loading")} /> } : {})}
              messages={messages}
              composer={{
                value: drafts[current.chatId] ?? "",
                onChange: (value) => setDrafts((values) => ({ ...values, [current.chatId]: value })),
                disabled: !canSend || matrixSend.isPending || !!outgoing || uploading,
                placeholder: !canSend ? (zh ? "此对话只读" : "This conversation is read-only")
                  : current.kind === "group" ? (zh ? "@员工 让他回答，@所有人 让大家都回答…" : "@an employee to ask them, @all to ask everyone…")
                  : (zh ? "发送消息…" : "Send a message…"),
                ...(features.has("attachments") && features.has("send") && canSend ? {
                  onFiles: (picked: File[]) => { setUploadError(undefined); void upload(current.chatId, picked).catch(setUploadError); },
                  attachments: composerFiles(current.chatId),
                } : {}),
                ...(current.kind === "group" && canSend ? { mentions: [
                  ...current.agentIds.map((agentId) => ({ id: agentId, label: names.get(agentId) ?? agentId,
                    avatar: <EmployeeAvatar seed={agentId} fallbackName={names.get(agentId) ?? agentId} size={20} />,
                    onSelect: () => insertMention(current.chatId, names.get(agentId) ?? agentId) })),
                  { id: "all", kind: "all" as const, label: zh ? "所有人" : "all", detail: zh ? "群里的员工都回答" : "Every employee in the group answers",
                    onSelect: () => insertMention(current.chatId, zh ? "所有人" : "all") },
                ] } : {}),
                onSend,
              }} />
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
      {groupWritable ? <CreateGroupDialog open={grouping} title={groupTitle} busy={createGroup.isPending} selectedMemberIds={groupMembers}
        contactMembers={agents.data?.map(({ agent }) => ({ id: agent.id, name: agent.name, avatarSeed: agent.id })) ?? []}
        onOpenChange={(value) => { setGrouping(value); if (!value) createGroup.reset(); }}
        onTitleChange={setGroupTitle}
        onToggleMember={(id) => setGroupMembers((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id])}
        onCreate={() => createGroup.mutate()} /> : null}
    </>
  );
}
