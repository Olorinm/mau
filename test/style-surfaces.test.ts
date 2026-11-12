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
    const f = await mauFixture(cleanup, { webRoot }, {}, { ledgerRead: true, ledgerSend: true, ledgerCards: true, ledgerControl: true });
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
    await page.locator(`.mau-chip[data-chat-key="agent:${f.agent.id}"]`).click();
    const composer = page.getByPlaceholder("发送消息…"); await see(composer).toBeVisible();
    const prefix = `${mode}-${width}`;
    await capture(page, `${prefix}-chat`);
    if (width === 1440) {
      // The brand sits above the navigation, so the conversation card starts at the top of the window.
      const top = await page.evaluate(() => ({ bar: document.querySelector(".app-titlebar")!.getBoundingClientRect().width,
        card: document.querySelector(".room-main-panel")!.getBoundingClientRect().top }));
      expect(top.bar).toBeLessThan(200); expect(top.card).toBeLessThan(16);
      // The people panel floats inside the conversation's card and does not move or resize it.
      const card = () => page.evaluate(() => { const r = document.querySelector(".room-main-panel")!.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; });
      const before = await card();
      await page.locator(".mau-chip-more").click();
      const roster = page.locator(".mau-roster"); await see(roster).toBeVisible();
      await see.poll(() => roster.evaluate(el => getComputedStyle(el).transform)).toBe("none");
      expect(await card()).toEqual(before);
      const inside = async () => { const r = await roster.evaluate(el => { const b = el.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; });
        expect(r[0]!).toBeGreaterThan(before[0]!); expect(r[1]!).toBeGreaterThan(before[1]!); expect(r[2]!).toBeLessThan(before[2]!); expect(r[3]!).toBeLessThan(before[3]!); return r[2]! - r[0]!; };
      expect(await inside()).toBeLessThan(260);
      await capture(page, `${prefix}-roster`);
      // An employee's profile opens in the same panel, which widens for it; back returns to the list.
      await roster.getByRole("button", { name: /^员工资料/ }).first().click();
      const profile = page.getByRole("complementary", { name: "员工资料" }); await see(profile).toBeVisible();
      await see.poll(inside).toBeGreaterThan(330);
      expect(await card()).toEqual(before);
      await capture(page, `${prefix}-profile`);
      await profile.getByRole("button", { name: "全部对话" }).click();
      await see(page.getByRole("complementary", { name: "全部对话" })).toBeVisible();
      // A press on the conversation puts the panel away.
      await composer.click(); await see(roster).toBeHidden();
    }
    if (width === 390) {
      // The current employee's figure opens the profile; on a phone the panel covers the card and can be closed.
      await page.locator(`.mau-chip[data-chat-key="agent:${f.agent.id}"]`).click();
      const profile = page.getByRole("complementary", { name: "员工资料" }); await see(profile).toBeVisible();
      expect(await profile.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(300);
      await capture(page, `${prefix}-profile`);
      await profile.getByRole("button", { name: "收起" }).click(); await see(profile).toBeHidden();
      // The list covers the card too, and picking a conversation brings the conversation back.
      await page.locator(".mau-chip-more").click();
      const roster = page.locator(".mau-roster"); await see(roster).toBeVisible(); await capture(page, `${prefix}-roster`);
      expect(await roster.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(300);
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
