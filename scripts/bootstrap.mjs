#!/usr/bin/env node
// Install separately built components; application code imports only their public package exports.
import { mkdir, copyFile, readFile, writeFile, mkdtemp, readdir, rm } from "node:fs/promises";
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
    if (distribution) {
      // Private components are distributed as immutable build artifacts in this
      // repository. CI's ordinary repository token is sufficient; no broad PAT.
      execFileSync("gh", ["release", "download", distribution.tag, "--repo", distribution.repository,
        "--pattern", distribution.asset, "--dir", temporary], { stdio: "inherit" });
      await copyFile(join(temporary, distribution.asset), destination);
      continue;
    }
    const response = await fetch(`https://codeload.github.com/${repository}/tar.gz/${revision}`, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`component_download_failed_${name}`);
    const archive = join(temporary, "source.tar.gz");
    await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
    execFileSync("tar", ["-xzf", archive, "-C", temporary]);
    const directory = (await readdir(temporary, { withFileTypes: true })).find(e => e.isDirectory())?.name;
    if (!directory) throw new Error("component_source_missing");
    const cwd = join(temporary, directory);
    execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd, stdio: "inherit" });
    execFileSync("npm", ["run", "build"], { cwd, stdio: "inherit" });
    const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json"], { cwd, encoding: "utf8" }))[0];
    await copyFile(join(cwd, packed.filename), destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
