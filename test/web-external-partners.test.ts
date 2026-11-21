import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, expect as see, type Page } from "@playwright/test";
import { linkComputer } from "./fixtures/host-links.js";
import { partnersFixture, type PartnersFixture } from "./fixtures/partners.js";

// Browser acceptance, in the built console, of a partner that is an agent on the owner's computer: creating it,
// its pairing code, its device in place of an environment, and what its profile leaves out.
const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));
const built = existsSync(webRoot + "index.html");
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });

async function browser(f: PartnersFixture) {
  const instance = await chromium.launch({ headless: true });
  cleanup.push(() => instance.close());
  const context = await instance.newContext({ locale: "zh-CN", reducedMotion: "reduce", viewport: { width: 1200, height: 900 }, extraHTTPHeaders: f.edgeHeaders() });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { page, errors };
}
const chip = (page: Page, agentId: string) => page.locator(`.mau-chip[data-chat-key="agent:${agentId}"]`);
const profile = (page: Page) => page.getByRole("complementary", { name: "伙伴资料" });
const tabs = (page: Page) => profile(page).getByRole("group", { name: "伙伴资料分类" }).getByRole("button");
const tab = (page: Page, name: string) => profile(page).getByRole("group", { name: "伙伴资料分类" }).getByRole("button", { name, exact: true });
const roster = (page: Page) => page.getByRole("complementary", { name: "全部对话" });

it.skipIf(!built)("creates a partner on the owner's computer, shows its pairing code once, then its device in place of an environment", async () => {
  const f = await partnersFixture(cleanup, { webRoot }), links = f.mau.router.hostLinks;
  const { page, errors } = await browser(f);
  const posted: unknown[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/_mau/v1/agents")) posted.push(request.postDataJSON()); });
  await page.goto(f.base + "?agent=" + encodeURIComponent(f.agent.id));
  await see(chip(page, f.agent.id)).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "全部对话", exact: true }).click();
  await roster(page).getByRole("button", { name: "新建伙伴", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建伙伴" });
  await dialog.getByLabel("名称").fill("laptop");
  await dialog.getByLabel("职责").fill("在我的笔记本上整理文件");
  // The third kind has nothing more to choose: no profile, no partner to share with.
  await dialog.getByRole("group", { name: "环境类型" }).getByRole("button", { name: "我的电脑", exact: true }).click();
  await see(dialog.getByRole("group", { name: "环境类型" }).getByRole("button", { name: "我的电脑", exact: true })).toHaveAttribute("aria-pressed", "true");
  await see(dialog.locator(".partner-dialog-kernel-option")).toHaveCount(0);
  await see(dialog.getByRole("combobox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "创建" }).click();
  // The code and the command are shown once, with the partner already made.
  const pairing = page.getByRole("dialog", { name: "laptop" });
  await see(pairing.locator(".mau-pairing-code-value")).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const first = await pairing.locator(".mau-pairing-code-value").innerText();
  await see(pairing.locator(".mau-pairing-command")).toHaveText(`agent-host link --config host.json --url http://127.0.0.1 --code ${first}`);
  await see(pairing.locator(".agent-status-line")).toHaveText("等待配对");
  expect(posted).toEqual([{ name: "laptop", kind: "external", duty: "在我的笔记本上整理文件" }]);
  await pairing.getByRole("button", { name: "完成" }).click();
  const laptop = f.partner("laptop");
  await see(chip(page, laptop.id)).toHaveAttribute("aria-selected", "true");
  // A message written before a computer is paired waits, and the conversation says for what.
  await page.getByRole("textbox").last().fill("在吗？");
  await page.keyboard.press("Enter");
  const stream = page.locator(".room-chat-stream");
  await see(stream.locator(".room-chat-thinking")).toHaveText("等待配对");

  // Its profile: a device where the others have an environment, and neither capabilities nor documents.
  await chip(page, laptop.id).click();
  const card = profile(page), row = (title: string) => card.locator(".agent-list-row").filter({ has: page.locator(".agent-list-row-title", { hasText: new RegExp(`^${title}$`) }) });
  await see(card.getByRole("heading", { name: "laptop" })).toBeVisible();
  await see(tabs(page)).toHaveCount(3);
  for (const name of ["状态", "消息渠道", "配置"]) await see(tab(page, name)).toBeVisible();
  for (const name of ["能力", "文档"]) await see(tab(page, name)).toHaveCount(0);
  await see(card.getByRole("heading", { name: "设备" })).toBeVisible();
  await see(card.getByRole("heading", { name: "运行环境" })).toHaveCount(0);
  await see(row("状态")).toContainText("等待配对");
  await see(row("配置环境 · Cloud")).toHaveCount(0);
  await see(row("解除配对")).toHaveCount(0);
  // A new code from the profile; the computer that uses it becomes the device.
  await row("生成配对码").click();
  await see(card.locator(".mau-pairing-code-value")).not.toHaveText(first);
  const computer = await linkComputer(f.base, await card.locator(".mau-pairing-code-value").innerText(), cleanup, { name: "work-laptop", platform: "win32" });
  await see(row("状态")).toContainText("在线");
  await see(row("设备名")).toContainText("work-laptop");
  await see(row("平台")).toContainText("win32");
  await see(row("内核")).toContainText("claude");
  await see(row("最近在线")).toBeVisible();
  await see(card.locator(".mau-pairing-code-value")).toHaveCount(0);
  await see(row("重新配对")).toBeVisible();
  // The list says online or offline, never an environment state.
  computer.disconnect();
  await see(row("状态")).toContainText("离线", { timeout: 15_000 });

  // Configuration: its kernel, and neither a model nor an environment to destroy.
  await tab(page, "配置").click();
  await see(row("内核")).toContainText("claude");
  await see(row("模型")).toHaveCount(0);
  await see(row("方案")).toHaveCount(0);
  await see(row("销毁环境")).toHaveCount(0);
  await see(row("解散伙伴")).toBeVisible();
  await see(row("删除伙伴")).toBeVisible();
  await row("编辑名称和描述").click();
  await card.getByLabel("名称", { exact: true }).fill("Mac");
  await card.getByLabel("描述", { exact: true }).fill("My workstation");
  await card.getByRole("button", { name: "保存", exact: true }).click();
  await see(card.getByRole("heading", { name: "Mac", exact: true })).toBeVisible();
  await see(card.getByText("My workstation", { exact: true })).toBeVisible();
  // Unpairing asks first, then leaves the partner waiting for a computer.
  await tab(page, "状态").click();
  await row("解除配对").click();
  await page.getByRole("dialog", { name: "解除 Mac 的配对？" }).getByRole("button", { name: "解除配对", exact: true }).click();
  await see(row("状态")).toContainText("等待配对");
  expect(links.get(laptop.id)).toBeUndefined();
  // The list says waiting, online or offline, never an environment state.
  await card.getByRole("button", { name: "收起", exact: true }).click();
  const state = chip(page, laptop.id).locator("small");
  await see(state).toHaveText("等待配对");
  const again = await linkComputer(f.base, (await f.api(`/agents/${laptop.id}/device/pair`, {})).data.code, cleanup);
  await see(state).toHaveText("在线", { timeout: 15_000 });
  again.disconnect();
  await see(state).toHaveText("离线", { timeout: 15_000 });
  await see(chip(page, laptop.id).locator(".agent-pixel-avatar")).toHaveAttribute("data-state", "offline");
  expect(errors).toEqual([]);
}, 90_000);
