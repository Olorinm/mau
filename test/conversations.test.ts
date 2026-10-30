import { afterEach, expect, it, vi } from "vitest";
import { MauConversations } from "../web/src/api/conversations";
import type { AgentSummary } from "../web/src/api/client";
const agent: AgentSummary = {
  agent: {
    id: "agent-1",
    owner: "@alice:example.test",
    name: "helper",
    address: "helper:example.test",
    matrixId: "@agent:example.test",
    createdAt: "now",
    status: "active",
  },
  host: null,
  connections: [],
  environment: null,
};
const session = { token: "account-token", owner: "@alice:example.test" };
const member = (id: string, membership = "join") => ({
  type: "m.room.member",
  state_key: id,
  content: { membership },
});
const text = (id: string, sender: string, body: string) => ({
  type: "m.room.message",
  event_id: id,
  sender,
  origin_server_ts: 1,
  content: { msgtype: "m.text", body },
});
afterEach(() => vi.unstubAllGlobals());
it("maps real account sync, filters unrelated rooms, applies edits and uses server cursors", async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const syncs = [
    {
      next_batch: "one",
      rooms: {
        join: {
          owned: {
            state: {
              events: [member(session.owner), member(agent.agent.matrixId)],
            },
            timeline: { events: [text("m1", session.owner, "hello")] },
          },
          unrelated: {
            state: {
              events: [member(session.owner), member("@stranger:example.test")],
            },
            timeline: {
              events: [text("private", "@stranger:example.test", "private")],
            },
          },
        },
      },
    },
    {
      next_batch: "two",
      rooms: {
        join: {
          owned: {
            timeline: {
              events: [
                {
                  ...text("edit", "@agent:example.test", "forged"),
                  content: {
                    msgtype: "m.text",
                    body: "forged",
                    "m.relates_to": { rel_type: "m.replace", event_id: "m1" },
                    "m.new_content": { body: "forged" },
                  },
                },
                text("m2", "@agent:example.test", "response"),
              ],
            },
          },
        },
      },
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return Response.json(
        url.endsWith("/info")
          ? { homeserver: "https://example.test" }
          : syncs.shift(),
      );
    }),
  );
  const api = new MauConversations(session, [agent]);
  expect((await api.sync()).map((room) => room.id)).toEqual(["owned"]);
  expect(
    (await api.sync())[0]!.messages.map((message) => message.text),
  ).toEqual(["hello", "response"]);
  expect(calls[2]![0]).toContain("since=one");
  expect(calls[2]![0]).toContain("timeout=25000");
  expect(calls[1]![1]?.headers).toMatchObject({
    Authorization: "Bearer account-token",
  });
});
it("uses owned Agent identities, never silently reuses a group, and preserves send transaction IDs", async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (url.endsWith("/info"))
        return Response.json({ homeserver: "https://example.test" });
      if (url.includes("/sync?"))
        return Response.json({
          next_batch: "a",
          rooms: {
            join: {
              group: {
                state: {
                  events: [
                    member(session.owner),
                    member(agent.agent.matrixId),
                    member("@colleague:example.test"),
                  ],
                },
                timeline: { events: [] },
              },
            },
          },
        });
      if (url.endsWith("/createRoom"))
        return Response.json({ room_id: "direct" });
      if (url.includes("/send/"))
        return Response.json({ event_id: "accepted" });
      throw new Error("unexpected_request");
    }),
  );
  const api = new MauConversations(session, [agent]);
  await api.sync();
  expect(api.snapshot()[0]).toMatchObject({ group: true, participants: 3 });
  await expect(api.start("not-owned")).rejects.toMatchObject({
    code: "agent_not_found",
  });
  expect(await api.start(agent.agent.id)).toBe("direct");
  const body = JSON.parse(
    String(calls.find(([url]) => url.endsWith("/createRoom"))![1]!.body),
  );
  expect(body.invite).toEqual([agent.agent.matrixId]);
  await expect(
    api.send("unknown", "hello", "transaction"),
  ).rejects.toMatchObject({ code: "conversation_not_found" });
  await api.send("direct", "hello", "transaction");
  await api.send("direct", "hello", "transaction");
  expect(
    calls.filter(([url]) => url.includes("/send/")).map(([url]) => url),
  ).toEqual(
    Array(2).fill(
      "https://example.test/_matrix/client/v3/rooms/direct/send/m.room.message/transaction",
    ),
  );
  expect(
    api.snapshot().find((room) => room.id === "direct")!.messages,
  ).toHaveLength(1);
  expect(
    api.snapshot().find((room) => room.id === "direct")!.messages[0]!.text,
  ).toBe("hello");
});
it("does not invent successful sends and propagates cancellation", async () => {
  const controller = new AbortController();
  let observed: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/info"))
        return Response.json({ homeserver: "https://example.test" });
      if (url.endsWith("/createRoom"))
        return Response.json({ room_id: "direct" });
      if (url.includes("/send/"))
        return Response.json({ errcode: "M_FORBIDDEN" }, { status: 403 });
      observed = init?.signal ?? undefined;
      return Response.json({ next_batch: "cursor" });
    }),
  );
  const api = new MauConversations(session, [agent]);
  await api.start(agent.agent.id);
  await expect(
    api.send("direct", "must not appear", "tx"),
  ).rejects.toMatchObject({ code: "M_FORBIDDEN", status: 403 });
  expect(api.snapshot()[0]!.messages).toEqual([]);
  await api.sync(controller.signal);
  expect(observed?.aborted).toBe(false);
  controller.abort();
  expect(observed?.aborted).toBe(true);
});

