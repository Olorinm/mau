#!/usr/bin/env node
// Install separately built components; application code imports only their public package exports.
import { mkdir, copyFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
const { values } = parseArgs({ options: { "router-archive": { type: "string" }, "environment-archive": { type: "string" } } });
const root = new URL("../", import.meta.url);
const packages = new URL(".packages/", root);
await mkdir(packages, { recursive: true });
const pins = JSON.parse(await readFile(new URL("components.json", root), "utf8"));
const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
async function verifyArchive(name, path) {
  const packageName = name === "router" ? "@agent-router/server" : "@olorinm/agent-environment";
  const expected = lock.packages[`node_modules/${packageName}`]?.integrity;
  const actual = "sha512-" + createHash("sha512").update(await readFile(path)).digest("base64");
  // npm ci may satisfy a file: dependency from its integrity cache without
  // opening the supplied archive. Check the actual bytes before invoking npm.
  if (actual !== expected || pins[name].integrity && pins[name].integrity !== expected)
    throw new Error(`component_archive_integrity_mismatch: ${name}`);
}
for (const name of ["router", "environment"]) {
  const destination = new URL(`agent-${name}.tgz`, packages);
  if (values[`${name}-archive`]) {
    await copyFile(resolve(values[`${name}-archive`]), destination);
    await verifyArchive(name, destination);
    continue;
  }
  const { repository, revision, archive: distribution } = pins[name];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(revision))
    throw new Error("immutable_component_revision_required");
  const temporary = await mkdtemp(join(tmpdir(), "mau-component-"));
  try {
    // Install exact archives, not platform-dependent repacks of source. npm ci
    // verifies their lockfile integrity. CI only needs this repository's token.
    if (!distribution) throw new Error(`${name} is not distributed yet; pass --${name}-archive with the pinned local archive (see README).`);
    execFileSync("gh", ["release", "download", distribution.tag, "--repo", distribution.repository,
      "--pattern", distribution.asset, "--dir", temporary], { stdio: "inherit" });
    await copyFile(join(temporary, distribution.asset), destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  await verifyArchive(name, destination);
}
execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
// Router's official Feishu authorization/tool bridge needs its platform binary.
execFileSync("npm", ["rebuild", "@larksuite/cli", "--ignore-scripts=false"], { cwd: root, stdio: "inherit" });
