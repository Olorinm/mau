import { afterEach, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadServiceConfig } from "@agent-router/server";
import { createMau } from "../src/app.js";
import { environmentOptionsSchema } from "../src/environments.js";
import { deploy, type DeployInput } from "../src/deploy/index.js";
import { accessAudience, accessIssuer, accessTeam } from "./fixtures/access.js";
import { ACCOUNT, API_TOKEN, TEAM, codexAuth, deploymentFixture } from "./fixtures/deployment.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const first: DeployInput = { hostname: "mau.example.com", ownerEmail: "owner@example.com" };
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const statuses = (report: { steps: Array<{ step: string; status: string }> }) => Object.fromEntries(report.steps.map((step) => [step.step, step.status]));
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
/** What stands in the account, without the order it was made in. */
const inventory = (cloud: ReturnType<typeof deploymentFixture>["cloud"]) => ({
  buckets: [...cloud.buckets.keys()].sort(), objects: [...cloud.buckets].flatMap(([bucket, objects]) => [...objects.keys()].map((key) => `${bucket}/${key}`)).sort(),
  tokens: [...cloud.tokens.values()].map((token) => token.name), policies: [...cloud.policies.values()].map((policy) => policy.name).sort(),
  applications: cloud.applications.map((application) => application.domain).sort(), workers: [...cloud.workers.keys()].sort(), domains: [...cloud.domains.keys()],
  lifecycle: [...cloud.lifecycle].map(([bucket, rules]) => `${bucket}: ${rules.map((rule) => rule.id).join(",")}`),
});

it("deploys everything from two flags, and a second run changes nothing", async () => {
  const f = deploymentFixture(cleanup);
  const { exitCode, report } = await deploy(first, f.runtime);
  expect(report.steps.filter((step) => step.status === "failed")).toEqual([]);
  expect(exitCode).toBe(0);
  expect(report).toMatchObject({ ok: true, url: "https://mau.example.com", directory: f.directory, needsOwner: [],
    resources: { account: ACCOUNT, worker: "mau", gateway: { worker: "mau-environment", url: "https://mau-environment.example-sub.workers.dev" }, access: { teamDomain: `https://${TEAM}` } },
    next: ["cloudflared access login https://mau.example.com", "mau login https://mau.example.com", "mau partner create NAME --profile codex", "mau chat send NAME \"hello\""] });
  expect(statuses(report)).toEqual({ preflight: "skipped", "codex-auth": "done", buckets: "done", "r2-credentials": "done", gateway: "done", access: "done", config: "done", deploy: "done", verify: "skipped" });
  // Progress is one JSON line per step.
  expect(f.progress.map((line) => JSON.parse(line).step)).toEqual(report.steps.map((step) => step.step));

  expect(inventory(f.cloud)).toEqual({
    buckets: ["mau-access-logs", "mau-attachments", "mau-config", "mau-environment-backups", "mau-state"],
    objects: ["cloud/agent-host.sha256", "cloud/agent-host.tgz", "cloud/codex-auth.json", "cloud/host-profile.json", "cloud/start-host.sh", "gateway-key", "mau.env", "mau.json",
      "providers.json", "r2-access-key-id", "r2-secret-access-key"].map((key) => `mau-config/${key}`).concat("mau-environment-backups/artifacts/age-v1.3.2-linux-amd64").sort(),
    tokens: ["mau-container-r2"], policies: ["mau host link enroll", "mau host link socket", "mau liveness", "mau owner"],
    // Beside the owner's login, three paths need none: the liveness probe, and where a computer's Host enrolls and connects.
    applications: ["mau.example.com", "mau.example.com/_agent-router/v1/host-links/enroll", "mau.example.com/_agent-router/v1/host-links/socket", "mau.example.com/health/live"],
    workers: ["mau", "mau-environment"], domains: ["mau.example.com"], lifecycle: ["mau-access-logs: expire-after-30-days"] });
  // The container's key pair is limited to the three buckets it uses, and the Worker was given exactly that pair.
  const [token] = [...f.cloud.tokens];
  expect(token![1].buckets).toEqual(["mau-config", "mau-state", "mau-attachments"]);
  expect(f.cloud.workers.get("mau")).toEqual({ secrets: { R2_ACCESS_KEY_ID: token![0], R2_SECRET_ACCESS_KEY: sha256(token![1].value) },
    vars: { RUN: "true", CONFIG_REVISION: expect.stringMatching(/^[0-9a-f]{16}$/), SOURCE_REVISION: "1".repeat(40), R2_ENDPOINT: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
      CONFIG_BUCKET: "mau-config", STATE_BUCKET: "mau-state" } });
  expect(f.cloud.workers.get("mau-environment")!.vars).toMatchObject({ SOURCE_REVISION: JSON.parse(readFileSync(join(f.root, "components.json"), "utf8")).revision,
    BACKUP_RECIPIENT: expect.stringMatching(/^age1[0-9a-z]{58}$/), AGE_KEY: "artifacts/age-v1.3.2-linux-amd64", MAX_ENVIRONMENTS: "3" });
  expect(f.cloud.policies.get(f.cloud.applications[0]!.policies[0] && (f.cloud.applications[0]!.policies[0] as { id: string }).id)).toMatchObject({ decision: "allow", include: [{ email: { email: "owner@example.com" } }] });
  // The Host archive's manifest names the path the sandbox verifies it at.
  const objects = f.cloud.buckets.get("mau-config")!;
  expect(objects.get("cloud/agent-host.sha256")!.bytes.toString()).toBe(`${sha256(objects.get("cloud/agent-host.tgz")!.bytes)}  /opt/agent-environment/agent-host.tgz\n`);
  expect(objects.get("cloud/start-host.sh")!.bytes.toString()).toContain("agent-host serve");

  const writes = f.cloud.writes.length;
  const second = await deploy({}, f.runtime);
  expect(second.exitCode).toBe(0);
  expect(new Set(Object.values(statuses(second.report)))).toEqual(new Set(["skipped"]));
  expect(f.cloud.writes.length).toBe(writes);
});

