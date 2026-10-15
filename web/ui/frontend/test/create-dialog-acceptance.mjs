import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

export const createDialogHtml =
  '<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/create-dialog.jsx"></script></body></html>';
export const createDialogEntry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FrontendProvider,AppCreateDialog} from '@olorinm/agent-frontend/catalog';
import '@olorinm/agent-frontend/catalog.css';
function Example() {
 const [open,setOpen]=useState(false), [name,setName]=useState(''), [description,setDescription]=useState(''), [source,setSource]=useState('');
 return <FrontendProvider language="zh-CN" theme="dark"><button onClick={()=>setOpen(true)}>Open create dialog</button><AppCreateDialog open={open} onOpenChange={setOpen} title={name} description={description} source={source} onTitleChange={setName} onDescriptionChange={setDescription} onSourceChange={setSource} onCancel={()=>setOpen(false)} onOpenStore={()=>{}} onChooseLocalFolder={()=>setSource('/example')} canRequestAgent onRequestAgent={()=>setOpen(false)} notice={<div className="af-notice">Caller supplied notice</div>}/></FrontendProvider>;
}
createRoot(document.getElementById('root')).render(<Example/>);
`;

export async function checkCreateDialog(base) {
  const browser = await chromium.launch();
  try {
    for (const width of [1360, 390, 320]) {
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        reducedMotion: "reduce",
      });
      await page.goto(new URL("create-dialog.html", base).href);
      const opener = page.getByRole("button", {
        name: "Open create dialog",
        exact: true,
      });
      await opener.click();
      const dialog = page.getByRole("dialog", {
        name: "新建应用",
        exact: true,
      });
      await dialog.waitFor();
      await dialog
        .getByRole("textbox", { name: "App 名称", exact: true })
        .fill("Example");
      const dimensions = await dialog.evaluate((element) =>
        [
          element,
          ...element.querySelectorAll(
            ".app-create-wizard,.app-create-section,.app-create-group,.settings-form-actions,.af-notice",
          ),
        ].map((node) => ({
          name: node.className,
          client: node.clientWidth,
          scroll: node.scrollWidth,
        })),
      );
      for (const node of dimensions)
        assert.ok(
          node.scroll <= node.client + 1,
          `${width}px ${node.name}: ${node.scroll} exceeds ${node.client}`,
        );
      const actions = dialog.locator(".settings-form-actions");
      assert.equal(
        await actions.evaluate((element) => getComputedStyle(element).display),
        "flex",
        "catalog feature CSS includes the original action styling",
      );
      for (const button of await actions.getByRole("button").all()) {
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport();
        const position = await button.evaluate((element) => {
          const modal = element.closest('[role="dialog"]');
          const bounds = modal.getBoundingClientRect(),
            box = element.getBoundingClientRect(),
            style = getComputedStyle(modal);
          return {
            left: box.left,
            right: box.right,
            contentLeft: bounds.left + parseFloat(style.paddingLeft),
            contentRight: bounds.right - parseFloat(style.paddingRight),
          };
        });
        assert.ok(
          position.left >= position.contentLeft - 1 &&
            position.right <= position.contentRight + 1,
          `${width}px action stays inside the dialog content box: ${JSON.stringify(position)}`,
        );
      }
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await expect(opener).toBeFocused();
      await page.close();
    }
    console.log(
      "Catalog feature imports preserve desktop actions and keep 390/320px dialog content and buttons inside the viewport.",
    );
  } finally {
    await browser.close();
  }
}
