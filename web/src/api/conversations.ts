import { request, ApiError } from "./http";
import type { AgentSummary } from "./client";
import type { Session } from "./session";

export interface ConversationMessage {
  id: string;
  sender: string;
  text: string;
  timestamp: number;
  replyTo?: string;
}
export interface ConversationView {
  id: string;
  title: string;
  /** The employee of a direct chat, or the first owned employee of a group. */
  agentId: string;
  /** Every owned employee in the room (one for a direct chat). */
  agentIds: string[];
  group: boolean;
  participants: number;
  messages: ConversationMessage[];
  limited: boolean;
}
/** Who a group message addresses; Router starts only the mentioned employees. */
export interface ConversationMentions {
  agentIds: string[];
  all: boolean;
}
interface MatrixEvent {
  event_id?: string;
  type?: string;
  sender?: string;
  state_key?: string;
  origin_server_ts?: number;
  content?: Record<string, unknown>;
  redacts?: string;
}
interface JoinedRoom {
  state?: { events?: MatrixEvent[] };
  timeline?: { events?: MatrixEvent[]; limited?: boolean };
}
interface Sync {
  next_batch: string;
  rooms?: {
    join?: Record<string, JoinedRoom>;
    leave?: Record<string, unknown>;
  };
}
interface RoomState {
  name?: string;
  /** Created as a group (Mau's `ai.mau.room` marker), even with one employee. */
  group?: boolean;
  members: Map<string, string>;
  messages: Map<string, ConversationMessage>;
  limited: boolean;
}