it("keeps the deployment directory private and its record free of secrets, and prints none", async () => {
  const f = deploymentFixture(cleanup);
  f.cloud.wranglerNoise = `leaked ${API_TOKEN}`;
  f.cloud.fail = (write) => write === "deploy mau" ? "before" : undefined;
  const failed = await deploy(first, f.runtime);
  expect(failed.exitCode).toBe(1);
  expect(failed.report.steps.find((step) => step.step === "deploy")).toMatchObject({ status: "failed", detail: { error: "worker_deploy_failed", detail: expect.stringContaining("leaked [redacted]") } });
  f.cloud.fail = undefined;
  const { report } = await deploy({}, f.runtime);
  expect(report.ok).toBe(true);

  for (const path of [f.directory, join(f.directory, "config"), join(f.directory, "config", "cloud"), join(f.directory, "secrets")]) expect(statSync(path).mode & 0o777).toBe(0o700);
  for (const file of [...files(join(f.directory, "config")), ...files(join(f.directory, "secrets")), join(f.directory, "deployment.json")]) expect(statSync(file).mode & 0o777, file).toBe(0o600);

  const gateway = JSON.parse(readFileSync(join(f.directory, "secrets", "gateway.json"), "utf8")), [token] = [...f.cloud.tokens.values()];
  const identity = readFileSync(join(f.directory, "secrets", "environment-backup-identity.txt"), "utf8").trim().split("\n").at(-1)!;
  expect(identity).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
  const secrets = [API_TOKEN, gateway.CONTROL_TOKEN, gateway.ACCESS_SIGNING_KEY, token!.value, sha256(token!.value), identity, "codex-refresh-token-of-the-test", "codex-access-signature"];
  const printed = [readFileSync(join(f.directory, "deployment.json"), "utf8"), f.progress.join("\n"), JSON.stringify(failed.report), JSON.stringify(report)].join("\n");
  for (const secret of secrets) expect(printed.includes(secret), secret.slice(0, 12)).toBe(false);
  expect(Object.keys(JSON.parse(readFileSync(join(f.directory, "deployment.json"), "utf8")))).toEqual(expect.arrayContaining(["name", "hostname", "ownerEmail", "accountId", "gateway", "access", "config", "worker", "steps"]));
});

