#!/usr/bin/env node
// Independent packages + actual Host process, with deterministic cloud/native fixtures.
import { mkdtemp, writeFile, copyFile, rm, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    "environment-archive": { type: "string" },
    "router-archive": { type: "string", default: ".packages/agent-router.tgz" },
    "host-archive": { type: "string" },
    "host-fixture": { type: "string" },
    "connectors-archive": { type: "string", default: ".packages/agent-connectors.tgz" },
  },
});
for (const key of ["environment-archive", "host-archive", "host-fixture"])
  if (!values[key]) throw new Error("--" + key + " is required");
const pins = JSON.parse(await readFile(new URL("../components.json", import.meta.url), "utf8"));
for (const name of ["router", "host", "environment", "connectors"]) {
  const integrity = "sha512-" + createHash("sha512").update(await readFile(resolve(values[`${name}-archive`]))).digest("base64");
  if (pins[name].integrity !== integrity) throw new Error(`component_archive_integrity_mismatch: ${name}`);
}
const temporary = await mkdtemp(join(tmpdir(), "router-cloud-consumer-"));
try {
  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({ type: "module", private: true }),
  );
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], {
      encoding: "utf8",
    }),
  )[0];
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      resolve(values["router-archive"]),
      resolve(values["host-archive"]),
      resolve(values["connectors-archive"]),
      resolve(values["environment-archive"]),
      join(temporary, packed.filename),
    ],
    { cwd: temporary, stdio: "pipe" },
  );
  await copyFile(
    new URL("../test/fixtures/cloud-consumer.mjs", import.meta.url),
    join(temporary, "verify.mjs"),
  );
  await copyFile(
    new URL("../test/fixtures/cloud-driver.mjs", import.meta.url),
    join(temporary, "cloud-driver.mjs"),
  );
  await copyFile(new URL("../test/fixtures/mau-native-server.mjs", import.meta.url), join(temporary, "mau-native-server.mjs"));
  execFileSync(
    process.execPath,
    [
      join(temporary, "verify.mjs"),
      join(temporary, "node_modules/@olorinm/mau/dist/cli.js"),
      resolve(values["host-fixture"]),
    ],
    { cwd: temporary, stdio: "inherit", timeout: 120000 },
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
