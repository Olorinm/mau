#!/usr/bin/env node
// Download the pinned Agent Kit release into .packages/ and install dependencies.
// Application code imports only the packages' public exports.
//   node scripts/bootstrap.mjs               download from the pinned release
//   node scripts/bootstrap.mjs --from <dir>  take the release assets from a local directory
import { mkdir, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { root, packages, components, archive, hostFixture, readPin, integrity, download, releaseUrl, fixtureUrl } from "./kit.mjs";

const { values } = parseArgs({ options: { from: { type: "string" } } });
const pin = await readPin();
await mkdir(packages, { recursive: true });
for (const name of Object.keys(components)) {
  if (values.from) await copyFile(join(resolve(values.from), components[name].asset(pin.version)), archive(name));
  else download(releaseUrl(pin, name), archive(name));
  // npm ci may satisfy a file: dependency from its cache without opening the archive. Check the bytes first.
  if (await integrity(archive(name)) !== pin.integrity[name]) throw new Error(`component_archive_integrity_mismatch: ${name}`);
}
if (values.from) await copyFile(join(resolve(values.from), "codex-server.mjs"), hostFixture);
else download(fixtureUrl(pin), hostFixture);
const npm = (args, cwd = root) => execFileSync("npm", args, { cwd, stdio: "inherit" });
npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
// The console and its UI package (web/ui) install together as one npm workspace.
npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], new URL("web/", root));
// Agent Connectors' Feishu connection runs the official Lark CLI, which needs its platform binary.
npm(["rebuild", "@larksuite/cli", "--ignore-scripts=false"]);