it("continues after a failure of any change, lost answers included, without making anything twice", async () => {
  const clean = deploymentFixture(cleanup);
  expect((await deploy(first, clean.runtime)).exitCode).toBe(0);
  const changes = clean.cloud.writes.length, expected = inventory(clean.cloud);
  expect(changes).toBeGreaterThan(20);
  for (const mode of ["before", "after"] as const) for (let index = 0; index < changes; index++) {
    const f = deploymentFixture(cleanup);
    f.cloud.fail = (_write, at) => at === index ? mode : undefined;
    const broken = await deploy(first, f.runtime), failed = broken.report.steps.filter((step) => step.status === "failed");
    expect(broken.exitCode, `${mode} ${clean.cloud.writes[index]}`).toBe(1);
    expect(failed).toHaveLength(1);
    expect(broken.report.next).toEqual(["mau deploy"]);
    f.cloud.fail = undefined;
    const resumed = await deploy({}, f.runtime);
    expect(resumed.report.steps.filter((step) => step.status === "failed"), `${mode} ${clean.cloud.writes[index]}`).toEqual([]);
    expect(resumed.exitCode).toBe(0);
    expect(inventory(f.cloud), `${mode} ${clean.cloud.writes[index]}`).toEqual(expected);
    const settled = f.cloud.writes.length;
    expect((await deploy({}, f.runtime)).exitCode).toBe(0);
    expect(f.cloud.writes.length).toBe(settled);
    rmSync(join(f.root, ".."), { recursive: true, force: true });
  }
}, 120_000);

it("asks the owner for what the credentials cannot do, goes on with the rest, and takes the result", async () => {
  const f = deploymentFixture(cleanup);
  f.cloud.denied = new Set(["tokens", "access", "dns"]);
  const { exitCode, report } = await deploy(first, f.runtime);
  expect(exitCode).toBe(2);
  expect(statuses(report)).toEqual({ preflight: "skipped", "codex-auth": "done", buckets: "done", "r2-credentials": "needs_owner", gateway: "done", access: "needs_owner", config: "not_run", deploy: "not_run", verify: "not_run" });
  expect(report.needsOwner.map((action) => [action.step, action.reason])).toEqual([["r2-credentials", "r2_key_pair_needs_owner"], ["access", "access_needs_owner"]]);
  expect(report.needsOwner[0]!.instructions[0]).toContain("mau-config, mau-state, mau-attachments");
  expect(report.next).toEqual(["mau deploy --r2-access-key-id-file FILE --r2-secret-access-key-file FILE --access-team-domain https://TEAM.cloudflareaccess.com --access-audience AUDIENCE_TAG"]);
  expect(JSON.parse(f.progress.find((line) => line.includes("access_needs_owner"))!)).toMatchObject({ step: "access", status: "needs_owner", detail: { needs: { instructions: expect.any(Array) } } });
  expect((report.steps[0]!.detail as { dns: string }).dns).toContain("not checked");
  expect([...f.cloud.workers.keys()]).toEqual(["mau-environment"]);

  // The owner makes the key pair and the two applications in the dashboard.
  f.cloud.tokens.set("owner-key-id", { name: "made by hand", value: "owner-token-value", buckets: ["mau-config", "mau-state", "mau-attachments"] });
  f.cloud.policies.set("p1", { name: "owner", decision: "allow", include: [] }); f.cloud.policies.set("p2", { name: "public", decision: "bypass", include: [] });
  f.cloud.applications.push({ id: "a1", name: "mau", domain: "mau.example.com", aud: "audience-tag", type: "self_hosted", policies: [{ id: "p1" }] },
    { id: "a2", name: "live", domain: "mau.example.com/health/live", aud: "other", type: "self_hosted", policies: [{ id: "p2" }] });
  writeFileSync(join(f.home, "key-id"), "owner-key-id\n"); writeFileSync(join(f.home, "key-secret"), "owner-secret-access-key\n");
  const half = await deploy({ r2AccessKeyIdFile: join(f.home, "key-id") }, f.runtime);
  expect(half.report.steps.find((step) => step.status === "failed")).toMatchObject({ step: "r2-credentials", detail: { error: "r2_key_files_incomplete" } });
  const done = await deploy({ r2AccessKeyIdFile: join(f.home, "key-id"), r2SecretAccessKeyFile: join(f.home, "key-secret"), accessTeamDomain: TEAM, accessAudience: "audience-tag" }, f.runtime);
  expect(done.report.steps.filter((step) => step.status === "failed")).toEqual([]);
  expect(done.exitCode).toBe(0);
  expect(JSON.parse(f.cloud.buckets.get("mau-config")!.get("mau.json")!.bytes.toString()).edgeIdentity).toEqual({ provider: "cloudflare-access", teamDomain: `https://${TEAM}`,
    audiences: ["audience-tag"], owners: { "owner@example.com": "@owner:mau.example.com" } });
  expect(f.cloud.workers.get("mau")!.secrets).toEqual({ R2_ACCESS_KEY_ID: "owner-key-id", R2_SECRET_ACCESS_KEY: "owner-secret-access-key" });
  expect(JSON.stringify(done.report)).not.toContain("owner-secret-access-key");
  // Later runs need no flag.
  const writes = f.cloud.writes.length;
  expect((await deploy({}, f.runtime)).exitCode).toBe(0);
  expect(f.cloud.writes.length).toBe(writes);
});

