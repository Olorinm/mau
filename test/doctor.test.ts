import { afterEach, expect, it } from "vitest";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deploy, doctor, type Check } from "../src/deploy/index.js";
import { API_TOKEN, codexAuth, deploymentFixture } from "./fixtures/deployment.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const first = { hostname: "mau.example.com", ownerEmail: "owner@example.com" };
const failing = (checks: Check[]) => checks.filter((check) => check.ok === false).map((check) => check.check);
const named = (checks: Check[], name: string) => checks.find((check) => check.check === name)!;

it("finds a standing deployment healthy, down to its partners, and changes nothing", async () => {
  const f = deploymentFixture(cleanup);
  expect((await deploy(first, f.runtime)).exitCode).toBe(0);
  f.cloud.partners = [{ agent: { id: "a1", name: "helper" }, environment: { state: "ready" } }, { agent: { id: "a2", name: "scout" }, environment: { state: "sleeping" } },
    { agent: { id: "a3", name: "new" }, environment: null }];
  const writes = f.cloud.writes.length, record = readFileSync(join(f.directory, "deployment.json"), "utf8");
  const { exitCode, report } = await doctor({}, f.runtime);
  expect(failing(report.checks)).toEqual([]);
  expect(exitCode).toBe(0);
  expect(report.checks.map((check) => check.check)).toEqual(["node", "source-checkout", "docker", "wrangler", "cloudflared", "cloudflare-credentials", "deployment",
    "bucket:mau-config", "bucket:mau-state", "bucket:mau-attachments", "bucket:mau-access-logs", "bucket:mau-environment-backups", "r2-key-pair", "configuration-objects", "codex-sign-in",
    "gateway", "gateway-key", "health", "access", "deployed-revision", "deployed-configuration", "backup", "account", "environment-profile", "partner:helper", "partner:scout", "partner:new"]);
  // What cannot be said either way is null, with the reason.
  expect(report.checks.filter((check) => check.ok === null).map((check) => check.check)).toEqual(["backup", "partner:new"]);
  expect(named(report.checks, "backup")).toMatchObject({ detail: expect.stringContaining("no daily backup"), fix: "docs/deployment.md#daily-backup" });
  expect(named(report.checks, "codex-sign-in").detail).toBe("signed in with ChatGPT; access token expires 2100-01-01T00:00:00.000Z; refreshed by Codex when used");
  expect(named(report.checks, "account").detail).toBe("signed in as @owner:mau.example.com (edge)");
  expect(named(report.checks, "partner:helper").detail).toBe("environment ready; 1 channel checks pass");
  expect(f.cloud.writes.length).toBe(writes);
  expect(readFileSync(join(f.directory, "deployment.json"), "utf8")).toBe(record);
  expect(JSON.stringify(report)).not.toContain(API_TOKEN);
  expect(JSON.stringify(report)).not.toContain("codex-refresh-token");
});

it("names each thing that is broken and the command that repairs it", async () => {
  const f = deploymentFixture(cleanup);
  expect((await deploy(first, f.runtime)).exitCode).toBe(0);
  f.cloud.buckets.get("mau-config")!.delete("mau.json");
  f.cloud.buckets.delete("mau-attachments");
  f.cloud.workers.get("mau-environment")!.vars.SOURCE_REVISION = "0".repeat(40);
  f.cloud.workers.get("mau-environment")!.secrets.CONTROL_TOKEN = "another";
  f.cloud.revision = "3".repeat(40);
  f.cloud.applications.length = 0;
  f.cloud.docker = false;
  f.cloud.partners = [{ agent: { id: "a1", name: "helper" }, environment: { state: "needs_action", error: "environment_operation_unconfirmed" } }];
  writeFileSync(join(f.directory, "config", "cloud", "codex-auth.json"), JSON.stringify({ tokens: { access_token: JSON.parse(codexAuth(1)).tokens.access_token } }));
  chmodSync(join(f.directory, "secrets"), 0o755);
  const { exitCode, report } = await doctor({ name: "mau" }, f.runtime);
  expect(exitCode).toBe(1);
  expect(failing(report.checks)).toEqual(["docker", "deployment", "bucket:mau-attachments", "r2-key-pair", "codex-sign-in", "gateway", "gateway-key", "access", "deployed-revision", "deployed-configuration", "partner:helper"]);
  expect(named(report.checks, "deployment")).toMatchObject({ detail: expect.stringContaining("readable by others"), fix: expect.stringContaining("chmod -R go-rwx") });
  expect(named(report.checks, "gateway")).toMatchObject({ detail: expect.stringContaining("this checkout pins"), fix: "mau deploy" });
  expect(named(report.checks, "deployed-revision").detail).toBe(`the Worker runs ${"1".repeat(40)}, this checkout is ${"3".repeat(40)}`);
  expect(named(report.checks, "codex-sign-in").detail).toContain("there is no refresh token");
  // With the key pair refused on a bucket, the objects cannot be compared; with nothing in front of the service, there is no sign-in to check with.
  expect(named(report.checks, "configuration-objects")).toMatchObject({ ok: null, detail: "needs a working R2 key pair" });
  expect(named(report.checks, "account")).toMatchObject({ ok: true });
  expect(named(report.checks, "partner:helper")).toMatchObject({ ok: false, detail: "environment needs action: environment_operation_unconfirmed", fix: "mau reconcile" });

  f.cloud.buckets.set("mau-attachments", new Map());
  const again = await doctor({}, f.runtime);
  expect(named(again.report.checks, "configuration-objects")).toMatchObject({ ok: false, detail: "missing or different in mau-config: cloud/codex-auth.json, mau.json", fix: "mau deploy" });
});

it("checks the machine alone when there is no deployment, and a service by its URL", async () => {
  const f = deploymentFixture(cleanup);
  const bare = await doctor({ name: "other" }, f.runtime);
  expect(bare.exitCode).toBe(1);
  expect(failing(bare.report.checks)).toEqual(["deployment"]);
  expect(named(bare.report.checks, "deployment").fix).toBe("mau deploy --hostname HOSTNAME --owner-email EMAIL");

  expect((await deploy(first, f.runtime)).exitCode).toBe(0);
  // Someone with the CLI only: no checkout, no Cloudflare credentials, a URL and an Access sign-in.
  const client = { ...f.runtime, root: join(f.home, "installed") + "/", env: {}, home: join(f.home, "elsewhere") };
  const remote = await doctor({ url: "https://mau.example.com/" }, client);
  expect(failing(remote.report.checks)).toEqual(["cloudflare-credentials"]);
  expect(remote.report.checks.filter((check) => check.ok === null).map((check) => check.check)).toEqual(["source-checkout", "wrangler", "deployment"]);
  expect(named(remote.report.checks, "environment-profile")).toMatchObject({ ok: true, detail: "profiles for this owner: codex" });
  // Signed out, the service checks say how to sign in.
  const original = f.runtime.effects.run;
  const signedOut = { ...client, effects: { ...f.runtime.effects, run: (command: string, args: string[]) => command === "cloudflared" && args[0] === "access" ? Promise.resolve({ code: 1, stdout: "", stderr: "" }) : original(command, args) } };
  expect(named((await doctor({ url: "https://mau.example.com" }, signedOut)).report.checks, "account")).toEqual({ check: "account", ok: null, detail: "no Access credential",
    fix: "cloudflared access login https://mau.example.com (or CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET of a service token)" });
});
