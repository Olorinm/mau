// Install the packed archive outside this repository, as an independent product would.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
import { checkAppBrowser, checkUiBrowser } from "./test-browser.mjs";

const root = process.cwd();
await mkdir(".local", { recursive: true });
const consumer = await mkdtemp(resolve(".local/consumer-"));
let browser;
try {
  const npm = (args, cwd = root) =>
    execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, encoding: "utf8", stdio: "pipe" });
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(manifest.dependencies["@olorinm/agent-host"], undefined, "Agent Host stays optional");
  npm(["pack", "--pack-destination", consumer, "--silent"]);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  npm([
    "install", "--ignore-scripts", "--no-audit", "--no-fund",
    `./olorinm-agent-ui-${manifest.version}.tgz`,
    // Only for checking the optional Host adapter against Host's published types.
    manifest.devDependencies["@olorinm/agent-host"],
    "react@19.3.0", "react-dom@19.3.0", "@types/react@19.3.0", "@types/react-dom@19.3.0", "esbuild@0.28.2",
  ], consumer);
  const installed = join(consumer, "node_modules/@olorinm/agent-ui");
  for (const entry of Object.values(JSON.parse(await readFile(join(installed, "package.json"), "utf8")).exports)) {
    await readFile(join(installed, typeof entry === "string" ? entry : entry.import));
    if (typeof entry !== "string") await readFile(join(installed, entry.types));
  }
  await writeFile(join(consumer, "contract.ts"), `
import type { InteractionHandler, Interaction, InteractionAnswer } from "@olorinm/agent-host/interactions";
import {useAgentInteractions, createRunView, appendRunEvent} from "@olorinm/agent-ui/agent-host";
import type {HostInteraction, HostInteractionAnswer} from "@olorinm/agent-ui/agent-host";
import type {EventPage} from "@olorinm/agent-host/client";
import {Button, ConfirmProvider, ProductStatus, useConfirm, type ProductStatusTone} from "@olorinm/agent-ui/app";
declare const handler: ReturnType<typeof useAgentInteractions>["onInteraction"];
const assignHandler: InteractionHandler = handler;
declare const request: Interaction;
const assignRequest: HostInteraction = request;
declare const answer: HostInteractionAnswer;
const assignAnswer: InteractionAnswer = answer;
declare const page: EventPage;
for(const item of page.events) appendRunEvent(createRunView(item.event.runId), item);
const tone: ProductStatusTone = "success";
void [assignHandler,assignRequest,assignAnswer,Button,ConfirmProvider,ProductStatus,useConfirm,tone];
`);
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
    "--module", "NodeNext", "--target", "ES2022", "--jsx", "react-jsx", join(consumer, "contract.ts")], { cwd: consumer, stdio: "inherit" });
  const { build } = createRequire(join(consumer, "package.json"))("esbuild");
  for (const name of ["browser-fixture", "app-fixture"]) {
    await cp(`test/${name}.tsx`, join(consumer, `${name}.tsx`));
    const result = await build({
      entryPoints: [join(consumer, `${name}.tsx`)], outfile: join(consumer, `${name}.js`), bundle: true,
      format: "iife", platform: "browser", target: "es2022", jsx: "automatic", metafile: true,
    });
    const inputs = Object.keys(result.metafile.inputs);
    assert.ok(inputs.some((path) => path.includes("node_modules/@olorinm/agent-ui/dist")));
    assert.ok(inputs.every((path) => !path.includes(`${root}/src`)));
    await writeFile(join(consumer, `${name}.html`),
      `<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./${name}.css"><div id="root"></div><script src="./${name}.js"></script>`);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(pathToFileURL(join(consumer, "browser-fixture.html")).href);
  await checkUiBrowser(page);
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto(pathToFileURL(join(consumer, "app-fixture.html")).href);
  await checkAppBrowser(page);
  assert.deepEqual(errors, []);
  console.log("Independent archive, Host-compatible types and browser controls passed");
} finally {
  await browser?.close();
  await rm(consumer, { recursive: true, force: true });
}