it("stops for the owner when Codex is not signed in, the account has no workers.dev subdomain, or Zero Trust is not set up", async () => {
  const f = deploymentFixture(cleanup);
  writeFileSync(join(f.home, ".codex", "auth.json"), "{}");
  expect((await deploy(first, f.runtime)).report.steps.find((step) => step.step === "codex-auth")).toMatchObject({ status: "failed", detail: { error: "codex_auth_invalid" } });
  const missing = await deploy({ ...first, codexAuth: join(f.home, "nowhere.json") }, f.runtime);
  expect(missing.exitCode).toBe(2);
  expect(missing.report.needsOwner).toMatchObject([{ step: "codex-auth", reason: "codex_login_missing", instructions: [expect.stringContaining("codex login")] }]);
  // Everything that does not need the sign-in was done meanwhile.
  expect(statuses(missing.report)).toMatchObject({ gateway: "done", access: "done", "r2-credentials": "done", config: "not_run" });
  writeFileSync(join(f.home, ".codex", "auth.json"), codexAuth());
  expect((await deploy({}, f.runtime)).exitCode).toBe(0);

  const g = deploymentFixture(cleanup);
  g.cloud.subdomain = undefined; g.cloud.team = undefined;
  const blocked = await deploy(first, g.runtime);
  expect(blocked.exitCode).toBe(2);
  expect(blocked.report.needsOwner).toMatchObject([{ step: "preflight", reason: "workers_dev_subdomain_missing" }]);
  expect(g.cloud.writes).toEqual([]);
  g.cloud.subdomain = "example-sub";
  const zeroTrust = await deploy({}, g.runtime);
  expect(zeroTrust.report.needsOwner).toMatchObject([{ step: "access", reason: "zero_trust_not_set_up" }]);
  g.cloud.team = TEAM;
  expect((await deploy({}, g.runtime)).exitCode).toBe(0);
});

