#!/usr/bin/env node
// Install separately built components; application code imports only their public package exports.
import { mkdir, copyFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
const { values } = parseArgs({ options: {
  "router-archive": { type: "string" }, "host-archive": { type: "string" }, "environment-archive": { type: "string" }, "connectors-archive": { type: "string" },
} });
const root = new URL("../", import.meta.url);
const packages = new URL(".packages/", root);
await mkdir(packages, { recursive: true });
const pins = JSON.parse(await readFile(new URL("components.json", root), "utf8"));
const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
async function verifyArchive(name, path) {
  const packageName = { router: "@agent-router/server", environment: "@olorinm/agent-environment", connectors: "@olorinm/agent-connectors" }[name];
  const expected = lock.packages[`node_modules/${packageName}`]?.integrity;
  const actual = "sha512-" + createHash("sha512").update(await readFile(path)).digest("base64");
  // npm ci may satisfy a file: dependency from its integrity cache without
  // opening the supplied archive. Check the actual bytes before invoking npm.
  if (actual !== expected || pins[name].integrity && pins[name].integrity !== expected)
    throw new Error(`component_archive_integrity_mismatch: ${name}`);
}
const archives = { router: "agent-router.tgz", environment: "agent-environment.tar", connectors: "agent-connectors.tgz" };
for (const name of ["router", "environment", "connectors"]) {
  const destination = new URL(archives[name], packages);
  if (values[`${name}-archive`]) {
    await copyFile(resolve(values[`${name}-archive`]), destination);
    await verifyArchive(name, destination);
    continue;
  }
  if (pins[name].distribution === "local-build")
    throw new Error(`${name} contains unpublished changes; pass --${name}-archive with the lockfile-pinned local archive.`);
  const { repository, revision, archive: distribution } = pins[name];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(revision))
    throw new Error("immutable_component_revision_required");
  const temporary = await mkdtemp(join(tmpdir(), "mau-component-"));
  try {
    // Install exact archives, not platform-dependent repacks of source. npm ci
    // verifies their lockfile integrity. Private releases require repository access.
    if (!distribution) throw new Error(`${name} is not distributed yet; pass --${name}-archive with the pinned local archive (see README).`);
    execFileSync("gh", ["release", "download", distribution.tag, "--repo", distribution.repository,
      "--pattern", distribution.asset, "--dir", temporary], { stdio: "inherit" });
    await copyFile(join(temporary, distribution.asset), destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  await verifyArchive(name, destination);
}
// Host runs in the execution image. Keep its exact archive for image assembly and
// the independent consumer without installing its implementation into Mau.
if (values["host-archive"]) {
  const source = resolve(values["host-archive"]);
  const actual = "sha512-" + createHash("sha512").update(await readFile(source)).digest("base64");
  if (actual !== pins.host.integrity) throw new Error("component_archive_integrity_mismatch: host");
  await copyFile(source, new URL("agent-host.tgz", packages));
}
execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
// The console and its UI package (web/ui) install together as one npm workspace.
execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: new URL("web/", root), stdio: "inherit" });
// Agent Connectors' Feishu connection runs the official Lark CLI, which needs its platform binary.
execFileSync("npm", ["rebuild", "@larksuite/cli", "--ignore-scripts=false"], { cwd: root, stdio: "inherit" });
