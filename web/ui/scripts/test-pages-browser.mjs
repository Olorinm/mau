import { mkdtemp, writeFile, rm, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { checkBrowser } from "../test/pages/browser-acceptance.mjs";
import {
  isolationEntry,
  isolationHtml,
  checkIsolation,
} from "../test/pages/isolation-acceptance.mjs";
import {
  createDialogHtml,
  createDialogEntry,
  checkCreateDialog,
} from "../test/pages/create-dialog-acceptance.mjs";
const pagesHtml =
  '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><div id="root"></div><script type="module" src="/main.jsx"></script></body></html>';
const root = await mkdtemp(resolve(".browser-test-"));
let server;
try {
  await writeFile(resolve(root, "index.html"), pagesHtml);
  await copyFile("test/pages/fixtures/console-pages.jsx", resolve(root, "main.jsx"));
  await copyFile("test/pages/fixtures/run-parts.mjs", resolve(root, "run-parts.mjs"));
  await writeFile(resolve(root, "isolation.html"), isolationHtml);
  await writeFile(resolve(root, "isolation.jsx"), isolationEntry);
  await copyFile("dist/pages/pages.css", resolve(root, "style.css"));
  await writeFile(resolve(root, "create-dialog.html"), createDialogHtml);
  await writeFile(resolve(root, "create-dialog.jsx"), createDialogEntry);
  server = await createServer({
    configFile: false,
    root,
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  await checkIsolation(server.resolvedUrls.local[0]);
  await checkBrowser(server.resolvedUrls.local[0]);
  await checkCreateDialog(server.resolvedUrls.local[0]);
} finally {
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
