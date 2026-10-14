#!/usr/bin/env node
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { "pack-destination": { type: "string", default: ".packages" } } });
const root = new URL("../", import.meta.url);
const product = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const destination = resolve(values["pack-destination"]);
await mkdir(destination, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "mau-cli-pack-"));
try {
  await mkdir(join(temporary, "dist"));
  // The client uses Node built-ins only. Never copy server code, peer dependencies,
  // private Environment archives, source maps or local operator configuration.
  for (const file of ["cli.js", "files.js"])
    await copyFile(new URL("dist/" + file, root), join(temporary, "dist", file));
  await chmod(join(temporary, "dist/cli.js"), 0o755);
  for (const file of ["LICENSE", "NOTICE"])
    await copyFile(new URL(file, root), join(temporary, file));
  await copyFile(new URL("docs/cli.md", root), join(temporary, "README.md"));
  await writeFile(join(temporary, "package.json"), JSON.stringify({
    name: "@olorinm/mau-cli", version: product.version,
    description: "Command-line client for a Mau service.",
    type: "module", license: product.license, engines: product.engines,
    repository: product.repository, bin: { mau: "dist/cli.js" },
    files: ["dist", "README.md", "LICENSE", "NOTICE"],
  }, null, 2) + "\n");
  process.stdout.write(execFileSync("npm", ["pack", "--json", "--pack-destination", destination],
    { cwd: temporary, encoding: "utf8" }));
} finally { await rm(temporary, { recursive: true, force: true }); }
