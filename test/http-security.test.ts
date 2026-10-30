import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("HTTP dependencies survive malformed compressed traffic in an isolated process", async () => {
  const script = fileURLToPath(new URL("../scripts/verify-http-security.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script], { timeout: 10_000 });
  expect(JSON.parse(stdout)).toMatchObject({ status: "passed" });
}, 15_000);
