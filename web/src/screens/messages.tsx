import {blockBuildReload} from "../build-version";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CollectionEmptyState,
  RoomHeaderActions,
  Conversation,
  ItemList,
  ListDetailLayout,
  PageHeader,
  SidebarHeader,
  SearchField,
  CollaborationTabs,
  LoadingSurface,
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
import { runApi } from "../api/runs";
import { TaskSurface } from "./run-surface";
import { MauConversations } from "../api/conversations";
import { ApiError } from "../api/http";
import type { Session } from "../api/session";
import { useI18n, errorMessage } from "../i18n";

export function MessagesScreen({
  session,
  onContacts,
  initialAgentId,
  onStartHandled,
}: {
  session: Session;
  onContacts(): void;
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
  const current = (rooms.data ?? client.snapshot()).find(
    (room) => room.id === selected,
  );
  const tasks = useQuery({
    queryKey: ["run-tasks", session.token, current?.agentId, current?.id],
    queryFn: ({ signal }) => runApi(session.token, current!.agentId).tasks(current!.id, signal),
    enabled: !!current && !!agents.data?.find(({agent}) => agent.id === current.agentId)?.host,
    refetchInterval: query => query.state.error ? false : 3000,
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
  }>();
  useEffect(() => blockBuildReload(Boolean(outgoing) || Object.values(drafts).some(value => Boolean(value.trim()))), [outgoing, drafts]);
  const send = useMutation({
    mutationFn: (message: {
      room: string;
      text: string;
      transaction: string;
    }) => client.send(message.room, message.text, message.transaction),
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
  const error = agents.error ?? rooms.error ?? start.error ?? send.error ?? tasks.error;
  const failure = error ? (
    <p role="alert" className="mau-error">
      {errorMessage(
        t,
        error instanceof ApiError ? error.code : "request_failed",
      )}
      {agents.error || rooms.error || tasks.error ? <Button onClick={() => { void agents.refetch(); void rooms.refetch(); if (current) void tasks.refetch(); }}>{zh ? "重新连接" : "Reconnect"}</Button> : null}
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
  const list = (
    <>
      <SidebarHeader
        title={zh ? "消息" : "Messages"}
        actions={[
          {
            id: "conversation",
            label: zh ? "发起会话" : "New conversation",
            onSelect: () => setStarting(true),
          },
        ]}
      />
      <CollaborationTabs
        label={zh ? "员工视图" : "Agent views"}
        items={[
          { id: "messages", label: zh ? "对话" : "Conversations" },
          { id: "contacts", label: zh ? "通讯录" : "Contacts" },
        ]}
        selectedId="messages"
        onSelect={(id) => {
          if (id === "contacts") onContacts();
        }}
      />
      <SearchField
        value={search}
        onChange={setSearch}
        placeholder={zh ? "搜索会话" : "Search conversations"}
      />
      {failure}
      {!failure && (agents.isPending || (rooms.isPending && !rooms.data)) ? (
        <LoadingSurface label={t("common.loading")} />
      ) : null}
      <ItemList
        heading={zh ? "对话" : "Conversations"}
        label={zh ? "会话" : "Conversations"}
        {...(selected ? { selectedId: selected } : {})}
        onSelect={setSelected}
        items={roomList
          .filter((room) =>
            room.title.toLowerCase().includes(search.toLowerCase()),
          )
          .map((room) => ({
            id: room.id,
            title: room.group
              ? `${room.title} (${zh ? "群聊" : "Group"})`
              : room.title,
            description: room.messages.at(-1)?.text ?? "",
            leading: (
              <EmployeeAvatar
                seed={room.agentId}
                fallbackName={room.title}
                size={24}
              />
            ),
          }))}
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
              label: zh ? "发起会话" : "Start a conversation",
              variant: "primary",
              onClick: () => setStarting(true),
            },
            { label: zh ? "查看通讯录" : "View contacts", onClick: onContacts },
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
                    avatar={
                      <EmployeeAvatar
                        seed={current.agentId}
                        fallbackName={current.title}
                        size={30}
                      />
                    }
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
                    title={
                      current.group
                        ? `${current.title} (${zh ? "群聊" : "Group"})`
                        : current.title
                    }
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
                  const observedReply = message.sender !== session.owner && tasks.data?.data.some((task) =>
                    current.messages.some((origin) => origin.id === task.source.messageId)
                    && (task.replyMessageIds.includes(message.id) || task.interactionMessageIds.includes(message.id)));
                  if (observedReply) return [];
                  return [{
                    id: message.id, copyText: message.text,
                    role: message.sender === session.owner ? "user" as const : "assistant" as const,
                    title: message.sender === session.owner ? session.owner : current.title,
                    avatar: <EmployeeAvatar seed={message.sender} fallbackName={current.title} size={28} />,
                    content: <>{current.group ? <small>{message.sender}</small> : null}<ChatMarkdown markdown={message.text} /></>,
                  }, ...attached.map((task) => ({
                    id: "task:" + task.id, role: "assistant" as const, title: current.title,
                    avatar: <EmployeeAvatar seed={current.agentId} fallbackName={current.title} size={28} />,
                    copyText: current.messages.filter((reply) => task.replyMessageIds.includes(reply.id) || reply.replyTo === message.id).map((reply) => reply.text).join("\n"),
                    body: <TaskSurface task={task} token={session.token} agentId={current.agentId}
                      onInsertPrompt={(value) => setDrafts((values) => ({...values, [current.id]: value}))}
                      fallback={current.messages.filter((reply) => task.replyMessageIds.includes(reply.id) || reply.replyTo === message.id).map((reply) => reply.text).join("\n")} />,
                  }))];
                })}
                composer={{
                  value: drafts[current.id] ?? "",
                  onChange: (value) =>
                    setDrafts((values) => ({ ...values, [current.id]: value })),
                  disabled: send.isPending || !!outgoing,
                  placeholder: zh ? "发送消息…" : "Send a message…",
                  onSend: () => {
                    const message = {
                      room: current.id,
                      text: drafts[current.id] ?? "",
                      transaction: crypto.randomUUID(),
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
            <DialogTitle>{zh ? "发起会话" : "New conversation"}</DialogTitle>
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
    </>
  );
}
