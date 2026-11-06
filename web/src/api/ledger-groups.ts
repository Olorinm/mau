import { ApiError, request } from "./http";
import { ledgerBase, newIdempotencyKey, type Actor, type ChatEvent, type ChatSummary } from "./ledger";

/*
 * Router-native group rooms (agent-router ADR 0005 section 17, phase 5).
 * A room is a hub chat `room:rm_…` whose members are the owner and up to 20 of the owner's agents.
 * The client resolves mentions; Router never parses "@" from the text, and a message without a
 * mention is stored but reaches no agent.
 */

export type GroupSummary = ChatSummary & { members: Actor[] };
/** `queued`/`not_addressed` come from ADR 17.1; `delivered`/`failed` follow the fan-out row; `control` is a DM command. */
export type AddressedState = "queued" | "delivered" | "failed" | "not_addressed" | "control";
export type Addressed = ReadonlyArray<{ agentId: string; state: AddressedState }>;
export interface Mentions { agentIds: string[]; all: boolean }

export const groupTitleMax = 64;
export const groupAgentsMax = 20;
const roomPrefix = "room:";

export const isRoomChat = (chatId: string) => chatId.startsWith(roomPrefix) && chatId.length > roomPrefix.length;
/** `PATCH /groups/:roomId` takes the room id, which is the chat id without its `room:` prefix. */
export function roomIdOf(chatId: string): string {
  if (!isRoomChat(chatId)) throw new ApiError("conversation_not_found", 0);
  return chatId.slice(roomPrefix.length);
}

/** Router refuses an empty or over-long title; an untitled group is named after its agents, as Matrix groups were. */
export function groupTitle(title: string, agentNames: readonly string[]): string {
  const chosen = title.trim() || agentNames.join("、");
  return [...chosen].slice(0, groupTitleMax).join("");
}
/** The local checks Router repeats (ADR 17.1): 1–64 characters, 1–20 distinct agents. */
export function groupInputError(title: string, agentIds: readonly string[]): string | undefined {
  const length = [...title.trim()].length;
  if (!length || length > groupTitleMax) return "invalid_group_title";
  if (!agentIds.length || new Set(agentIds).size !== agentIds.length) return "invalid_group_members";
  if (agentIds.length > groupAgentsMax) return "too_many_members";
  return undefined;
}

export function groupsApi(token: string, base = ledgerBase) {
  const group = (chatId: string) => base + "/groups/" + encodeURIComponent(roomIdOf(chatId));
  return {
    /** One key per user intent: a retry after a lost response reuses it and gets the same room. */
    create(input: { title: string; agentIds: string[]; idempotencyKey?: string }) {
      const error = groupInputError(input.title, input.agentIds);
      if (error) return Promise.reject(new ApiError(error, 0));
      return request<GroupSummary>(base + "/groups", { token, body: {
        idempotencyKey: input.idempotencyKey ?? newIdempotencyKey(), title: input.title.trim(), agentIds: input.agentIds,
      } });
    },
    rename(chatId: string, title: string) {
      const error = groupInputError(title, ["_"]);
      if (error) return Promise.reject(new ApiError(error, 0));
      return request<ChatSummary>(group(chatId), { token, method: "PATCH", body: { title: title.trim() } });
    },
    archive: (chatId: string, archived = true) => request<ChatSummary>(group(chatId), { token, method: "PATCH", body: { archived } }),
    addMember: (chatId: string, agentId: string) =>
      request<{ members: Actor[] }>(group(chatId) + "/members", { token, body: { agentId } }),
    removeMember: (chatId: string, agentId: string) =>
      request<{ members: Actor[] }>(group(chatId) + "/members/" + encodeURIComponent(agentId), { token, method: "DELETE" }),
    /** `GET /chats/:chatId` answers a room with its members (the owner person and the agents). */
    room: (chatId: string, signal?: AbortSignal) =>
      request<GroupSummary>(base + "/chats/" + encodeURIComponent(chatId), { token, ...(signal ? { signal } : {}) }),
  };
}
export type GroupsApi = ReturnType<typeof groupsApi>;

// ---- Mentions ----
export interface MentionCandidate { id: string; name: string }
const allNames = ["所有人", "全部", "all"];
const wordChar = /[A-Za-z0-9_]/;

