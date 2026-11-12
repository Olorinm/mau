import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const assets = { host: "olorinm-agent-host", router: "agent-router-server", connectors: "olorinm-agent-connectors", environment: "olorinm-agent-environment" };

it.each(Object.keys(assets))("rejects changed %s archive bytes before npm can use a cached old package", async name => {
  const root = await mkdtemp(join(tmpdir(), "mau-bootstrap-"));
  try {
    await mkdir(join(root, "scripts")); await mkdir(join(root, "release"));
    for (const script of ["bootstrap.mjs", "kit.mjs"]) await copyFile(new URL("../scripts/" + script, import.meta.url), join(root, "scripts", script));
    const integrity = "sha512-" + createHash("sha512").update("pinned archive").digest("base64");
    await writeFile(join(root, "components.json"), JSON.stringify({ repository: "example/kit", version: "1.0.0", revision: "0".repeat(40),
      integrity: Object.fromEntries(Object.keys(assets).map(component => [component, integrity])) }));
    for (const [component, asset] of Object.entries(assets))
      await writeFile(join(root, "release", asset + "-1.0.0.tgz"), component === name ? "different archive at same path" : "pinned archive");
    const result = spawnSync(process.execPath, [join(root, "scripts/bootstrap.mjs"), "--from", join(root, "release")], { cwd: root, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`component_archive_integrity_mismatch: ${name}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
