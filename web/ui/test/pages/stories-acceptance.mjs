import { chromium, expect } from "@playwright/test";
export async function checkStories(base) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ locale: "zh-CN" });
    await page.goto(new URL("stories.html", base).href);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型提供方", exact: true }).click();
    await page.getByRole("button", { name: /示例服务.*1 个模型/ }).click();
    const detail = page.locator(".settings-provider-detail");
    const secret = detail.locator('input[type="password"]');
    await secret.fill("example-only");
    await detail
      .getByRole("button", { name: "显示 API Key", exact: true })
      .click();
    await expect(detail.locator('input[value="example-only"]')).toHaveAttribute(
      "type",
      "text",
    );
    await detail.getByRole("button", { name: "添加模型", exact: true }).click();
    await expect(
      detail.getByRole("textbox", { name: "模型", exact: true }),
    ).toHaveCount(2);
    await page.getByRole("button", { name: "运行中心", exact: true }).click();
    const run = page.locator(".ops-settings-run-entry");
    await run.locator("summary").first().click();
    await expect(run).toHaveAttribute("open", "");
    await run.locator("summary").first().click();
    await expect(run).not.toHaveAttribute("open");
    await page.getByRole("button", { name: "新建应用", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await expect(run).not.toHaveAttribute("open");
    console.log(
      "Provider secret visibility/model editing and controlled operation disclosure passed.",
    );
  } finally {
    await browser.close();
  }
}
