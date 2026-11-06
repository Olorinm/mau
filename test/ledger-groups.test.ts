import { afterEach, expect, it, vi } from "vitest";
import {
  addressedLine, groupErrorMessage, groupInputError, groupTitle, groupsApi, isRoomChat, memberEventText, mentionsSomeone,
  noMentionHint, resolveMentions, roomIdOf,
} from "../web/src/api/ledger-groups";

// Router-native groups (agent-router ADR 0005 section 17): the console's API client and mention rules.
afterEach(() => vi.unstubAllGlobals());

function stubFetch(answer: (url: string, init: RequestInit) => Response = () => new Response(JSON.stringify({ ok: true }), { status: 200 })) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { calls.push({ url, init }); return answer(url, init); });
  return calls;
}
const sent = (calls: Array<{ url: string; init: RequestInit }>) =>
  calls.map(({ url, init }) => [init.method, url, init.body === undefined ? undefined : JSON.parse(init.body as string)]);

it("creates, renames, archives and edits members of a room through the group routes", async () => {
  const calls = stubFetch();
  const api = groupsApi("token");
  await api.create({ title: " 周报小组 ", agentIds: ["agent-1", "agent-2"], idempotencyKey: "0123456789abcdef" });
  await api.rename("room:rm_01", "周报");
  await api.archive("room:rm_01");
  await api.addMember("room:rm_01", "agent-3");
  await api.removeMember("room:rm_01", "agent/3");
  await api.room("room:rm_01");
  expect(sent(calls)).toEqual([
    ["POST", "/_agent-router/v1/web/groups", { idempotencyKey: "0123456789abcdef", title: "周报小组", agentIds: ["agent-1", "agent-2"] }],
    ["PATCH", "/_agent-router/v1/web/groups/rm_01", { title: "周报" }],
    ["PATCH", "/_agent-router/v1/web/groups/rm_01", { archived: true }],
    ["POST", "/_agent-router/v1/web/groups/rm_01/members", { agentId: "agent-3" }],
    ["DELETE", "/_agent-router/v1/web/groups/rm_01/members/agent%2F3", undefined],
    ["GET", "/_agent-router/v1/web/chats/room%3Arm_01", undefined],
  ]);
  expect(calls.every(({ init }) => (init.headers as Record<string, string>).Authorization === "Bearer token" && init.credentials === "same-origin")).toBe(true);
});