it("waits for a pending initial sync before opening an existing direct room", async () => {
  const calls: string[] = [];
  let release!: (value: Response) => void;
  const initial = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/info"))
        return Response.json({ homeserver: "https://example.test" });
      if (url.includes("/sync?")) return initial;
      throw new Error("must_not_create_another_room");
    }),
  );
  const api = new MauConversations(session, [agent]);
  const sync = api.sync();
  const opened = api.start(agent.agent.id);
  await vi.waitFor(() =>
    expect(calls.filter((url) => url.includes("/sync?"))).toHaveLength(1),
  );
  release(
    Response.json({
      next_batch: "first",
      rooms: {
        join: {
          direct: {
            state: {
              events: [member(session.owner), member(agent.agent.matrixId)],
            },
            timeline: { events: [] },
          },
        },
      },
    }),
  );
  await expect(opened).resolves.toBe("direct");
  await sync;
  expect(calls.some((url) => url.endsWith("/createRoom"))).toBe(false);
});
it("requires a successful initial inventory before creating a room and allows retry", async () => {
  let fail = true;
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/info"))
        return Response.json({ homeserver: "https://example.test" });
      if (url.includes("/sync?"))
        return fail
          ? Response.json({ errcode: "M_UNKNOWN" }, { status: 503 })
          : Response.json({ next_batch: "first" });
      if (url.endsWith("/createRoom"))
        return Response.json({ room_id: "new-direct" });
      throw new Error("unexpected_request");
    }),
  );
  const api = new MauConversations(session, [agent]);
  await expect(api.start(agent.agent.id)).rejects.toMatchObject({
    code: "M_UNKNOWN",
  });
  expect(calls.some((url) => url.endsWith("/createRoom"))).toBe(false);
  fail = false;
  await expect(api.start(agent.agent.id)).resolves.toBe("new-direct");
});
it("keeps one direct chat per employee titled by the employee, lists groups and sends group mentions", async () => {
  const second: AgentSummary = { ...agent, agent: { ...agent.agent, id: "agent-2", name: "writer", matrixId: "@writer:example.test" } };
  const bodies: Array<{ url: string; body: any }> = [];
  const at = (id: string, sender: string, body: string, ts: number) => ({ ...text(id, sender, body), origin_server_ts: ts });
  const nameEvent = (name: string) => ({ type: "m.room.name", state_key: "", content: { name } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/info")) return Response.json({ homeserver: "https://example.test" });
    if (url.includes("/sync?")) return Response.json({ next_batch: "a", rooms: { join: {
      oldDirect: { state: { events: [nameEvent("旧脚本房间"), member(session.owner), member(agent.agent.matrixId)] }, timeline: { events: [at("o1", session.owner, "old", 10)] } },
      newDirect: { state: { events: [nameEvent("旧脚本房间"), member(session.owner), member(agent.agent.matrixId)] }, timeline: { events: [at("n1", session.owner, "new", 20)] } },
      left: { state: { events: [member(session.owner), member(agent.agent.matrixId, "leave")] }, timeline: { events: [] } },
      team: { state: { events: [member(session.owner), member(agent.agent.matrixId), member(second.agent.matrixId)] }, timeline: { events: [at("t1", session.owner, "hi team", 15)] } },
      solo: { state: { events: [{ type: "ai.mau.room", state_key: "", content: { kind: "group" } }, nameEvent("项目群"), member(session.owner), member(agent.agent.matrixId)] }, timeline: { events: [at("s1", session.owner, "solo", 12)] } },
    } } });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    bodies.push({ url, body });
    if (url.endsWith("/createRoom")) return Response.json({ room_id: "created" });
    if (url.includes("/send/")) return Response.json({ event_id: "sent" });
    throw new Error("unexpected_request");
  }));
  const api = new MauConversations(session, [agent, second]);
  const rooms = await api.sync();
  expect(rooms.map((room) => [room.id, room.title, room.group])).toEqual([["newDirect", "helper", false], ["team", "helper、writer", true], ["solo", "项目群", true]]);
  expect(rooms.find((room) => room.id === "team")!.agentIds).toEqual(["agent-1", "agent-2"]);
  expect(await api.start("agent-1")).toBe("newDirect");
  expect(await api.createGroup("Launch", ["agent-1", "agent-2"])).toBe("created");
  expect(bodies.find((item) => item.url.endsWith("/createRoom"))!.body).toEqual({ preset: "private_chat", name: "Launch", invite: ["@agent:example.test", "@writer:example.test"],
    initial_state: [{ type: "ai.mau.room", state_key: "", content: { kind: "group" } }] });
  expect(api.snapshot().find((room) => room.id === "created")).toMatchObject({ group: true, title: "Launch" });
  await api.send("team", "@writer please draft", "txn-1", { agentIds: ["agent-2"], all: false });
  await api.send("team", "@所有人 status?", "txn-2", { agentIds: [], all: true });
  await api.send("newDirect", "plain", "txn-3");
  const sends = bodies.filter((item) => item.url.includes("/send/")).map((item) => item.body);
  expect(sends[0]["m.mentions"]).toEqual({ user_ids: ["@writer:example.test"] });
  expect(sends[1]["m.mentions"]).toEqual({ room: true });
  expect(sends[2]["m.mentions"]).toBeUndefined();
  // A hidden duplicate direct room still accepts sends; its history stays on the server.
  await expect(api.send("oldDirect", "still there", "txn-4")).resolves.toBeUndefined();
});