it("refuses what cannot work before it changes anything", async () => {
  const f = deploymentFixture(cleanup);
  const code = async (input: DeployInput, change: () => void = () => undefined) => { change(); const { exitCode, report } = await deploy(input, f.runtime); return [exitCode, (report.steps.at(0)!.detail as { error: string }).error]; };
  expect(await code({})).toEqual([1, "hostname_required"]);
  expect(await code({ hostname: "mau.example.com" })).toEqual([1, "owner_email_required"]);
  expect(await code({ ...first, hostname: "not a hostname" })).toEqual([1, "hostname_invalid"]);
  expect(await code({ ...first, name: "Mau_1" })).toEqual([1, "name_invalid"]);
  expect(await code({ ...first, hostname: "mau.elsewhere.example" })).toEqual([1, "hostname_zone_not_found"]);
  expect(await code(first, () => { f.cloud.docker = false; })).toEqual([1, "docker_engine_unreachable"]);
  expect(await code(first, () => { f.cloud.docker = true; f.cloud.dns.push({ id: "r", type: "A", name: "mau.example.com" }); })).toEqual([1, "hostname_in_use"]);
  expect(await code(first, () => { f.cloud.dns = []; f.cloud.domains.set("mau.example.com", "another-worker"); })).toEqual([1, "hostname_in_use"]);
  // A Worker or a bucket that already has the deployment's name is someone else's.
  expect(await code(first, () => { f.cloud.domains.clear(); f.cloud.workers.set("mau", { vars: {}, secrets: {} }); })).toEqual([1, "name_in_use"]);
  expect(await code(first, () => { f.cloud.workers.clear(); f.cloud.buckets.set("mau-state", new Map()); })).toEqual([1, "name_in_use"]);
  expect((await deploy({ ...first, dryRun: true }, f.runtime)).report.steps[0]).toMatchObject({ status: "failed", detail: { detail: "the account already has bucket mau-state" } });
  expect(await code(first, () => { f.cloud.buckets.clear(); f.runtime.nodeVersion = "22.11.0"; })).toEqual([1, "node_24_required"]);
  f.runtime.nodeVersion = "24.22.2";
  // An installed client archive has no Dockerfile and no Worker source.
  const client = { ...f.runtime, root: join(f.home, "installed") + "/" };
  expect((await deploy(first, client)).report.steps[0]).toMatchObject({ status: "failed", detail: { error: "deploy_requires_source_checkout", fix: expect.stringContaining("git clone https://github.com/Olorinm/mau") } });
  expect(f.cloud.writes).toEqual([]);
  expect(existsSync(f.directory)).toBe(false);

  expect((await deploy(first, f.runtime)).exitCode).toBe(0);
  expect(await code({ hostname: "other.example.com" })).toEqual([1, "hostname_differs_from_deployment"]);
});