it("generates an idempotency key per create and validates input before calling Router", async () => {
  const calls = stubFetch();
  const api = groupsApi("token");
  await api.create({ title: "t", agentIds: ["a"] });
  expect(JSON.parse(calls[0]!.init.body as string).idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  await expect(api.create({ title: "  ", agentIds: ["a"] })).rejects.toMatchObject({ code: "invalid_group_title" });
  await expect(api.create({ title: "x".repeat(65), agentIds: ["a"] })).rejects.toMatchObject({ code: "invalid_group_title" });
  await expect(api.create({ title: "t", agentIds: [] })).rejects.toMatchObject({ code: "invalid_group_members" });
  await expect(api.create({ title: "t", agentIds: ["a", "a"] })).rejects.toMatchObject({ code: "invalid_group_members" });
  await expect(api.create({ title: "t", agentIds: Array.from({ length: 21 }, (_, i) => "a" + i) })).rejects.toMatchObject({ code: "too_many_members" });
  await expect(api.rename("room:rm_01", "")).rejects.toMatchObject({ code: "invalid_group_title" });
  // A DM chat id is never sent to the group routes.
  await expect(async () => api.addMember("dm:agent-1", "a")).rejects.toMatchObject({ code: "conversation_not_found" });
  expect(calls).toHaveLength(1);
  expect(groupInputError("一".repeat(64), ["a"])).toBeUndefined();
  expect(groupTitle("", ["研究助理", "写作助理"])).toBe("研究助理、写作助理");
  expect([...groupTitle("", Array.from({ length: 30 }, () => "助理"))]).toHaveLength(64);
  expect(roomIdOf("room:rm_01")).toBe("rm_01");
  expect(isRoomChat("room:")).toBe(false);
});

it("surfaces Router group errors as codes with console text", async () => {
  for (const [status, error] of [[422, "agent_not_found"], [429, "room_limit_reached"], [403, "feature_disabled"], [409, "idempotency_key_reused"], [422, "too_many_members"]] as const) {
    stubFetch(() => new Response(JSON.stringify({ error }), { status }));
    await expect(groupsApi("token").create({ title: "t", agentIds: ["a"] })).rejects.toMatchObject({ code: error, status });
  }
  expect(groupErrorMessage("room_limit_reached", true)).toContain("100");
  expect(groupErrorMessage("mention_not_member", false)).toContain("no longer in this group");
  expect(groupErrorMessage("idempotency_key_reused", true)).toBeUndefined();
});

it("resolves mentions client-side: longest member name, ASCII word boundaries and @所有人", () => {
  const members = [{ id: "a1", name: "研究" }, { id: "a2", name: "研究助理" }, { id: "a3", name: "bob" }, { id: "a4", name: "Bob Smith" }];
  expect(resolveMentions("@研究助理 帮我查一下", members)).toEqual({ agentIds: ["a2"], all: false });
  expect(resolveMentions("@研究帮我查", members)).toEqual({ agentIds: ["a1"], all: false });
  expect(resolveMentions("@bobby hi", members)).toEqual({ agentIds: [], all: false });
  expect(resolveMentions("@Bob Smith and @bob, hi", members)).toEqual({ agentIds: ["a4", "a3"], all: false });
  expect(resolveMentions("@所有人 早", members)).toEqual({ agentIds: [], all: true });
  expect(resolveMentions("@all hi", members).all).toBe(true);
  expect(resolveMentions("@allen hi", members).all).toBe(false);
  // Not a member: plain text, never addressed.
  expect(resolveMentions("@写作助理 你好", members)).toEqual({ agentIds: [], all: false });
  expect(mentionsSomeone(resolveMentions("大家好", members))).toBe(false);
  // Same display name: both agents are addressed.
  expect(resolveMentions("@twin", [{ id: "x", name: "twin" }, { id: "y", name: "twin" }]).agentIds).toEqual(["x", "y"]);
});

it("describes the addressed state, stored mentions and member events", () => {
  const names = new Map([["a1", "研究助理"], ["a2", "写作助理"]]);
  const nameOf = (id: string) => names.get(id) ?? id;
  expect(addressedLine([{ agentId: "a1", state: "queued" }, { agentId: "a2", state: "not_addressed" }], undefined, nameOf, true)).toBe("已通知：研究助理");
  expect(addressedLine([{ agentId: "a1", state: "delivered" }, { agentId: "a2", state: "failed" }], undefined, nameOf, false))
    .toBe("delivered: 研究助理 · not delivered: 写作助理");
  expect(addressedLine([{ agentId: "a1", state: "not_addressed" }], undefined, nameOf, true)).toBe(noMentionHint(true));
  expect(addressedLine(undefined, { agentIds: ["a2"], all: false }, nameOf, true)).toBe("@写作助理");
  expect(addressedLine(undefined, { agentIds: [], all: true }, nameOf, true)).toBe("@所有人");
  expect(addressedLine(undefined, { agentIds: [], all: false }, nameOf, true)).toBe("未 @ 任何 Agent，消息只记录");
  // Imported or older messages carry no mentions: nothing is claimed about them.
  expect(addressedLine(undefined, undefined, nameOf, true)).toBe("");
  const member = { type: "agent" as const, id: "a1", name: "研究助理" };
  expect(memberEventText({ action: "add", member }, true)).toBe("研究助理 加入了群聊");
  expect(memberEventText({ action: "remove", member }, true)).toBe("研究助理 已移出群聊");
  expect(memberEventText({ action: "rename", title: "周报" }, true)).toBe("群聊名称改为“周报”");
});
