import { expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dictionaries, errorMessage, errorSentence, failureMessage, translator, type MessageKey } from "../web/src/i18n";
import { ApiError } from "../web/src/api/http";

it("never throws for a label the server introduced later, such as a new channel kind", () => {
  const zh = translator("zh-CN"), en = translator("en");
  expect(zh("channel.bark" as MessageKey)).toBe("Bark 推送");
  expect(zh("channel.some-new-kind" as MessageKey)).toBe("some-new-kind");
  expect(en("channel.some-new-kind" as MessageKey)).toBe("some-new-kind");
});

it("says a shared-environment refusal in words in both languages, naming the partners the server sent", () => {
  const zh = translator("zh-CN"), en = translator("en");
  const helper = { id: "a-1", name: "helper" }, trip = { id: "a-2", name: "trip" };
  const refusals: Array<[ApiError, string, string]> = [
    [new ApiError("environment_share_target_unavailable", 409), "这个伙伴的环境已不可用，请换一个伙伴或使用独立环境。",
      "That partner's environment is no longer available. Choose another partner or an own environment."],
    [new ApiError("environment_share_chain_not_allowed", 409), "这个伙伴用的是别的伙伴的环境，不能再与它共用。",
      "That partner runs in another partner's environment, so it cannot be shared with."],
    [new ApiError("environment_shared_by_partners", 409, { partners: [helper, trip] }), "这个环境还在与 helper、trip 共用，请先删除共用的伙伴。",
      "This environment is still shared with helper, trip. Delete the sharing partners first."],
    [new ApiError("environment_shared_by_partners", 409, { partners: [] }), "还有伙伴在共用这个环境，请先删除共用的伙伴。",
      "Other partners still share this environment. Delete those partners first."],
    [new ApiError("environment_shared_from_partner", 409, { partner: helper }), "这个环境属于 helper，请到 helper 的资料里操作。",
      "This environment belongs to helper. Manage it from the profile of helper."],
    [new ApiError("environment_shared_from_partner", 409), "这个伙伴用的是别的伙伴的环境，请到那个伙伴的资料里操作。",
      "This partner runs in another partner's environment. Manage it from that partner's profile."],
    // A partner sharing an environment runs on a kernel its profile offers, whose runtime is available there.
    [new ApiError("environment_kernel_not_available", 409), "这个环境不提供所选的内核，请换一个内核。", "That environment does not offer the chosen kernel. Choose another kernel."],
    [new ApiError("environment_kernel_not_ready", 409), "所选内核的运行时现在在这个环境里不可用，请换一个内核或稍后再试。",
      "The chosen kernel's runtime is not available in that environment right now. Choose another kernel or try again later."],
    [new ApiError("agent_duty_immutable", 409), "职责在创建伙伴时确定，之后不能修改。", "A partner's duty is set when it is created and cannot be changed."],
    [new ApiError("connector_assigned_through_partner", 409, { partner: helper }), "这个连接分配给了 helper，请通过 helper 设置。",
      "This connection is assigned to helper. Set it up through helper."],
    [new ApiError("connector_assigned_through_partner", 409), "这个连接分配给了共用环境的伙伴，请通过那个伙伴设置。",
      "This connection is assigned to the partner whose environment is shared. Set it up through that partner."],
  ];
  for (const [error, chinese, english] of refusals) {
    expect(failureMessage(zh, error)).toBe(chinese);
    expect(failureMessage(en, error)).toBe(english);
  }
  // A code without a sentence still shows as the generic failure, and a failure that is not the server's as a failed request.
  expect(failureMessage(zh, new ApiError("some_new_code", 409, { partner: helper }))).toBe("操作失败（some_new_code）");
  expect(failureMessage(en, new Error("offline"))).toBe("Operation failed (request_failed)");
  expect(Object.keys(dictionaries.en).sort()).toEqual(Object.keys(dictionaries["zh-CN"]).sort());
});

