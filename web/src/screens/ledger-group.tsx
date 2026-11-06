import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreateGroupForm } from "@olorinm/agent-frontend";
import { Button, Dialog, DialogContent, DialogTitle, EmployeeAvatar } from "@olorinm/agent-ui/app";
import type { AgentSummary } from "../api/client";
import { ApiError } from "../api/http";
import { newIdempotencyKey as newGroupKey, type Actor, type ChatEvent, type ChatSummary, type LedgerChatView, type SendResponse } from "../api/ledger";
import {
  addressedLine, groupAgentsMax, groupErrorMessage, groupTitle, groupsApi, mentionsSomeone, memberEventText,
  noMentionHint, resolveMentions, type Addressed, type GroupSummary, type Mentions,
} from "../api/ledger-groups";
import { errorMessage, useI18n } from "../i18n";
import "./ledger-group.css";

/*
 * Router-native group rooms in the ledger console (agent-router ADR 0005 section 17.7).
 * The chat view itself is the ledger DM view; this module adds what only rooms have:
 * creation, the member panel, mention resolution, the no-mention hint and the addressed state.
 */

function useGroupError() {
  const { t, language } = useI18n(), zh = language === "zh-CN";
  return (error: unknown) => {
    const code = error instanceof ApiError ? error.code : "request_failed";
    return groupErrorMessage(code, zh) ?? errorMessage(t, code);
  };
}

/** "新建群聊": the shared OpenGrove group form (title and agent picker), creating a Router room. */
export function LedgerCreateGroupDialog({ token, open, agents, onOpenChange, onCreated }: {
  token: string; open: boolean; agents: readonly AgentSummary[];
  onOpenChange(open: boolean): void; onCreated(summary: GroupSummary): void;
}) {
  const { language } = useI18n(), zh = language === "zh-CN";
  const describe = useGroupError();
  const api = useMemo(() => groupsApi(token), [token]);
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  // One key per intent: a retry after a lost response returns the same room instead of a second one.
  const key = useRef(newGroupKey());
  const reset = () => { setTitle(""); setMembers([]); key.current = newGroupKey(); create.reset(); };
  const names = new Map(agents.map(({ agent }) => [agent.id, agent.name]));
  const create = useMutation({
    mutationFn: () => api.create({ title: groupTitle(title, members.map((id) => names.get(id) ?? id)), agentIds: members, idempotencyKey: key.current }),
    onSuccess: (summary) => { reset(); onCreated(summary); },
  });
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value && !create.isPending) reset(); onOpenChange(value); }}>
      <DialogContent className="rooms-create-group-dialog" aria-describedby={undefined}>
        <DialogTitle>{zh ? "新建群聊" : "New group"}</DialogTitle>
        <CreateGroupForm open={open} title={title} busy={create.isPending} selectedMemberIds={members}
          contactMembers={agents.map(({ agent }) => ({ id: agent.id, name: agent.name, avatarSeed: agent.id,
            disabled: members.length >= groupAgentsMax && !members.includes(agent.id) }))}
          onOpenChange={onOpenChange}
          onTitleChange={(value) => { setTitle(value); key.current = newGroupKey(); }}
          onToggleMember={(id) => { key.current = newGroupKey();
            setMembers((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : ids.length >= groupAgentsMax ? ids : [...ids, id]); }}
          onCreate={() => create.mutate()} />
        {create.error ? <p role="alert" className="mau-error">{describe(create.error)}</p> : null}
      </DialogContent>
    </Dialog>
  );
}