it("a dry run lists every change and makes none, here or at Cloudflare", async () => {
  const f = deploymentFixture(cleanup);
  const { exitCode, report } = await deploy({ ...first, dryRun: true }, f.runtime);
  expect(exitCode).toBe(0);
  expect(report).toMatchObject({ ok: false, dryRun: true, next: [] });
  expect(statuses(report)).toEqual({ preflight: "in_place", "codex-auth": "would_change", buckets: "would_change", "r2-credentials": "would_change", gateway: "would_change", access: "would_change",
    config: "would_change", deploy: "would_change", verify: "would_change" });
  const would = report.steps.flatMap((step) => (step.detail as { would?: string[] }).would ?? []);
  expect(would).toEqual(expect.arrayContaining(["create R2 bucket mau-config", "create API token mau-container-r2: object read and write on mau-config, mau-state, mau-attachments",
    "deploy Worker mau-environment (environment gateway, Agent Kit " + JSON.parse(readFileSync(join(f.root, "components.json"), "utf8")).version + ")",
    "create Access application for mau.example.com that admits owner@example.com only", "create Access application for mau.example.com/health/live that needs no login",
    "generate the configuration and upload it to mau-config", `deploy Worker mau at ${"1".repeat(40)} to mau.example.com (builds the image)`]));
  expect(f.cloud.writes).toEqual([]);
  expect(existsSync(f.directory)).toBe(false);
  expect(f.progress).toEqual([]);

  // With wrangler-login credentials the plan says what a human will be asked for.
  f.cloud.denied = new Set(["tokens", "access"]);
  const limited = await deploy({ ...first, dryRun: true }, f.runtime);
  expect(limited.exitCode).toBe(2);
  expect(limited.report.needsOwner.map((action) => action.step)).toEqual(["r2-credentials", "access"]);
  f.cloud.denied.clear();

  // On a deployment that stands, everything is in place, and an upgrade shows as the one deploy it is.
  expect((await deploy(first, f.runtime)).exitCode).toBe(0);
  const writes = f.cloud.writes.length, record = readFileSync(join(f.directory, "deployment.json"), "utf8");
  const standing = await deploy({ dryRun: true }, f.runtime);
  expect(standing.report.ok).toBe(true);
  expect(new Set(Object.values(statuses(standing.report)))).toEqual(new Set(["in_place"]));
  f.cloud.revision = "2".repeat(40);
  const upgrade = await deploy({ dryRun: true }, f.runtime);
  expect(statuses(upgrade.report)).toMatchObject({ config: "in_place", deploy: "would_change", verify: "would_change" });
  expect(f.cloud.writes.length).toBe(writes);
  expect(readFileSync(join(f.directory, "deployment.json"), "utf8")).toBe(record);
});

it("upgrades with the same command and keeps what the owner added to the configuration", async () => {
  const f = deploymentFixture(cleanup);
  expect((await deploy(first, f.runtime)).exitCode).toBe(0);
  const config = join(f.directory, "config"), mau = JSON.parse(readFileSync(join(config, "mau.json"), "utf8"));
  mau.environments.profiles.push({ ...mau.environments.profiles[0], id: "review", label: "Reviewer" });
  mau.edgeIdentity.serviceTokens = { "ops.access": "@owner:mau.example.com" };
  writeFileSync(join(config, "mau.json"), JSON.stringify(mau));
  writeFileSync(join(config, "mau.env"), readFileSync(join(config, "mau.env"), "utf8") + "AGENT_ATTACHMENT_QUOTA_BYTES=1000000\n");
  writeFileSync(join(config, "backup.json"), "{}\n", { mode: 0o600 });
  f.cloud.revision = "2".repeat(40);
  const before = f.cloud.writes.length, revision = f.cloud.workers.get("mau")!.vars.CONFIG_REVISION;
  const { exitCode, report } = await deploy({}, f.runtime);
  expect(exitCode).toBe(0);
  expect(statuses(report)).toMatchObject({ gateway: "skipped", access: "skipped", "r2-credentials": "skipped", config: "done", deploy: "done" });
  expect(f.cloud.writes.slice(before)).toEqual(["put mau-config/backup.json", "put mau-config/mau.env", "put mau-config/mau.json", "deploy mau"]);
  const uploaded = JSON.parse(f.cloud.buckets.get("mau-config")!.get("mau.json")!.bytes.toString());
  expect(uploaded.environments.profiles.map((profile: { id: string }) => profile.id)).toEqual(["codex", "review"]);
  expect(uploaded.edgeIdentity.serviceTokens).toEqual({ "ops.access": "@owner:mau.example.com" });
  expect(f.cloud.buckets.get("mau-config")!.get("mau.env")!.bytes.toString()).toContain("AGENT_ATTACHMENT_QUOTA_BYTES=1000000");
  // The container restarts for the new configuration, and the daily backup is switched on with its file.
  expect(f.cloud.workers.get("mau")!.vars).toMatchObject({ SOURCE_REVISION: "2".repeat(40), BACKUP_HOUR_UTC: "19" });
  expect(f.cloud.workers.get("mau")!.vars.CONFIG_REVISION).not.toBe(revision);
  // A working tree that differs from its commit is always deployed again, and says so.
  f.cloud.dirty = true;
  expect((await deploy({}, f.runtime)).report.steps.find((step) => step.step === "deploy")).toMatchObject({ status: "done", detail: { revision: "2".repeat(40) + "-dirty" } });
});

