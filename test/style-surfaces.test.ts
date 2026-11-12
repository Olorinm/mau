import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, expect as see, type Page, type Locator } from "@playwright/test";
import { edgeMauFixture } from "./fixtures/edge.js";

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
    const f = await edgeMauFixture(cleanup, { webRoot }, { ledgerRead: true, ledgerSend: true, ledgerCards: true, ledgerControl: true });
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
    await composer.fill("/"); await see(page.getByRole("listbox", { name: "斜杠命令" })).toBeVisible();
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
