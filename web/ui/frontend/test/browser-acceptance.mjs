import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
export async function checkBrowser(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1360, height: 900 },
    });
    page.setDefaultTimeout(10000);
    const errors = [];
    const calls = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        ["fetch", "xhr", "websocket", "eventsource"].includes(
          request.resourceType(),
        )
      )
        calls.push(request.url());
    });
    await page.goto(url);
    await page.getByRole("button", { name: "Research" }).click();
    await page.getByText("Caller supplied message").waitFor();
    await page.getByPlaceholder("Write a message").fill("An independent UI");
    const composer = page.getByPlaceholder("Write a message");
    await composer.dispatchEvent("compositionstart");
    await composer.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      isComposing: true,
      bubbles: true,
    });
    await composer.dispatchEvent("compositionend");
    await composer.press("Enter");
    assert.deepEqual(
      await page.evaluate(() => window.actions),
      [["select", "one"]],
      "IME confirmation must not send",
    );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Caller rejected delivery" })
      .waitFor();
    assert.deepEqual(await page.evaluate(() => window.actions), [
      ["select", "one"],
      ["send", "An independent UI"],
    ]);
    assert.equal(
      await page.getByPlaceholder("Write a message").inputValue(),
      "An independent UI",
    );
    await page.getByRole("button", { name: "catalog", exact: true }).click();
    await page
      .getByRole("button", { name: "Choose template", exact: true })
      .click();
    const catalogCard = page.locator(".app-store-app-card");
    await catalogCard.focus();
    await catalogCard.press("Enter");
    const catalogDialog = page.getByRole("dialog", {
      name: "Template",
      exact: true,
    });
    await catalogDialog.waitFor();
    const catalogClose = catalogDialog.getByRole("button", {
      name: "Close",
      exact: true,
    });
    await expect(catalogClose).toBeFocused();
    assert.equal(
      await catalogDialog.evaluate((element) =>
        element.closest(".af-scope")?.getAttribute("data-resolved-theme"),
      ),
      "light",
      "catalog portal keeps the caller's theme scope",
    );
    await page.keyboard.press("Shift+Tab");
    await expect(
      catalogDialog.getByRole("button", {
        name: "Choose template",
        exact: true,
      }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(catalogClose).toBeFocused();
    await page.keyboard.press("Escape");
    await catalogDialog.waitFor({ state: "hidden" });
    await expect(catalogCard).toBeFocused();
    await page.getByRole("button", { name: "settings", exact: true }).click();
    await page.getByText("Caller-owned preferences").waitFor();
    await page.getByRole("button", { name: "Light", exact: true }).click();
    await page.getByRole("option", { name: "Dark", exact: true }).click();
    await page.getByRole("button", { name: "Dark", exact: true }).waitFor();
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Account action" }).click();
    assert.deepEqual((await page.evaluate(() => window.actions)).at(-1), [
      "account",
    ]);
    await page.getByRole("button", { name: "profile", exact: true }).click();
    await page
      .getByRole("button", { name: "Edit person", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("tab", { name: "Runtime" })
      .click();
    await page.getByText("Caller-owned runtime").waitFor();
    await page
      .getByRole("dialog")
      .getByRole("tab", { name: "Identity" })
      .click();
    await page.getByRole("dialog").getByLabel("Name").fill("A new person");
    await page.getByRole("button", { name: "Save person" }).click();
    assert.deepEqual((await page.evaluate(() => window.actions)).at(-1), [
      "profile",
      "A new person",
    ]);
    await page
      .getByRole("button", { name: "Capabilities", exact: true })
      .click();
    await page.getByText("Caller-owned capabilities").waitFor();
    await page.getByRole("button", { name: "extensions", exact: true }).click();
    await page.getByRole("button", { name: "Example tool" }).click();
    await page.getByRole("button", { name: "create", exact: true }).click();
    await page
      .getByLabel("App name", { exact: true })
      .fill("Separate application");
    await page.getByRole("button", { name: "Create app", exact: true }).click();
    assert.deepEqual((await page.evaluate(() => window.actions)).at(-1), [
      "app",
      "Separate application",
    ]);
    await page.getByRole("button", { name: "builder", exact: true }).click();
    await page.getByPlaceholder("Sample Workbench").fill("Disabled builder");
    const source = page.locator(".app-create-source-field input");
    await source.fill("/tmp/example");
    await source.press("Enter");
    assert.equal(
      (await page.evaluate(() => window.actions)).some(
        (action) => action[0] === "build",
      ),
      false,
      "unavailable builder must not submit via Enter",
    );
    await page.getByRole("button", { name: "versions", exact: true }).click();
    await page.getByRole("button", { name: "Choose version" }).click();
    assert.deepEqual((await page.evaluate(() => window.actions)).at(-1), [
      "version",
      "1.0",
    ]);
    await page.getByRole("button", { name: "files", exact: true }).click();
    const editor = page.locator(".cm-content");
    await editor.waitFor();
    await editor.fill("# Edited by caller");
    await page.getByRole("heading", { name: "Edited by caller" }).waitFor();
    await page.getByRole("button", { name: "rich", exact: true }).click();
    await page.locator(".milkdown .ProseMirror").waitFor();
    assert.equal(
      await page
        .locator(".milkdown .ProseMirror")
        .evaluate((element) => getComputedStyle(element).whiteSpace),
      "pre-wrap",
      "editable whitespace must be preserved",
    );
    await page
      .locator(".milkdown .ProseMirror")
      .fill("Rich text remains caller owned");
    await page.getByRole("button", { name: "conflict", exact: true }).click();
    await page
      .getByRole("button", { name: "Use saved version", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save resolution", exact: true })
      .click();
    assert.deepEqual((await page.evaluate(() => window.actions)).at(-1), [
      "save",
      "Saved version",
    ]);
    await page.getByRole("button", { name: "login", exact: true }).click();
    await page.getByLabel("Account", { exact: true }).fill("sample");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Caller rejected this sign in" })
      .waitFor();
    await page.screenshot({ path: "/tmp/agent-frontend-neutral-auth.png" });
    await page.getByRole("button", { name: "Close form" }).click();
    await page.getByRole("button", { name: "Theme", exact: true }).click();
    await page.screenshot({ path: "/tmp/agent-frontend-neutral-desktop.png" });
    assert.ok(
      await page
        .locator(".app-user-button")
        .evaluate(
          (el) =>
            Math.abs(innerHeight - el.getBoundingClientRect().bottom) < 32,
        ),
      "account remains at the bottom of the original rail",
    );
    const separator = page.getByRole("separator", {
      name: "Resize main navigation",
    });
    await separator.focus();
    await page.keyboard.press("Home");
    assert.equal(await separator.getAttribute("aria-valuenow"), "0");
    await page.getByRole("button", { name: "Expand main navigation" }).click();
    assert.equal(await separator.getAttribute("aria-valuenow"), "126");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page
      .getByRole("button", { name: "Research" })
      .waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Research" }).click();
    await page
      .getByPlaceholder("Write a message")
      .waitFor({ state: "visible" });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      "mobile overflow",
    );
    await page.screenshot({ path: "/tmp/agent-frontend-neutral-mobile.png" });
    await page.evaluate(() => window.dispose());
    assert.equal(await page.locator("#root").innerHTML(), "");
    assert.deepEqual(errors, []);
    assert.deepEqual(calls, [], "components must not make service requests");
    console.log(
      "Controlled interactions, caller errors, auth layout, file editing, dark/mobile rendering and zero service requests passed.",
    );
  } finally {
    await browser.close();
  }
}