/** Member panel: rename, add and remove agents. Router appends a `member` event for each change. */
export function LedgerGroupMembersDialog({ token, chat, members, agents, open, onOpenChange, onChanged }: {
  token: string; chat: ChatSummary; members: readonly Actor[]; agents: readonly AgentSummary[]; open: boolean;
  onOpenChange(open: boolean): void; onChanged(change: { members?: Actor[]; summary?: ChatSummary }): void;
}) {
  const { t, language } = useI18n(), zh = language === "zh-CN";
  const describe = useGroupError();
  const api = useMemo(() => groupsApi(token), [token]);
  const [title, setTitle] = useState(chat.title);
  const [adding, setAdding] = useState("");
  useEffect(() => setTitle(chat.title), [chat.chatId, chat.title]);
  const agentMembers = members.filter((member) => member.type === "agent");
  const addable = agents.filter(({ agent }) => !agentMembers.some((member) => member.id === agent.id));
  const rename = useMutation({ mutationFn: () => api.rename(chat.chatId, title), onSuccess: (summary) => onChanged({ summary }) });
  const add = useMutation({
    mutationFn: (agentId: string) => api.addMember(chat.chatId, agentId),
    onSuccess: (result) => { setAdding(""); onChanged({ members: result.members }); },
  });
  const remove = useMutation({ mutationFn: (agentId: string) => api.removeMember(chat.chatId, agentId), onSuccess: (result) => onChanged({ members: result.members }) });
  const busy = rename.isPending || add.isPending || remove.isPending;
  const error = rename.error ?? add.error ?? remove.error;
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) { rename.reset(); add.reset(); remove.reset(); } onOpenChange(value); }}>
      <DialogContent className="mau-group-members" aria-describedby={undefined}>
        <DialogTitle>{zh ? "群成员" : "Group members"}</DialogTitle>
        <form className="mau-group-rename" onSubmit={(event) => { event.preventDefault(); if (title.trim() && title.trim() !== chat.title) rename.mutate(); }}>
          <label className="mau-field">
            <span>{zh ? "群聊名称" : "Group name"}</span>
            <input value={title} maxLength={64} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <Button type="submit" disabled={busy || !title.trim() || title.trim() === chat.title}>{zh ? "保存名称" : "Save name"}</Button>
        </form>
        <ul className="mau-group-member-list" aria-label={zh ? "成员" : "Members"}>
          {members.map((member) => (
            <li key={member.type + ":" + member.id}>
              <EmployeeAvatar seed={member.id} fallbackName={member.name} size={28} />
              <span>{member.name}</span>
              {member.type === "agent" ? (
                <Button disabled={busy} aria-label={(zh ? "移出 " : "Remove ") + member.name} onClick={() => remove.mutate(member.id)}>
                  {zh ? "移出" : "Remove"}
                </Button>
              ) : <small className="mau-muted">{member.type === "person" ? (zh ? "群主" : "Owner") : member.type}</small>}
            </li>
          ))}
        </ul>
        <div className="mau-group-add">
          <label className="mau-field">
            <span>{zh ? "添加员工" : "Add an Agent"}</span>
            <select value={adding} onChange={(event) => setAdding(event.target.value)} disabled={agentMembers.length >= groupAgentsMax}>
              <option value="">{zh ? "选择员工" : "Select an Agent"}</option>
              {addable.map(({ agent }) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
          <Button disabled={busy || !adding || agentMembers.length >= groupAgentsMax} onClick={() => add.mutate(adding)}>{zh ? "添加" : "Add"}</Button>
        </div>
        {agentMembers.length >= groupAgentsMax ? <p className="mau-muted">{groupErrorMessage("too_many_members", zh)}</p> : null}
        {error ? <p role="alert" className="mau-error">{describe(error)}</p> : null}
        <div className="modal-actions"><Button onClick={() => onOpenChange(false)}>{t("common.close")}</Button></div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Room state the ledger chat view needs: members (refetched after each `member` event), per-agent names,
 * mentions for a draft, and the addressed state of the owner's sends in this tab.
 */
export function useLedgerGroup({ token, chat, view, agents }: {
  token: string; chat: ChatSummary | undefined; view: LedgerChatView | undefined; agents: readonly AgentSummary[];
}) {
  const { language } = useI18n(), zh = language === "zh-CN";
  const queries = useQueryClient();
  const api = useMemo(() => groupsApi(token), [token]);
  const group = chat?.kind === "group" ? chat : undefined;
  const events = view?.chatId === group?.chatId ? view?.events ?? [] : [];
  const memberSeq = events.reduce((seq, event) => event.kind === "member" ? event.seq : seq, 0);
  const queryKey = ["ledger-group", token, group?.chatId, memberSeq];
  const room = useQuery({ queryKey, queryFn: ({ signal }) => api.room(group!.chatId, signal), enabled: !!group, retry: false });
  const [addressed, setAddressed] = useState<Record<string, Addressed>>({});
  // LedgerClient.updateSummary does not notify its observers; re-render so the header shows the change.
  const [, rerender] = useState(0);

  const members = room.data?.members ?? [];
  const known = new Map(agents.map(({ agent }) => [agent.id, agent.name]));
  for (const member of members) if (member.type === "agent" && !known.has(member.id)) known.set(member.id, member.name);
  const nameOf = (agentId: string) => known.get(agentId) ?? agentId;
  // The mention picker lists current member agents; before the room loads, the summary's agent ids.
  const candidates = (room.data ? members.filter((member) => member.type === "agent").map(({ id }) => id) : group?.agentIds ?? [])
    .map((id) => ({ id, name: nameOf(id) }));
  const byId = new Map(events.map((event) => [event.eventId, event] as const));

  /** Apply a member or title change locally until the socket's `chats.updated` arrives. */
  function applyChange(change: { members?: Actor[]; summary?: ChatSummary }, update: (summary: ChatSummary) => void) {
    if (!group) return;
    const base: GroupSummary = room.data ?? { ...group, members: [] };
    const next: GroupSummary = { ...base, ...(change.summary ?? {}), members: change.members ?? base.members };
    if (change.members) next.agentIds = change.members.filter((member) => member.type === "agent").map(({ id }) => id);
    if (room.data) queries.setQueryData(queryKey, next);
    const { members: _members, ...summary } = next;
    update(summary);
    rerender((value) => value + 1);
  }

  return {
    group, members, candidates, nameOf, error: room.error,
    mentions: (text: string): Mentions => resolveMentions(text, candidates),
    /** The composer hint while a group draft addresses nobody. */
    hint: (text: string) => group && text.trim() && !mentionsSomeone(resolveMentions(text, candidates)) ? noMentionHint(zh) : undefined,
    record: (response: SendResponse | undefined) => {
      if (response) setAddressed((values) => ({ ...values, [response.event.eventId]: response.addressed as Addressed }));
    },
    /** Under an owner message: the addressed state from the send response, or its stored mentions after a reload. */
    addressedLine: (eventId: string) => {
      const event: ChatEvent | undefined = byId.get(eventId);
      if (!group || event?.kind !== "message" || event.sender.type !== "person") return "";
      return addressedLine(addressed[eventId], event.mentions, nameOf, zh);
    },
    memberText: (eventId: string) => {
      const event = byId.get(eventId);
      return event?.kind === "member" ? memberEventText(event, zh) : undefined;
    },
    applyChange,
    /** Rename from the room header menu ("编辑名称"). */
    rename: async (title: string, update: (summary: ChatSummary) => void) => {
      if (!group) return;
      applyChange({ summary: await api.rename(group.chatId, title) }, update);
    },
  };
}
