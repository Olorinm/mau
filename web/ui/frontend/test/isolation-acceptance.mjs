import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

export const isolationHtml =
  '<!doctype html><html><meta charset="utf-8"><body><button id="outside">Outside button</button><input id="outside-input"><div id="root"></div><script type="module" src="/isolation.jsx"></script></body></html>';
export const isolationEntry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FrontendProvider} from '@olorinm/agent-frontend';
import {Dialog,DialogContent,DialogTitle,Button,Tooltip,TooltipProvider} from '@olorinm/agent-ui/app';
function Example({theme}) { const [open,setOpen]=useState(false);return <section aria-label={theme} style={{width:360,height:180}}><FrontendProvider theme={theme}><TooltipProvider><Button onClick={()=>setOpen(true)}>Open {theme}</Button><Tooltip content={theme+' tooltip'}><button>Help {theme}</button></Tooltip><Dialog open={open} onOpenChange={setOpen}><DialogContent aria-describedby={undefined}><DialogTitle>{theme} dialog</DialogTitle><Button onClick={()=>setOpen(false)}>Close</Button></DialogContent></Dialog></TooltipProvider></FrontendProvider></section>; }
createRoot(document.getElementById('root')).render(<><Example theme="light"/><Example theme="dark"/></>);
`;

export async function checkIsolation(url) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url + "isolation.html");
    await page
      .getByRole("button", { name: "Open light", exact: true })
      .waitFor();
    const styles = () =>
      page.evaluate(() =>
        ["outside", "outside-input"].map((id) => {
          const c = getComputedStyle(document.getElementById(id));
          return [
            "fontSize",
            "fontFamily",
            "boxSizing",
            "color",
            "backgroundColor",
            "padding",
            "minHeight",
            "transitionDuration",
            "outlineStyle",
          ].map((key) => c[key]);
        }),
      );
    const before = await styles();
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = "/style.css";
          link.onload = resolve;
          link.onerror = reject;
          document.head.append(link);
        }),
    );
    assert.deepEqual(
      await styles(),
      before,
      "library CSS must not change unrelated controls",
    );
    assert.equal(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--c-bg"),
      ),
      "",
      "tokens must not leak onto document root",
    );
    const colors = [];
    for (const theme of ["light", "dark"]) {
      await page
        .getByRole("button", { name: "Open " + theme, exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      assert.equal(
        await dialog.evaluate((el) =>
          el.closest(".af-scope")?.getAttribute("data-resolved-theme"),
        ),
        theme,
        "portal retains its own theme scope",
      );
      colors.push(
        await dialog.evaluate((el) => getComputedStyle(el).backgroundColor),
      );
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await expect(
        page.getByRole("button", { name: "Open " + theme, exact: true }),
      ).toBeFocused();
    }
    assert.notEqual(
      colors[0],
      colors[1],
      "two simultaneous theme instances must remain independent",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.deepEqual(
      await styles(),
      before,
      "reduced-motion reset must stay in scope",
    );
    console.log(
      "Outside controls, document tokens, independent light/dark portals and focus restoration passed.",
    );
  } finally {
    await browser.close();
  }
}
