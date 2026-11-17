import { expect, it } from "vitest";
import { dictionaries, failureMessage, translator, type MessageKey } from "../web/src/i18n";
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
