#!/usr/bin/env node
// Independent packages + actual Host process, with deterministic cloud/native fixtures.
import { mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { components, archive, hostFixture } from "./kit.mjs";
// The archives and Host's protocol fixture that scripts/bootstrap.mjs installed from the pinned release.
const archives = Object.keys(components).map(name => fileURLToPath(archive(name)));
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
      ...archives,
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
      fileURLToPath(hostFixture),
    ],
    { cwd: temporary, stdio: "inherit", timeout: 120000 },
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
