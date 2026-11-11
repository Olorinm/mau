import { expect, it } from "vitest";
import { translator, type MessageKey } from "../web/src/i18n";

it("never throws for a label the server introduced later, such as a new channel kind", () => {
  const zh = translator("zh-CN"), en = translator("en");
  expect(zh("channel.bark" as MessageKey)).toBe("Bark 推送");
  expect(zh("channel.some-new-kind" as MessageKey)).toBe("some-new-kind");
  expect(en("channel.some-new-kind" as MessageKey)).toBe("some-new-kind");
});
