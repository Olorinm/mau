#!/usr/bin/env node
// Install separately built components; application code imports only their public package exports.
import { mkdir, copyFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
const { values } = parseArgs({ options: { "router-archive": { type: "string" }, "environment-archive": { type: "string" } } });
const root = new URL("../", import.meta.url);
const packages = new URL(".packages/", root);
await mkdir(packages, { recursive: true });
const pins = JSON.parse(await readFile(new URL("components.json", root), "utf8"));
for (const name of ["router", "environment"]) {
  const destination = new URL(`agent-${name}.tgz`, packages);
  if (values[`${name}-archive`]) {
    await copyFile(resolve(values[`${name}-archive`]), destination);
    continue;
  }
  const { repository, revision, archive: distribution } = pins[name];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(revision))
    throw new Error("immutable_component_revision_required");
  const temporary = await mkdtemp(join(tmpdir(), "mau-component-"));
  try {
    // Install exact archives, not platform-dependent repacks of source. npm ci
    // verifies their lockfile integrity. CI only needs this repository's token.
    if (!distribution) throw new Error("component_archive_required");
    execFileSync("gh", ["release", "download", distribution.tag, "--repo", distribution.repository,
      "--pattern", distribution.asset, "--dir", temporary], { stdio: "inherit" });
    await copyFile(join(temporary, distribution.asset), destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
// Router's official Feishu authorization/tool bridge needs its platform binary.
execFileSync("npm", ["rebuild", "@larksuite/cli", "--ignore-scripts=false"], { cwd: root, stdio: "inherit" });
