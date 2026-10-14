import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

it.each(["router", "environment"])("rejects changed %s archive bytes before npm can use a cached old package", async name => {
  const root = await mkdtemp(join(tmpdir(), "mau-bootstrap-"));
  try {
    await mkdir(join(root, "scripts"));
    await copyFile(new URL("../scripts/bootstrap.mjs", import.meta.url), join(root, "scripts/bootstrap.mjs"));
    const integrity = "sha512-" + createHash("sha512").update("pinned archive").digest("base64");
    await writeFile(join(root, "components.json"), JSON.stringify({ router: { integrity }, environment: { integrity } }));
    await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: {
      "node_modules/@agent-router/server": { integrity },
      "node_modules/@olorinm/agent-environment": { integrity },
    } }));
    for (const component of ["router", "environment"])
      await writeFile(join(root, component + ".tgz"), component === name ? "different archive at same path" : "pinned archive");
    const result = spawnSync(process.execPath, [join(root, "scripts/bootstrap.mjs"),
      "--router-archive", join(root, "router.tgz"), "--environment-archive", join(root, "environment.tgz")],
    { cwd: root, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`component_archive_integrity_mismatch: ${name}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
