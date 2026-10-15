import { mkdtemp, writeFile, rm, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { checkStories } from "../test/stories-acceptance.mjs";
import { checkBrowser } from "../test/browser-acceptance.mjs";
import { consumerEntry, consumerHtml } from "../test/consumer-entry.mjs";
import {
  isolationEntry,
  isolationHtml,
  checkIsolation,
} from "../test/isolation-acceptance.mjs";
import {
  createDialogHtml,
  createDialogEntry,
  checkCreateDialog,
} from "../test/create-dialog-acceptance.mjs";
const root = await mkdtemp(resolve(".browser-test-"));
let server;
try {
  await writeFile(resolve(root, "index.html"), consumerHtml);
  await writeFile(resolve(root, "main.jsx"), consumerEntry);
  await writeFile(resolve(root, "isolation.html"), isolationHtml);
  await writeFile(resolve(root, "isolation.jsx"), isolationEntry);
  await copyFile("dist/style.css", resolve(root, "style.css"));
  await writeFile(resolve(root, "create-dialog.html"), createDialogHtml);
  await writeFile(resolve(root, "create-dialog.jsx"), createDialogEntry);
  await copyFile("demo/stories.html", resolve(root, "stories.html"));
  await copyFile("demo/stories.jsx", resolve(root, "stories.jsx"));
  server = await createServer({
    configFile: false,
    root,
    server: { host: "127.0.0.1", port: 0 },
    resolve: {
      alias: {
        "@olorinm/agent-frontend/catalog.css": resolve("dist/catalog.css"),
        "@olorinm/agent-frontend/catalog": resolve("dist/catalog.js"),
        "@olorinm/agent-frontend/style.css": resolve("dist/style.css"),
        "@olorinm/agent-frontend": resolve("dist/index.js"),
      },
    },
  });
  await server.listen();
  await checkIsolation(server.resolvedUrls.local[0]);
  await checkBrowser(server.resolvedUrls.local[0]);
  await checkStories(server.resolvedUrls.local[0]);
  await checkCreateDialog(server.resolvedUrls.local[0]);
} finally {
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