/**
 * Who a draft addresses, from the "@name" text the picker inserted (or the owner typed).
 * At each "@" the longest member name wins, so "@研究助理" never also matches an agent named "研究".
 * An ASCII name must end at a word boundary ("@bob" does not match "@bobby"); CJK names need none.
 */
export function resolveMentions(text: string, members: readonly MentionCandidate[]): Mentions {
  const names = [...members.filter((member) => member.name), ...allNames.map((name) => ({ id: "", name }))]
    .sort((a, b) => b.name.length - a.name.length);
  const agentIds = new Set<string>();
  let all = false;
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    const rest = text.slice(at + 1);
    const matched = names.find(({ name }) => rest.toLowerCase().startsWith(name.toLowerCase())
      && !(wordChar.test(name.at(-1)!) && wordChar.test(rest.charAt(name.length))));
    if (!matched) continue;
    if (!matched.id) { all = true; continue; }
    // Agents that share a display name are all addressed: the text cannot tell them apart.
    for (const member of members) if (member.name === matched.name) agentIds.add(member.id);
  }
  return { agentIds: [...agentIds], all };
}
export const mentionsSomeone = (mentions: Mentions) => mentions.all || mentions.agentIds.length > 0;

// ---- Addressed state under a sent message ----
const stateNames: Record<AddressedState, [string, string]> = {
  queued: ["已通知", "notified"], delivered: ["已送达", "delivered"], failed: ["未能送达", "not delivered"],
  control: ["已处理", "handled"], not_addressed: ["未 @", "not mentioned"],
};
export const noMentionHint = (zh: boolean) => zh ? "未 @ 任何 Agent，消息只记录" : "No Agent mentioned; the message is only recorded";

/**
 * One line such as "已通知：研究助理、写作助理". The send response is authoritative while it is known;
 * after a reload only the stored mentions remain.
 */
export function addressedLine(addressed: Addressed | undefined, mentions: Partial<Mentions> | undefined,
  nameOf: (agentId: string) => string, zh: boolean): string {
  if (addressed) {
    const parts: string[] = [];
    for (const state of ["queued", "delivered", "control", "failed"] as const) {
      const names = addressed.filter((item) => item.state === state).map((item) => nameOf(item.agentId));
      if (names.length) parts.push(`${stateNames[state][zh ? 0 : 1]}${zh ? "：" : ": "}${names.join(zh ? "、" : ", ")}`);
    }
    return parts.length ? parts.join(" · ") : noMentionHint(zh);
  }
  if (mentions?.all) return zh ? "@所有人" : "@all";
  if (mentions?.agentIds?.length) return mentions.agentIds.map((id) => "@" + nameOf(id)).join(" ");
  return mentions ? noMentionHint(zh) : "";
}

// ---- Member events ----
type MemberEvent = Extract<ChatEvent, { kind: "member" }>;
export function memberEventText(event: Pick<MemberEvent, "action" | "member" | "title">, zh: boolean): string {
  const name = event.member?.name ?? "";
  switch (event.action) {
    case "add": return zh ? `${name} 加入了群聊` : `${name} joined the group`;
    case "remove": return zh ? `${name} 已移出群聊` : `${name} left the group`;
    case "rename": return zh ? `群聊名称改为“${event.title ?? ""}”` : `Group renamed to “${event.title ?? ""}”`;
  }
}

// ---- Errors ----
const errors: Record<string, [string, string]> = {
  agent_not_found: ["所选员工不存在或已停用。", "An Agent you chose no longer exists or is inactive."],
  room_limit_reached: ["群聊数量已达上限（100 个），请先归档不用的群聊。", "You have reached the limit of 100 groups. Archive one first."],
  feature_disabled: ["Router 未开启群聊功能。", "Groups are not enabled on this Router."],
  too_many_members: ["一个群聊最多 20 位员工。", "A group can have at most 20 Agents."],
  mention_not_member: ["@ 的员工已不在群里，请重新选择。", "A mentioned Agent is no longer in this group."],
  invalid_group_title: ["群名需要 1–64 个字符。", "A group name needs 1–64 characters."],
  invalid_group_members: ["请选择 1–20 位员工。", "Choose 1–20 Agents."],
};
/** Group-specific error text; other codes fall back to the console's shared messages. */
export function groupErrorMessage(code: string, zh: boolean): string | undefined {
  return errors[code]?.[zh ? 0 : 1];
}