it("says every refusal of the partners tool, of dismissing and of the memory document in words, in both languages", () => {
  const zh = translator("zh-CN"), en = translator("en");
  // Every code `src/partners.ts` gives a call of the tool, read from the source so that a new one cannot be missed.
  // Its other names of this form are the collections it stores in and the events it logs for operators.
  const source = readFileSync(new URL("../src/partners.ts", import.meta.url), "utf8");
  const internal = ["partner_messages", "partner_returns", "partner_cursors", "partner_recruits", "partner_dismissals", "partner_activity", "partner_failure_wakes",
    "partner_delivery_failed", "partner_settlements_unread", "partner_return_not_submitted", "partner_cards", "partner_cards_unread", "partner_card_not_shown", "partner_sent_roster"];
  const refusals = [...new Set([...source.matchAll(/"(partners?_[a-z_]+)"/g)].map((match) => match[1]!))].filter((code) => !internal.includes(code));
  expect(refusals).toEqual(expect.arrayContaining(["partner_owner_conversation_required", "partner_chain_limit", "partner_layer_limit", "partner_message_limit_reached",
    "partner_unavailable", "partner_not_found", "partner_dismissed", "partner_limit_reached", "partner_recruit_failed", "partners_invalid_input"]));
  // What a message's result may end with, and what the owner's own requests (dismiss, restore, memory) are refused with.
  const others = ["no_answer_after_48_hours", "partner_deleted", "outcome_unknown", "tool_removed", "operation_failed", "agent_not_found", "connected_app_owner_private_only", "owner_approval_unavailable",
    "memory_capacity_exceeded", "memory_duplicate", "memory_no_match", "memory_ambiguous_match", "memory_file_changed", "memory_invalid_content",
    "memory_unsafe_content", "memory_file_unreadable", "memory_directory_unavailable", "memory_write_failed", "memory_undo_conflict", "memory_mutation_already_undone"];
  for (const code of [...refusals, ...others]) for (const t of [zh, en]) {
    expect(errorSentence(t, code), code).toEqual(expect.any(String));
    expect(errorMessage(t, code), code).not.toContain(code);
  }
  expect(errorMessage(zh, "partner_chain_limit")).toBe("伙伴之间已经来回了太多轮，等你发下一条消息后才能继续。");
  // A recruit may name another kernel of the environment: the refusal is about what the environment offers and has running.
  expect(errorMessage(zh, "partner_kernel_not_available")).toBe("这个内核不在环境提供的范围内，或者它的运行时现在不可用。");
  expect(errorMessage(en, "partner_kernel_not_available")).toBe("The kernel is not one the environment offers, or its runtime is not available there now.");
  expect(errorMessage(en, "partner_owner_conversation_required")).toBe("Partners can be recruited, messaged and dismissed only from your private conversation with this partner.");
  expect(errorSentence(zh, "some_new_code")).toBeUndefined();
});

it("the English console says partner, never agent, for the owner's partners", () => {
  // A word of its own: identifiers, class names, paths and package names are not copy.
  const word = /(?<![-.\w@/])agents?(?![-\w:/.])/i;
  expect(Object.entries(dictionaries.en).filter(([, text]) => word.test(text))).toEqual([]);
  // The console's own compiler reads its sources, so that only what is written in string literals is looked at.
  const ts = createRequire(new URL("../web/package.json", import.meta.url))("typescript") as typeof import("../web/node_modules/typescript");
  const root = fileURLToPath(new URL("../web/src/", import.meta.url)), found: string[] = [];
  for (const name of readdirSync(root, { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(name) || name === "i18n.ts") continue;
    // English sentences written beside their Chinese ones: the string literals of the source that have a space in them.
    const tree = ts.createSourceFile(name, readFileSync(root + name, "utf8"), ts.ScriptTarget.Latest, true);
    (function visit(node: import("../web/node_modules/typescript").Node) {
      const text = ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.text : "";
      if (text.includes(" ") && word.test(text) && !/[\u4e00-\u9fff]/.test(text)) found.push(`${name}: ${text}`);
      ts.forEachChild(node, visit);
    })(tree);
  }
  expect(found).toEqual([]);
});
