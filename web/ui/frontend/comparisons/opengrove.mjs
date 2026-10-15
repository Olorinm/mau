import assert from "node:assert/strict";
const target = (label, url, revision) => ({
  label,
  url,
  revision,
  ready: async ({ page }) => {
    await page.locator(".app-shell").waitFor();
  },
});
async function navigate(page, name) {
  const button = page.getByRole("button", { name, exact: true });
  if (!(await button.isVisible()))
    await page.getByRole("button", { name: /展开主导航|展开导航/ }).click();
  await button.click();
}
async function appearance({ page, check, capture }) {
  await navigate(page, "设置");
  await page.getByRole("button", { name: "外观", exact: true }).click();
  const select = page
    .locator(".settings-preference-row")
    .first()
    .getByRole("button");
  await select.click();
  await page.getByRole("option", { name: "浅色", exact: true }).click();
  await check("theme selection updates the control", async () =>
    assert.equal(await select.innerText(), "浅色"),
  );
  await capture("light", { selector: ".settings-screen-content" });
  await capture("page", { informational: true });
  await select.click();
  await check("theme menu opens", async () =>
    assert.equal(await page.getByRole("listbox").isVisible(), true),
  );
  await capture("theme-menu", { selector: '[role="listbox"]' });
  await page.keyboard.press("Escape");
  await check("Escape closes the menu", async () => {
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("listbox").count(), 0);
  });
  await select.click();
  await page.getByRole("option", { name: "深色", exact: true }).click();
  await check("dark selection updates the control", async () =>
    assert.equal(await select.innerText(), "深色"),
  );
  await capture("dark", { selector: ".settings-screen-content" });
}
async function conversation({ page, check, capture }) {
  await navigate(page, "员工");
  await page.locator(".room-composer textarea").waitFor();
  const input = page.locator(".room-composer textarea");
  await input.fill("界面对照测试");
  await check("typing enables Send", async () =>
    assert.equal(
      await page
        .getByRole("button", { name: "发送消息", exact: true })
        .isEnabled(),
      true,
    ),
  );
  await capture("composer", { selector: ".room-composer" });
  await input.dispatchEvent("compositionstart");
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    bubbles: true,
  });
  await input.dispatchEvent("compositionend");
  await input.press("Enter");
  await check("IME confirmation preserves the draft", async () =>
    assert.equal(await input.inputValue(), "界面对照测试"),
  );
  await page.getByRole("button", { name: "搜索聊天记录", exact: true }).click();
  await check("message search opens", async () => {
    await page.locator(".room-message-search-field input").waitFor();
    assert.equal(
      await page.locator(".room-message-search-field input").isVisible(),
      true,
    );
  });
  await page.keyboard.press("Escape");
  await check("Escape closes message search", async () => {
    await page
      .locator(".room-message-search-field input")
      .waitFor({ state: "hidden" });
    assert.equal(
      await page.locator(".room-message-search-field input").count(),
      0,
    );
  });
  await capture("page", { informational: true });
}

async function createApp({ page, check, capture }) {
  await navigate(page, "新建应用");
  const dialog = page.getByRole("dialog", { name: "新建应用", exact: true });
  await dialog.waitFor();
  await check("create opens over the current page", async () =>
    assert.equal(await dialog.isVisible(), true),
  );
  await capture("dialog", { selector: ".app-create-dialog" });
  await dialog
    .getByRole("textbox", { name: "App 名称", exact: true })
    .fill("对照应用");
  await dialog
    .getByRole("textbox", { name: "描述", exact: true })
    .fill("相同输入和界面行为");
  await check("typing a name enables creation", async () =>
    assert.equal(
      await dialog
        .getByRole("button", { name: "创建并打开", exact: true })
        .isEnabled(),
      true,
    ),
  );
  await dialog
    .getByRole("button", { name: "更换 App 图标", exact: true })
    .click();
  await check("icon picker opens within the dialog", async () => {
    await page.getByPlaceholder("搜索图标").waitFor();
    assert.equal(await page.getByPlaceholder("搜索图标").isVisible(), true);
  });
  await capture("icons", { selector: ".app-create-dialog" });
  await page.keyboard.press("Escape");
  await check("Escape returns to the form", async () => {
    await page.getByPlaceholder("搜索图标").waitFor({ state: "hidden" });
    assert.equal(
      await dialog
        .getByRole("textbox", { name: "App 名称", exact: true })
        .inputValue(),
      "对照应用",
    );
  });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await check("cancel closes the dialog", async () => {
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("dialog").count(), 0);
  });
  await navigate(page, "新建应用");
  await check("reopening starts with an empty draft", async () => {
    await dialog.waitFor();
    assert.equal(
      await dialog
        .getByRole("textbox", { name: "App 名称", exact: true })
        .inputValue(),
      "",
    );
  });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
}

export default {
  description:
    "Original OpenGrove at 8b365ed versus published-component stories. Same viewport, locale, inputs and UI actions. Full pages include product differences and are review-only; named component regions are gated without masks.",
  locale: "zh-CN",
  maxDiffRatio: 0.002,
  targets: [
    target(
      "OpenGrove original · live",
      process.env.ORIGINAL_UI_URL ?? "http://127.0.0.1:4176/",
      "8b365ed",
    ),
    target(
      "Extracted components · story",
      process.env.CANDIDATE_UI_URL ?? "http://127.0.0.1:4177/stories.html",
      "working tree",
    ),
  ],
  scenarios: [
    {
      name: "appearance-desktop",
      viewport: { width: 1280, height: 800 },
      run: appearance,
    },
    {
      name: "appearance-mobile",
      viewport: { width: 390, height: 844 },
      run: appearance,
    },
    {
      name: "conversation-desktop",
      viewport: { width: 1280, height: 800 },
      run: conversation,
    },
    {
      name: "create-desktop",
      viewport: { width: 1280, height: 800 },
      run: createApp,
    },
    {
      name: "create-mobile",
      viewport: { width: 390, height: 844 },
      run: createApp,
    },
  ],
};
