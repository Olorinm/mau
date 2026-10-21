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
  agentId: string;
  group: boolean;
  participants: number;
  messages: ConversationMessage[];
  limited: boolean;
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
    return [...this.rooms].flatMap(([id, room]) => {
      const member = [...room.members].find(
        ([member, membership]) =>
          this.owned.has(member) && ["join", "invite"].includes(membership),
      );
      const agent = member && this.owned.get(member[0]);
      const participants = [...room.members].filter(([, membership]) =>
        ["join", "invite"].includes(membership),
      );
      const group = participants.some(
        ([id]) => id !== this.session.owner && id !== agent?.matrixId,
      );
      return agent
        ? [
            {
              id,
              title: room.name || agent.name,
              agentId: agent.id,
              group,
              participants: participants.length,
              messages: [...room.messages.values()].sort(
                (a, b) => a.timestamp - b.timestamp,
              ),
              limited: room.limited,
            },
          ]
        : [];
    });
  }
  async start(agentId: string): Promise<string> {
    const agent = [...this.owned.values()].find(
      (agent) => agent.id === agentId,
    );
    if (!agent) throw new ApiError("agent_not_found", 404);
    if (!this.cursor) await this.sync();
    const existing = this.snapshot().find(
      (room) =>
        room.agentId === agentId &&
        [...this.rooms.get(room.id)!.members]
          .filter(([, membership]) => ["join", "invite"].includes(membership))
          .every(
            ([id]) =>
              id === this.session.owner || this.owned.get(id)?.id === agentId,
          ),
    );
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
  async send(
    roomId: string,
    text: string,
    transactionId: string,
  ): Promise<void> {
    if (!this.snapshot().some((room) => room.id === roomId))
      throw new ApiError("conversation_not_found", 404);
    if (!text.trim()) throw new ApiError("message_empty", 400);
    const result = await this.api<{ event_id: string }>(
      `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
      { method: "PUT", body: { msgtype: "m.text", body: text } },
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
