import {blockBuildReload} from "../build-version";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CollectionEmptyState,
  RoomHeaderActions,
  Conversation,
  ItemList,
  ListDetailLayout,
  PageHeader,
  SidebarHeader,
  SearchField,
  LoadingSurface,
  CreateGroupDialog,
  RoomGroupAvatar,
} from "@olorinm/agent-frontend";
import {
  Button,
  EmptyState,
  EmployeeAvatar,
  Dialog,
  DialogContent,
  DialogTitle,
} from "@olorinm/agent-ui/app";
import { ChatMarkdown } from "@olorinm/agent-ui";
import { mauApi } from "../api/client";
import { runApi, type CommunicationTask } from "../api/runs";
import { TaskSurface } from "./run-surface";
import { MauConversations, type ConversationMentions, type ConversationView } from "../api/conversations";
import { ApiError } from "../api/http";
import type { Session } from "../api/session";
import { useI18n, errorMessage } from "../i18n";

/** Everyone mentioned in a group draft, from the "@name" text the composer inserted. */
function draftMentions(room: ConversationView, text: string, names: Map<string, string>): ConversationMentions {
  const all = /(^|\s)@(所有人|all|全部)(?=\s|$)/i.test(text);
  return { all, agentIds: room.agentIds.filter((id) => names.has(id) && text.includes("@" + names.get(id)!)) };
}

const terminalTask = (task: CommunicationTask) => ["completed", "failed", "canceled", "rejected"].includes(task.status);