it("fails when the service does not come up behind Access", async () => {
  const f = deploymentFixture(cleanup);
  f.cloud.denied = new Set(["access"]);
  expect((await deploy(first, f.runtime)).exitCode).toBe(2);
  // The owner reports an application that was never made: nothing protects the hostname.
  const { exitCode, report } = await deploy({ accessTeamDomain: `https://${TEAM}`, accessAudience: "audience-tag" }, f.runtime);
  expect(exitCode).toBe(1);
  expect(report.steps.at(-1)).toMatchObject({ step: "verify", status: "failed", detail: { error: "access_not_protecting" } });
  expect(report.next).toEqual(["mau deploy"]);
});

it("generates a configuration the server starts on, with the owner mapped to the only profile", async () => {
  const f = deploymentFixture(cleanup);
  f.cloud.denied = new Set(["access"]);
  await deploy(first, f.runtime);
  expect((await deploy({ accessTeamDomain: accessTeam, accessAudience: accessAudience }, f.runtime)).report.steps.find((step) => step.step === "config")!.status).toBe("done");
  // As the container sees it: the configuration bucket at /config, mau.env as the environment.
  const config = join(f.directory, "config");
  const environment = Object.fromEntries(readFileSync(join(config, "mau.env"), "utf8").split("\n").filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).replace(/^\/config\//, config + "/")]));
  expect(environment).toMatchObject({ MATRIX_SERVER_NAME: "mau.example.com", AGENT_SERVICE_URL: "https://mau.example.com/_agent-router/v1", AGENT_BLOB_STORE: "r2", AGENT_R2_BUCKET: "mau-attachments" });
  const options = JSON.parse(readFileSync(join(config, "mau.json"), "utf8"));
  expect(environmentOptionsSchema.parse(options.environments).profiles).toMatchObject([{ id: "codex", provider: "cloudflare", template: "node24", runtimeId: "personal",
    owners: ["@owner:mau.example.com"], onTimeout: "pause", lifetimeSeconds: 1800, idlePauseSeconds: 600 }]);
  expect(options.nativeWork).toEqual({ partnerTools: true });
  const host = JSON.parse(readFileSync(join(config, "cloud", "host-profile.json"), "utf8"));
  expect(host.runtimes).toMatchObject([{ id: "personal", kernel: "codex", cwd: "/home/user/workspace" }]);

  const access = await accessIssuer(cleanup);
  const mau = createMau({ ...loadServiceConfig(environment), stateDir: join(f.home, "state") }, join(config, "mau.json"), { router: { edgeIdentityCerts: access.certsUrl } });
  const server = mau.app.listen(0, "127.0.0.1");
  mau.attach(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await mau.close(); });
  await mau.start();
  const call = async (path: string, email: string) => { const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`,
    { headers: { "cf-access-jwt-assertion": access.jwt({ email }) } }); return { status: response.status, data: await response.json() }; };
  expect(await call("/_mau/v1/account", "owner@example.com")).toMatchObject({ status: 200, data: { owner: "@owner:mau.example.com", via: "edge" } });
  expect((await call("/_mau/v1/options", "owner@example.com")).data).toEqual({ environments: [{ id: "codex", label: "Codex", kernel: "codex", kernels: ["codex"] }],
    // No host links are connected yet, so this server offers no partners on the owner's computer.
    external: false });
  expect(await call("/_mau/v1/account", "stranger@example.com")).toMatchObject({ status: 403, data: { error: "owner_not_configured" } });
  // The provider file names the gateway and a key file the Environment package accepts (private, beside it).
  const { loadConfiguration } = await import("@olorinm/agent-environment");
  expect((await loadConfiguration(join(config, "providers.json"))).provider("cloudflare")).toBeDefined();
});
