// The Agent Kit release this product is built on. `components.json` pins one release:
// its version, source revision and the integrity of each package archive.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const root = new URL("../", import.meta.url);
export const packages = new URL(".packages/", root);
export const pinFile = new URL("components.json", root);
/** npm name and release asset of each package; all are installed from `.packages/agent-<name>.tgz`. */
export const components = {
  host: { name: "@olorinm/agent-host", asset: version => `olorinm-agent-host-${version}.tgz` },
  router: { name: "@agent-router/server", asset: version => `agent-router-server-${version}.tgz` },
  connectors: { name: "@olorinm/agent-connectors", asset: version => `olorinm-agent-connectors-${version}.tgz` },
  environment: { name: "@olorinm/agent-environment", asset: version => `olorinm-agent-environment-${version}.tgz` },
};
export const archive = name => new URL(`agent-${name}.tgz`, packages);
/** Host's protocol fixture, which the independent package verification runs as the native agent. */
export const hostFixture = new URL("host-codex-server.mjs", packages);

export async function readPin() {
  const pin = JSON.parse(await readFile(pinFile, "utf8"));
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pin.repository) || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(pin.version) || !/^[0-9a-f]{40}$/.test(pin.revision))
    throw new Error("components.json needs a repository, a version and a 40-character revision");
  return pin;
}
export const writePin = pin => writeFile(pinFile, JSON.stringify(pin, null, 2) + "\n");
export async function integrity(path) {
  return "sha512-" + createHash("sha512").update(await readFile(path)).digest("base64");
}
export function download(url, path) {
  execFileSync("curl", ["--fail", "--location", "--silent", "--show-error", "--retry", "3", "--output", fileURLToPath(path), url], { stdio: "inherit" });
}
export const releaseUrl = (pin, name) =>
  `https://github.com/${pin.repository}/releases/download/v${pin.version}/${components[name].asset(pin.version)}`;
export const fixtureUrl = pin =>
  `https://raw.githubusercontent.com/${pin.repository}/${pin.revision}/packages/host/test/fixtures/codex-server.mjs`;