export function MessagesScreen({
  session,
  initialAgentId,
  onStartHandled,
}: {
  session: Session;
  initialAgentId?: string | undefined;
  onStartHandled?(): void;
}) {
  const { t, language } = useI18n();
  const zh = language === "zh-CN";
  const queries = useQueryClient();
  const agents = useQuery({
    queryKey: ["agents", session.owner],
    queryFn: () => mauApi(session.token).agents(),
  });
  const identity = JSON.stringify(
    agents.data?.map(({ agent }) => [agent.id, agent.matrixId, agent.name]),
  );
  const client = useMemo(
    () => new MauConversations(session, agents.data ?? []),
    [session.token, identity],
  );
  const key = ["conversations", session.owner, identity];
  const rooms = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => client.sync(signal),
    enabled: !!agents.data?.length,
    retry: false,
    refetchInterval: query => query.state.error ? false : 1000,
  });
  const [search, setSearch] = useState("");
  const [starting, setStarting] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [target, setTarget] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Insert "@name " at the end of the draft; a just-typed "@" is completed instead of repeated.
  const insertMention = (room: string, name: string) => setDrafts((values) => {
    const draft = values[room] ?? "";
    const base = draft.endsWith("@") ? draft.slice(0, -1) : draft;
    return { ...values, [room]: `${base}${base && !/\s$/.test(base) ? " " : ""}@${name} ` };
  });
  const [grouping, setGrouping] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [groupMembers, setGroupMembers] = useState<string[]>([]);
  const current = (rooms.data ?? client.snapshot()).find(
    (room) => room.id === selected,
  );
  const names = new Map(agents.data?.map(({ agent }) => [agent.id, agent.name]) ?? []);
  // Each employee in the room answers through its own Router; read each one's tasks.
  const runnable = current?.agentIds.filter((id) => agents.data?.find(({ agent }) => agent.id === id)?.host) ?? [];
  const taskQueries = useQueries({
    queries: runnable.map((agentId) => ({
      queryKey: ["run-tasks", session.token, agentId, current?.id],
      queryFn: ({ signal }: { signal: AbortSignal }) => runApi(session.token, agentId).tasks(current!.id, signal)
        .then((page) => page.data.map((task) => ({ ...task, agentId }))),
      enabled: !!current,
      refetchInterval: (query: { state: { error: unknown } }) => query.state.error ? false : 3000,
    })),
  });
  const tasks = {
    data: taskQueries.some((query) => query.data) ? { data: taskQueries.flatMap((query) => query.data ?? []) } : undefined,
    error: taskQueries.find((query) => query.error)?.error ?? null,
    refetch: () => { for (const query of taskQueries) void query.refetch(); },
  };
  const createGroup = useMutation({
    mutationFn: () => client.createGroup(groupTitle, groupMembers),
    onSuccess: (id) => {
      setGrouping(false);
      setGroupTitle("");
      setGroupMembers([]);
      setSelected(id);
      queries.setQueryData(key, client.snapshot());
    },
  });
  const start = useMutation({
    mutationFn: (id: string) => client.start(id),
    onSuccess: (id) => {
      onStartHandled?.();
      setStarting(false);
      setSelected(id);
      queries.setQueryData(key, client.snapshot());
    },
  });
  // Keep transaction IDs on a failed delivery so Retry cannot duplicate an accepted Matrix event.
  const [outgoing, setOutgoing] = useState<{
    room: string;
    text: string;
    transaction: string;
    mentions?: ConversationMentions;
  }>();
  useEffect(() => blockBuildReload(Boolean(outgoing) || Object.values(drafts).some(value => Boolean(value.trim()))), [outgoing, drafts]);
  const send = useMutation({
    mutationFn: (message: {
      room: string;
      text: string;
      transaction: string;
      mentions?: ConversationMentions;
    }) => client.send(message.room, message.text, message.transaction, message.mentions),
    onSuccess: (_, message) => {
      setDrafts((values) => ({
        ...values,
        [message.room]:
          values[message.room] === message.text
            ? ""
            : (values[message.room] ?? ""),
      }));
      setOutgoing(undefined);
      queries.setQueryData(key, client.snapshot());
    },
  });
  const error = agents.error ?? rooms.error ?? start.error ?? createGroup.error ?? send.error ?? tasks.error;
  const failure = error ? (
    <p role="alert" className="mau-error">
      {errorMessage(
        t,
        error instanceof ApiError ? error.code : "request_failed",
      )}
      {agents.error || rooms.error || tasks.error ? <Button onClick={() => { void agents.refetch(); void rooms.refetch(); if (current) tasks.refetch(); }}>{zh ? "重新连接" : "Reconnect"}</Button> : null}
    </p>
  ) : null;
  const requested = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      initialAgentId &&
      agents.data?.some(({ agent }) => agent.id === initialAgentId) &&
      requested.current !== initialAgentId
    ) {
      requested.current = initialAgentId;
      setTarget(initialAgentId);
      start.mutate(initialAgentId);
    }
    if (!initialAgentId) requested.current = undefined;
  }, [initialAgentId, identity]);
  const roomList = rooms.data ?? client.snapshot();
  useEffect(() => {
    if (
      !selected &&
      roomList.length &&
      matchMedia("(min-width: 901px)").matches
    )
      setSelected(roomList[0]!.id);
  }, [roomList, selected]);
  const visible = roomList.filter((room) =>
    room.title.toLowerCase().includes(search.toLowerCase()),
  );
  // OpenGrove lists chats and groups together by recent activity; groups show their members.
  const avatar = (room: ConversationView, size: number) => room.group ? (
    <RoomGroupAvatar title={room.title} className="mau-room-avatar"
      members={room.agentIds.map((id) => ({ id, name: names.get(id) ?? id, avatarSeed: id }))} />
  ) : <EmployeeAvatar seed={room.agentId} fallbackName={room.title} size={size} />;
  const rows = (items: ConversationView[]) => items.map((room) => ({
    id: room.id,
    title: room.title,
    description: room.messages.at(-1)?.text ?? "",
    leading: avatar(room, 24),
  }));
  const list = (
    <>
      <SidebarHeader
        title={zh ? "对话" : "Conversations"}
        actions={[
          {
            id: "conversation",
            label: zh ? "发起单聊" : "New chat",
            onSelect: () => setStarting(true),
          },
          {
            id: "group",
            label: zh ? "发起群聊" : "New group",
            onSelect: () => setGrouping(true),
          },
        ]}
      />
      <SearchField
        value={search}
        onChange={setSearch}
        placeholder={zh ? "搜索对话" : "Search conversations"}
      />
      {failure}
      {!failure && (agents.isPending || (rooms.isPending && !rooms.data)) ? (
        <LoadingSurface label={t("common.loading")} />
      ) : null}
      <ItemList
        label={zh ? "对话" : "Conversations"}
        {...(selected ? { selectedId: selected } : {})}
        onSelect={setSelected}
        items={rows(visible)}
      />
    </>
  );
  return (
    <>
      {!roomList.length ? (
        <CollectionEmptyState
          label={zh ? "消息" : "Messages"}
          loading={
            !failure && (agents.isPending || (!!agents.data?.length && rooms.isPending))
          }
          illustration="messages"
          title={zh ? "还没有员工会话" : "No conversations yet"}
          description={
            zh
              ? "创建员工后，它会出现在通讯录；打开私聊或群聊后，这里显示对话。"
              : "Agents appear in Contacts. Open a conversation to see messages here."
          }
          actions={[
            {
              label: zh ? "发起单聊" : "Start a chat",
              variant: "primary",
              onClick: () => setStarting(true),
            },
            { label: zh ? "发起群聊" : "New group", onClick: () => setGrouping(true) },
          ]}
          notice={failure}
        />
      ) : (
        <ListDetailLayout
          list={list}
          detailOpen={!!current}
          onBack={() => setSelected(undefined)}
          backLabel={zh ? "消息" : "Messages"}
          empty={
            <EmptyState
              illustration="messages"
              title={zh ? "选择员工开始对话" : "Select an Agent to begin"}
            />
          }
          detail={
            current ? (
              <Conversation
                conversationId={current.id}
                header={
                  <PageHeader
                    avatar={avatar(current, 30)}
                    actions={
                      <RoomHeaderActions
                        roomId={current.id}
                        roomTitle={current.title}
                        messages={current.messages.map((message) => ({
                          id: message.id,
                          sender: message.sender,
                          text: message.text,
                        }))}
                        onLocateMessage={(id) =>
                          document
                            .querySelector(
                              `[data-room-message-id="${CSS.escape(id)}"]`,
                            )
                            ?.scrollIntoView({
                              block: "center",
                              behavior: "smooth",
                            })
                        }
                      />
                    }
                    title={current.title}
                    description={
                      current.group
                        ? `${current.participants} ${zh ? "位成员" : "participants"}`
                        : undefined
                    }
                  />
                }
                notice={
                  <>
                    {failure}
                    {current.limited ? (
                      <p className="mau-muted">
                        {zh ? "当前显示最近消息。" : "Showing recent messages."}
                      </p>
                    ) : null}
                    {send.isError && outgoing?.room === current.id ? (
                      <>
                        <Button onClick={() => send.mutate(outgoing)}>
                          {t("common.retry")}
                        </Button>
                        <Button
                          onClick={() => {
                            setOutgoing(undefined);
                            send.reset();
                          }}
                        >
                          {zh ? "放弃重试" : "Dismiss retry"}
                        </Button>
                      </>
                    ) : null}
                  </>
                }
                messages={current.messages.flatMap((message) => {
                  const attached = tasks.data?.data.filter((task) => task.source.messageId === message.id) ?? [];
                  const matrixId = (agentId: string) => agents.data?.find(({ agent }) => agent.id === agentId)?.agent.matrixId;
                  // A reply streamed while its task is still running is not in replyMessageIds yet.
                  const answers = (task: CommunicationTask & { agentId: string }, reply: (typeof current.messages)[number]) => task.replyMessageIds.includes(reply.id)
                    || (!terminalTask(task) && reply.replyTo === task.source.messageId && reply.sender === matrixId(task.agentId));
                  const observedReply = message.sender !== session.owner && tasks.data?.data.some((task) =>
                    current.messages.some((origin) => origin.id === task.source.messageId)
                    && (answers(task, message) || task.interactionMessageIds.includes(message.id)));
                  if (observedReply) return [];
                  const sender = agents.data?.find(({ agent }) => agent.matrixId === message.sender)?.agent;
                  const senderName = message.sender === session.owner ? session.owner : sender?.name ?? current.title;
                  return [{
                    id: message.id, copyText: message.text,
                    role: message.sender === session.owner ? "user" as const : "assistant" as const,
                    title: senderName,
                    avatar: <EmployeeAvatar seed={sender?.id ?? message.sender} fallbackName={senderName} size={28} />,
                    content: <ChatMarkdown markdown={message.text} />,
                  }, ...attached.map((task) => {
                    const name = names.get(task.agentId) ?? current.title;
                    const replies = current.messages.filter((reply) => answers(task, reply));
                    return {
                      id: "task:" + task.agentId + ":" + task.id, role: "assistant" as const, title: name,
                      avatar: <EmployeeAvatar seed={task.agentId} fallbackName={name} size={28} />,
                      copyText: replies.map((reply) => reply.text).join("\n"),
                      body: <TaskSurface task={task} token={session.token} agentId={task.agentId}
                        onInsertPrompt={(value) => setDrafts((values) => ({...values, [current.id]: value}))}
                        fallback={replies.map((reply) => reply.text).join("\n")} />,
                    };
                  })];
                })}
                composer={{
                  value: drafts[current.id] ?? "",
                  onChange: (value) =>
                    setDrafts((values) => ({ ...values, [current.id]: value })),
                  disabled: send.isPending || !!outgoing,
                  placeholder: current.group
                    ? (zh ? "@员工 让他回答，@所有人 让大家都回答…" : "@an employee to ask them, @all to ask everyone…")
                    : (zh ? "发送消息…" : "Send a message…"),
                  ...(current.group ? { mentions: [
                    ...current.agentIds.map((agentId) => ({
                      id: agentId,
                      label: names.get(agentId) ?? agentId,
                      avatar: <EmployeeAvatar seed={agentId} fallbackName={names.get(agentId) ?? agentId} size={20} />,
                      onSelect: () => insertMention(current.id, names.get(agentId) ?? agentId),
                    })),
                    { id: "all", kind: "all" as const, label: zh ? "所有人" : "all", detail: zh ? "群里的员工都回答" : "Every employee in the group answers",
                      onSelect: () => insertMention(current.id, zh ? "所有人" : "all") },
                  ] } : {}),
                  onSend: () => {
                    const text = drafts[current.id] ?? "";
                    const message = {
                      room: current.id,
                      text,
                      transaction: crypto.randomUUID(),
                      ...(current.group ? { mentions: draftMentions(current, text, names) } : {}),
                    };
                    setOutgoing(message);
                    send.mutate(message);
                  },
                }}
              />
            ) : null
          }
        />
      )}
      {starting ? (
        <Dialog open onOpenChange={setStarting}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>{zh ? "发起单聊" : "New chat"}</DialogTitle>
            <label className="mau-field">
              <span>{zh ? "选择员工" : "Select an Agent"}</span>
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">{zh ? "选择员工" : "Select an Agent"}</option>
                {agents.data?.map(({ agent }) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
            {failure}
            <div className="modal-actions">
              <Button
                disabled={!target || start.isPending}
                onClick={() => start.mutate(target)}
              >
                {zh ? "打开对话" : "Open conversation"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
      <CreateGroupDialog
        open={grouping}
        title={groupTitle}
        busy={createGroup.isPending}
        selectedMemberIds={groupMembers}
        contactMembers={agents.data?.map(({ agent }) => ({ id: agent.id, name: agent.name, avatarSeed: agent.id })) ?? []}
        onOpenChange={(open) => { setGrouping(open); if (!open) createGroup.reset(); }}
        onTitleChange={setGroupTitle}
        onToggleMember={(id) => setGroupMembers((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id])}
        onCreate={() => createGroup.mutate()}
      />
    </>
  );
}