/** Mau's account messaging adapter. No OpenGrove format or native kernel execution is involved. */
export class MauConversations {
  private origin?: string;
  private cursor?: string;
  private initialSync: Promise<ConversationView[]> | undefined;
  private readonly rooms = new Map<string, RoomState>();
  private readonly owned: Map<string, AgentSummary["agent"]>;
  constructor(
    private session: Session,
    agents: readonly AgentSummary[],
  ) {
    this.owned = new Map(agents.map(({ agent }) => [agent.matrixId, agent]));
  }
  private async api<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT";
      body?: unknown;
      signal?: AbortSignal;
    } = {},
  ) {
    if (!this.origin) {
      // Read the product's configured public origin even for pasted account tokens.
      const info = await request<{ homeserver: string }>(
        "/_mau/v1/info",
        options.signal ? { signal: options.signal } : {},
      );
      const url = new URL(info.homeserver);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new ApiError("invalid_response", 200);
      this.origin = url.origin;
    }
    return request<T>(this.origin + "/_matrix/client/v3" + path, {
      ...options,
      token: this.session.token,
    });
  }
  async sync(signal?: AbortSignal): Promise<ConversationView[]> {
    // Opening a conversation must observe the same initial room inventory as the UI.
    // Coalesce that request so a slow first sync cannot create a duplicate direct room.
    if (!this.cursor) {
      this.initialSync ??= this.syncRooms(signal).finally(() => {
        this.initialSync = undefined;
      });
      return this.initialSync;
    }
    return this.syncRooms(signal);
  }
  private async syncRooms(signal?: AbortSignal): Promise<ConversationView[]> {
    const params = new URLSearchParams({
      timeout: this.cursor ? "25000" : "0",
      filter: JSON.stringify({
        room: { timeline: { limit: 50 }, state: { lazy_load_members: false } },
      }),
    });
    if (this.cursor) params.set("since", this.cursor);
    const data = await this.api<Sync>(
      "/sync?" + params,
      signal ? { signal } : {},
    );
    if (typeof data.next_batch !== "string")
      throw new ApiError("invalid_response", 200);
    for (const id of Object.keys(data.rooms?.leave ?? {}))
      this.rooms.delete(id);
    for (const [id, joined] of Object.entries(data.rooms?.join ?? {})) {
      const room: RoomState = this.rooms.get(id) ?? {
        members: new Map(),
        messages: new Map(),
        limited: false,
      };
      const timeline = joined.timeline?.events ?? [];
      for (const event of [...(joined.state?.events ?? []), ...timeline]) {
        if (
          event.type === "m.room.name" &&
          typeof event.content?.name === "string"
        )
          room.name = event.content.name;
        if (event.type === "ai.mau.room" && event.content?.kind === "group")
          room.group = true;
        if (
          event.type === "m.room.member" &&
          event.state_key &&
          typeof event.content?.membership === "string"
        )
          room.members.set(event.state_key, event.content.membership);
      }
      // Show only rooms involving the account's own Agents, not unrelated personal rooms.
      if (
        ![...room.members].some(
          ([member, membership]) =>
            this.owned.has(member) && ["join", "invite"].includes(membership),
        )
      ) {
        this.rooms.delete(id);
        continue;
      }
      if (joined.timeline?.limited) {
        room.messages.clear();
        room.limited = true;
      }
      for (const event of timeline) {
        if (event.type === "m.room.redaction") {
          const target = event.redacts ?? event.content?.redacts;
          if (typeof target === "string") room.messages.delete(target);
          continue;
        }
        const content = event.content;
        if (
          event.type !== "m.room.message" ||
          !event.event_id ||
          !event.sender ||
          !content ||
          typeof content.body !== "string"
        )
          continue;
        if (content.msgtype !== "m.text" && content.msgtype !== "m.notice")
          continue;
        const relation = content["m.relates_to"] as
          { rel_type?: string; event_id?: string; "m.in_reply_to"?: { event_id?: string } } | undefined;
        if (relation?.rel_type === "m.replace") {
          const original =
            relation.event_id && room.messages.get(relation.event_id);
          const replacement = content["m.new_content"] as
            { body?: unknown } | undefined;
          if (
            original &&
            original.sender === event.sender &&
            typeof replacement?.body === "string"
          )
            room.messages.set(original.id, {
              ...original,
              text: replacement.body,
            });
          continue;
        }
        room.messages.set(event.event_id, {
          id: event.event_id,
          sender: event.sender,
          text: content.body,
          ...(typeof relation?.["m.in_reply_to"]?.event_id === "string" ? { replyTo: relation["m.in_reply_to"].event_id } : {}),
          timestamp: event.origin_server_ts ?? 0,
        });
      }
      while (room.messages.size > 500) {
        room.messages.delete(room.messages.keys().next().value!);
        room.limited = true;
      }
      this.rooms.set(id, room);
    }
    this.cursor = data.next_batch;
    return this.snapshot();
  }
  snapshot(): ConversationView[] {
    const views = [...this.rooms].flatMap(([id, room]) => {
      const participants = [...room.members].filter(([, membership]) =>
        ["join", "invite"].includes(membership),
      );
      const agents = participants.flatMap(([member]) => {
        const agent = this.owned.get(member);
        return agent ? [agent] : [];
      });
      if (!agents.length) return [];
      // A direct chat has only the owner and one employee; anything else is a group.
      const group = room.group === true || agents.length > 1 || participants.some(
        ([member]) => member !== this.session.owner && !this.owned.has(member),
      );
      const messages = [...room.messages.values()].sort((a, b) => a.timestamp - b.timestamp);
      return [{
        id,
        title: group ? room.name || agents.map((agent) => agent.name).join("、") : agents[0]!.name,
        agentId: agents[0]!.id,
        agentIds: agents.map((agent) => agent.id),
        group,
        participants: participants.length,
        messages,
        limited: room.limited,
      }];
    });
    // One direct chat per employee, as in OpenGrove: the most recently active room.
    // Older duplicate rooms stay on the server and keep their history.
    const latest = (view: ConversationView) => view.messages.at(-1)?.timestamp ?? 0;
    const direct = new Map<string, ConversationView>();
    for (const view of views) {
      if (view.group) continue;
      const kept = direct.get(view.agentId);
      if (!kept || latest(view) > latest(kept)) direct.set(view.agentId, view);
    }
    return views
      .filter((view) => view.group || direct.get(view.agentId) === view)
      .sort((a, b) => latest(b) - latest(a));
  }
  async start(agentId: string): Promise<string> {
    const agent = [...this.owned.values()].find(
      (agent) => agent.id === agentId,
    );
    if (!agent) throw new ApiError("agent_not_found", 404);
    if (!this.cursor) await this.sync();
    const existing = this.snapshot().find((room) => !room.group && room.agentId === agentId);
    if (existing) return existing.id;
    const result = await this.api<{ room_id: string }>("/createRoom", {
      body: {
        is_direct: true,
        preset: "trusted_private_chat",
        invite: [agent.matrixId],
      },
    });
    if (typeof result.room_id !== "string")
      throw new ApiError("invalid_response", 200);
    this.rooms.set(result.room_id, {
      members: new Map([
        [agent.matrixId, "invite"],
        [this.session.owner, "join"],
      ]),
      messages: new Map(),
      limited: false,
    });
    return result.room_id;
  }
  /** Created with the owner's account so the owner administers the room and invites are trusted. */
  async createGroup(name: string, agentIds: string[]): Promise<string> {
    const agents = agentIds.map((id) => [...this.owned.values()].find((agent) => agent.id === id));
    if (!agents.length || agents.some((agent) => !agent)) throw new ApiError("agent_not_found", 404);
    const result = await this.api<{ room_id: string }>("/createRoom", {
      body: {
        preset: "private_chat",
        ...(name.trim() ? { name: name.trim() } : {}),
        invite: agents.map((agent) => agent!.matrixId),
        // Marks the room as a group for Mau and Router regardless of member count.
        initial_state: [{ type: "ai.mau.room", state_key: "", content: { kind: "group" } }],
      },
    });
    if (typeof result.room_id !== "string")
      throw new ApiError("invalid_response", 200);
    this.rooms.set(result.room_id, {
      ...(name.trim() ? { name: name.trim() } : {}),
      group: true,
      members: new Map([
        [this.session.owner, "join"],
        ...agents.map((agent) => [agent!.matrixId, "invite"] as [string, string]),
      ]),
      messages: new Map(),
      limited: false,
    });
    return result.room_id;
  }
  async send(
    roomId: string,
    text: string,
    transactionId: string,
    mentions?: ConversationMentions,
  ): Promise<void> {
    if (!this.rooms.has(roomId))
      throw new ApiError("conversation_not_found", 404);
    if (!text.trim()) throw new ApiError("message_empty", 400);
    // Matrix intentional mentions tell each employee's Router whether it was addressed.
    const userIds = (mentions?.agentIds ?? []).flatMap((id) => {
      const agent = [...this.owned.values()].find((agent) => agent.id === id);
      return agent ? [agent.matrixId] : [];
    });
    const result = await this.api<{ event_id: string }>(
      `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
      { method: "PUT", body: { msgtype: "m.text", body: text,
        ...(mentions ? { "m.mentions": { ...(userIds.length ? { user_ids: userIds } : {}), ...(mentions.all ? { room: true } : {}) } } : {}) } },
    );
    if (typeof result.event_id !== "string")
      throw new ApiError("invalid_response", 200);
    // Server acknowledgment confirms acceptance. Replies still arrive only through Matrix sync.
    this.rooms.get(roomId)?.messages.set(result.event_id, {
      id: result.event_id,
      sender: this.session.owner,
      text,
      timestamp: Date.now(),
    });
  }
}
