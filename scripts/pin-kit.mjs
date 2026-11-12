#!/usr/bin/env node
// Pin an Agent Kit release: node scripts/pin-kit.mjs 0.8.0-alpha.1
// Downloads its archives, records their integrity in components.json and updates package.json and the lockfile.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { root, packages, components, archive, readPin, writePin, integrity, download, releaseUrl } from "./kit.mjs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version ?? "")) {
  console.error("Usage: node scripts/pin-kit.mjs <version>");
  process.exit(1);
}
const { repository } = await readPin();
const tags = execFileSync("git", ["ls-remote", `https://github.com/${repository}.git`, `refs/tags/v${version}`, `refs/tags/v${version}^{}`], { encoding: "utf8" });
const revision = tags.trim().split("\n").at(-1)?.split("\t")[0];
if (!/^[0-9a-f]{40}$/.test(revision ?? "")) throw new Error(`${repository} has no tag v${version}`);
const pin = { repository, version, revision, integrity: {} };
await mkdir(packages, { recursive: true });
for (const name of Object.keys(components)) {
  download(releaseUrl(pin, name), archive(name));
  pin.integrity[name] = await integrity(archive(name));
}
await writePin(pin);
const manifestFile = new URL("package.json", root), manifest = JSON.parse(await readFile(manifestFile, "utf8"));
for (const { name } of Object.values(components)) if (manifest.peerDependencies[name]) manifest.peerDependencies[name] = version;
await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
// npm keeps a lockfile entry whose file: path is unchanged; drop the entries so it reads the new archives.
// The console (web/) installs Host's archive for its types, so its lockfile is refreshed the same way.
for (const directory of ["./", "web/"]) {
  const lockFile = new URL(directory + "package-lock.json", root), lock = JSON.parse(await readFile(lockFile, "utf8"));
  for (const { name } of Object.values(components)) delete lock.packages[`node_modules/${name}`];
  await writeFile(lockFile, JSON.stringify(lock, null, 2) + "\n");
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: new URL(directory, root), stdio: "inherit" });
}
console.log(`Pinned ${repository} ${version} (${revision.slice(0, 12)}). Run node scripts/bootstrap.mjs to install it.`);
