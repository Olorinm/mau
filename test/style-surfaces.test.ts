import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, expect as see, type Page, type Locator } from "@playwright/test";
import { mauFixture } from "./fixtures/mau.js";

const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));
const built = existsSync(webRoot + "index.html");
if (!built && process.env.MAU_WEB_E2E === "1") throw new Error("web_console_build_required");
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });

async function capture(page: Page, id: string) {
  const dir = process.env.MAU_STYLE_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${dir}/${id}.png`, animations: "disabled", caret: "hide" });
  const data = await page.evaluate(() => [...document.querySelectorAll("body, body *")]
    .filter(el => !["SCRIPT", "STYLE", "LINK"].includes(el.tagName))
    .map(el => {
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      return { tag: el.tagName, classes: el.className, box: [r.x, r.y, r.width, r.height],
        background: cs.backgroundColor, color: cs.color, font: cs.fontSize, radius: cs.borderRadius };
    }));
  writeFileSync(`${dir}/${id}.json`, JSON.stringify(data));
}
async function pageSurface(dialog: Locator, dark: boolean) {
  const values = await dialog.evaluate(el => {
    const style = getComputedStyle(el);
    const rgb = document.createElement("canvas").getContext("2d")!;
    rgb.fillStyle = style.backgroundColor; rgb.fillRect(0, 0, 1, 1);
    return { background: [...rgb.getImageData(0, 0, 1, 1).data], token: style.getPropertyValue("--c-page").trim() };
  });
  expect(values.background[3]).toBe(255);
  const brightness = Math.max(...values.background.slice(0, 3));
  if (dark) expect(brightness).toBeLessThan(90); else expect(brightness).toBeGreaterThan(230);
  if (!dark) return;
  // A dark dialog has the page colour: the scrim behind it has to dim the page clearly.
  const scrims = await dialog.page().evaluate(() => [...document.querySelectorAll(".modal-overlay, .agent-modal-overlay")].map(el => {
    const rgb = document.createElement("canvas").getContext("2d")!;
    rgb.fillStyle = getComputedStyle(el).backgroundColor; rgb.fillRect(0, 0, 1, 1);
    return rgb.getImageData(0, 0, 1, 1).data[3] / 255;
  }));
  expect(scrims.length).toBeGreaterThan(0);
  for (const alpha of scrims) expect(alpha).toBeGreaterThanOrEqual(0.5);
}

for (const mode of ["light", "dark", "system"] as const) for (const width of [390, 900, 1440]) {
  it.skipIf(!built)(`keeps console dialogs readable and interactive: ${mode} at ${width}`, async () => {
    const f = await mauFixture(cleanup, { webRoot }, {});
    await f.api(f.path, { profileId: "cloud" }); expect((await f.settled()).state).toBe("ready");
    const instance = await chromium.launch({ headless: true }); cleanup.push(() => instance.close());
    const context = await instance.newContext({ viewport: { width, height: 900 }, locale: "zh-CN", reducedMotion: "reduce",
      colorScheme: mode === "light" ? "light" : "dark", extraHTTPHeaders: f.edgeHeaders() });
    await context.addInitScript(theme => localStorage.setItem("mau.theme", theme), mode);
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.route("**/_mau/v1/connector-accounts**", route => route.fulfill({ json: { configured: true, data: [
      { id: "work-gmail", kind: "google", label: "Gmail", state: "authorization_required", verification: "none", scopes: [], assignedAgents: [f.agent.id], permission: "read-only" },
    ] } }));
    await page.goto(f.base);
    await page.locator(`.mau-roster-row[data-chat-key="agent:${f.agent.id}"]`).click();
    const composer = page.getByPlaceholder("发送消息…"); await see(composer).toBeVisible();
    const prefix = `${mode}-${width}`;
    await capture(page, `${prefix}-chat`);
    if (width === 1440) {
      // One row at the top: the mark at its left, the destinations in its middle. The list and the conversation are below it.
      const box = (selector: string) => page.evaluate(q => { const r = document.querySelector(q)!.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }, selector);
      const [mark, bar, list, card] = [await box(".app-mark"), await box(".app-switch"), await box(".mau-roster"), await box(".room-main-panel")];
      expect(mark[0]!).toBeLessThan(40); expect(Math.abs((bar[0]! + bar[2]!) / 2 - 720)).toBeLessThan(2); expect(bar[3]!).toBeLessThan(list[1]!);
      // The list is beside the conversation, never over it.
      expect(list[2]!).toBeLessThanOrEqual(card[0]!); expect(list[1]!).toBe(card[1]!);
      const roster = page.locator(".mau-roster"); await see(roster).toBeVisible();
      await capture(page, `${prefix}-roster`);
      // A partner's profile stands in place of the list and leaves the conversation where it is; back returns to the list.
      await page.locator("button.mau-chat-title").click();
      const profile = page.getByRole("complementary", { name: "伙伴资料" }); await see(profile).toBeVisible();
      expect(await box(".room-main-panel")).toEqual(card); expect(await box(".mau-roster")).toEqual(list);
      await capture(page, `${prefix}-profile`);
      await profile.getByRole("button", { name: "全部对话" }).click();
      await see(page.getByRole("complementary", { name: "全部对话" })).toBeVisible(); await see(composer).toBeVisible();
    }
    if (width === 390) {
      // A phone shows one page at a time. In a conversation the destinations are put away and the name opens the profile.
      const dock = page.getByRole("navigation", { name: "主导航" }), roster = page.locator(".mau-roster");
      await see(dock).toBeHidden(); await see(roster).toBeHidden();
      await page.locator("button.mau-chat-title").click();
      const profile = page.getByRole("complementary", { name: "伙伴资料" }); await see(profile).toBeVisible(); await see(composer).toBeHidden();
      expect(await profile.evaluate(el => el.getBoundingClientRect().width)).toBe(390);
      await capture(page, `${prefix}-profile`);
      // Back from the profile is the conversation; back from the conversation is the list, with the destinations at its foot.
      await profile.getByRole("button", { name: "全部对话" }).click(); await see(composer).toBeVisible();
      await page.getByRole("button", { name: "返回", exact: true }).click();
      await see(roster).toBeVisible(); await see(dock).toBeVisible(); await capture(page, `${prefix}-roster`);
      await see(dock.getByRole("button")).toHaveText(["对话", "应用"]);
      await roster.locator(`.mau-roster-row[data-chat-key="agent:${f.agent.id}"]`).click();
      await see(roster).toBeHidden(); await see(composer).toBeVisible();
    }
    await composer.fill("/"); await see(page.getByRole("listbox", { name: "斜杠命令" })).toBeVisible();
    expect(await composer.evaluate(el => el === document.activeElement && getComputedStyle(el).outlineStyle)).toBe("none");
    await capture(page, `${prefix}-commands`);
    await composer.fill("/clear"); await page.getByRole("option", { name: /\/clear/ }).click();
    const clear = page.getByRole("dialog", { name: "清空聊天记录？" }); await see(clear).toBeVisible();
    await capture(page, `${prefix}-confirm`); await pageSurface(clear, mode !== "light");
    await page.keyboard.press("Tab"); expect(await clear.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await clear.getByRole("button", { name: "取消", exact: true }).click();
    await page.evaluate(() => { location.hash = "#/settings/general"; });
    const settings = page.getByRole("dialog", { name: "设置" }); await see(settings).toBeVisible();
    await see(settings.getByRole("heading", { name: "通用", exact: true })).toBeVisible();
    await capture(page, `${prefix}-settings`); await pageSurface(settings, mode !== "light");
    const language = settings.getByRole("combobox", { name: "语言" }); await language.click();
    await see(page.getByRole("listbox")).toBeVisible(); await capture(page, `${prefix}-language-menu`);
    await page.keyboard.press("Escape"); await language.focus();
    await capture(page, `${prefix}-keyboard-focus`);
    await page.evaluate(() => { location.hash = "#/settings/connectors"; });
    await see(settings.getByRole("button", { name: "连接", exact: true })).toBeVisible();
    await capture(page, `${prefix}-connectors`);
    await settings.getByRole("button", { name: "连接", exact: true }).click();
    const consent = page.getByRole("dialog", { name: "Gmail", exact: true }); await see(consent).toBeVisible();
    await capture(page, `${prefix}-consent`); await pageSurface(consent, mode !== "light");
    await consent.getByRole("button", { name: "取消", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  }, 60_000);
}
