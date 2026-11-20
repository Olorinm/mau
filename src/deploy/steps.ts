// The steps of a deployment, in order. Each one looks at what exists (at Cloudflare, not only in the local record),
// then makes what is missing through `Context.act`, which a dry run lists instead of doing.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cloudflare, CloudflareError, bucketResource, r2Endpoint, type AccessApplication } from "./cloudflare.js";
import type { Runtime } from "./effects.js";
import { generateAgeKeyPair } from "./age.js";
import { renderConfig, renderGatewayWrangler, renderWorkerWrangler } from "./render.js";
import { Bucket, type S3Credentials } from "./s3.js";
import { AGE, DeployError, Source, inspectCodexAuth, type Pin } from "./source.js";
import { configRevision, containerBuckets, resources, sha256, type Deployment, type Directory, type OwnerAction } from "./state.js";
import { HOST_LINK_PATHS } from "./host-links.js";

export interface DeployInput {
  hostname?: string; ownerEmail?: string; name?: string; dir?: string; codexAuth?: string;
  r2AccessKeyIdFile?: string; r2SecretAccessKeyFile?: string; accessTeamDomain?: string; accessAudience?: string;
  dryRun?: boolean;
}
export type StepId = "preflight" | "codex-auth" | "buckets" | "r2-credentials" | "gateway" | "access" | "config" | "deploy" | "verify";
export interface Step { id: StepId; needs: StepId[]; run(context: Context): Promise<OwnerAction | void> }

const LIFECYCLE_RULE = "expire-after-30-days";
const OBJECT_WRITE = "Workers R2 Storage Bucket Item Write";
const TOKEN_DOC = "docs/deployment.md#api-token";

export class Context {
  readonly source: Source;
  readonly names: ReturnType<typeof resources>;
  /** What the running step changed, or in a dry run would change. */
  changes: string[] = [];
  /** What the running step found, for its progress line. */
  detail: Record<string, unknown> = {};
  /** Every change of this run so far, across steps. In a dry run none of them has happened. */
  private readonly planned = new Set<string>();
  /** Things an owner should know once the deployment stands. */
  readonly notes: string[] = [];
  private readonly concealed = new Set<string>();
  private client?: Cloudflare;
  pin?: Pin;
  revision?: string;

  constructor(readonly runtime: Runtime, readonly input: DeployInput, readonly directory: Directory, readonly record: Deployment, readonly dryRun: boolean) {
    this.source = new Source(runtime);
    this.names = resources(record.name);
  }
  get effects() { return this.runtime.effects; }
  get cloudflare() { if (!this.client) throw new DeployError("cloudflare_credentials_required"); return this.client; }
  set cloudflare(client: Cloudflare) { this.client = client; this.conceal(client.credentials.token); }
  get accountId() { if (!this.record.accountId) throw new DeployError("cloudflare_account_unknown"); return this.record.accountId; }

  /** Makes a change, unless this is a dry run. Either way the change is listed. */
  async act(what: string, change: () => Promise<void> | void) {
    this.changes.push(what);
    this.planned.add(what);
    if (!this.dryRun) await change();
  }
  /** Whether this run has changed, or in a dry run would change, anything. */
  get outstanding() { return this.planned.size > 0; }
  /** Whether a dry run has listed this change: what it would make does not exist yet. */
  pending(what: string) { return this.dryRun && this.planned.has(what); }
  /** A deployed Worker's variables and secret names; undefined when there is none or it may not be read. */
  async settings(script: string) {
    try { return await this.cloudflare.workerSettings(script); }
    catch (error) { if (error instanceof CloudflareError && error.denied) return undefined; throw error; }
  }
  save() { if (!this.dryRun) this.directory.save(this.record); }
  /** A value that must never be printed. */
  conceal<T extends string | undefined>(value: T): T { if (value) this.concealed.add(value); return value; }
  redact(text: string) { let out = text; for (const secret of this.concealed) out = out.split(secret).join("[redacted]"); return out; }
  secret(name: string) { return this.conceal(this.directory.readSecret(name)); }
  /** The command that goes on after an owner did their part. */
  continueWith(flags = "") {
    return ["mau deploy", this.input.dir ? `--dir ${this.directory.path}` : this.record.name === "mau" ? "" : `--name ${this.record.name}`, flags].filter(Boolean).join(" ");
  }
  /** The container's key pair as S3 credentials, when the deployment has one. */
  s3(): S3Credentials | undefined {
    const accessKeyId = this.secret("r2-access-key-id"), secretAccessKey = this.secret("r2-secret-access-key");
    return accessKeyId && secretAccessKey && this.record.accountId ? { endpoint: r2Endpoint(this.record.accountId), accessKeyId, secretAccessKey } : undefined;
  }
  async wrangler(args: string[], failure: string, timeoutMs?: number) {
    const result = await this.source.wrangler(args, this.accountId, timeoutMs);
    if (result.code !== 0) throw new DeployError(failure, (result.stderr.trim() || result.stdout.trim()).slice(-1500));
    return result;
  }
  get gatewayDirectory() { return join(this.directory.path, "gateway"); }
  gatewayUrl() { return this.record.workersSubdomain ? `https://${this.names.gateway}.${this.record.workersSubdomain}.workers.dev` : undefined; }
  gatewaySecrets(): { CONTROL_TOKEN: string; ACCESS_SIGNING_KEY: string } | undefined {
    const text = this.directory.read(this.directory.secret("gateway.json"))?.toString("utf8");
    if (!text) return undefined;
    const secrets = JSON.parse(text) as { CONTROL_TOKEN: string; ACCESS_SIGNING_KEY: string };
    this.conceal(secrets.CONTROL_TOKEN); this.conceal(secrets.ACCESS_SIGNING_KEY);
    return secrets;
  }
}

const tokenAdvice = (permission: string) => `Or set CLOUDFLARE_API_TOKEN to a token that has "${permission}" (${TOKEN_DOC}) and run the same command again.`;

/** Polls until `check` answers something. */
async function until<T>(context: Context, seconds: number, check: () => Promise<T | undefined>): Promise<T | undefined> {
  for (let waited = 0; ; waited += 5) {
    const value = await check();
    if (value !== undefined || waited >= seconds) return value;
    await context.effects.sleep(5000);
  }
}
const getJson = async (context: Context, url: string, headers: Record<string, string> = {}) => {
  try {
    const response = await context.effects.fetch(url, { headers, redirect: "manual" });
    return { status: response.status, location: response.headers.get("location"), body: await response.json().catch(() => undefined) as Record<string, unknown> | undefined };
  } catch { return { status: 0, location: null, body: undefined }; }
};

const preflight: Step = { id: "preflight", needs: [], async run(context) {
  const { source, record, runtime } = context;
  if (Number(runtime.nodeVersion.split(".")[0]) < 24) throw new DeployError("node_24_required", `this is Node.js ${runtime.nodeVersion}`, "Install Node.js 24 or later.");
  source.assertCheckout();
  const pin = context.pin = source.pin();
  context.revision = await source.revision();
  if (source.staleArchives(pin).length) {
    await context.act(`download the Agent Kit ${pin.version} archives (node scripts/bootstrap.mjs)`, async () => {
      const result = await context.effects.run(process.execPath, [source.path("scripts", "bootstrap.mjs")], { cwd: source.root, timeoutMs: 900_000 });
      if (result.code !== 0 || source.staleArchives(pin).length) throw new DeployError("platform_archives_missing", result.stderr.trim().slice(-800), "node scripts/bootstrap.mjs");
    });
  }
  if (!existsSync(source.wranglerBinary)) {
    await context.act("install the pinned Wrangler (npm ci in cloudflare/)", async () => {
      const result = await context.effects.run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: source.path("cloudflare"), timeoutMs: 900_000 });
      if (result.code !== 0) throw new DeployError("wrangler_install_failed", result.stderr.trim().slice(-800), `npm --prefix ${source.path("cloudflare")} ci`);
    });
  }
  // Wrangler builds the image with the local engine: https://developers.cloudflare.com/containers/
  const docker = await context.effects.run(runtime.env.WRANGLER_DOCKER_BIN ?? "docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 30_000 });
  if (docker.code !== 0) throw new DeployError("docker_engine_unreachable", docker.stderr.trim().slice(-300), "Start Docker (or another Docker-compatible engine) and run the same command again.");

  context.cloudflare = new Cloudflare(context.effects, await source.credentials());
  let zone;
  try { zone = await context.cloudflare.zoneOf(record.hostname); }
  catch (error) {
    if (error instanceof CloudflareError && error.denied) throw new DeployError("cloudflare_credentials_refused", error.message, `The credentials need "Zone Read" (${TOKEN_DOC}).`);
    throw error;
  }
  if (!zone) throw new DeployError("hostname_zone_not_found", `no zone these credentials can see contains ${record.hostname}`, "Add the domain to the Cloudflare account first, or use a hostname of a domain that is in it.");
  if (zone.status !== "active") throw new DeployError("hostname_zone_not_active", `zone ${zone.name} is ${zone.status}`, "Finish adding the domain to Cloudflare (nameservers) first.");
  const wanted = runtime.env.CLOUDFLARE_ACCOUNT_ID?.trim() || record.accountId;
  if (wanted && wanted !== zone.account.id) throw new DeployError("hostname_zone_in_another_account", `zone ${zone.name} is not in the account this deployment uses`);
  record.accountId = zone.account.id;
  record.zone = { id: zone.id, name: zone.name };
  context.cloudflare = context.cloudflare.forAccount(zone.account.id);
  context.detail = { account: zone.account.id, zone: zone.name, credentials: context.cloudflare.credentials.source, revision: context.revision, agentKit: pin.version,
    plan: "not checked: Cloudflare documents no way to read the Workers plan; containers need Workers Paid" };

  // A new deployment makes everything under its name. What already carries that name belongs to something else.
  if (!context.directory.load()) {
    const exists = async (kind: string, name: string, look: () => Promise<unknown>) => {
      try { return await look() ? `${kind} ${name}` : undefined; } catch (error) { if (error instanceof CloudflareError) return undefined; throw error; }
    };
    const taken = (await Promise.all([
      ...[context.names.worker, context.names.gateway].map((worker) => exists("Worker", worker, () => context.settings(worker))),
      ...Object.values(context.names.buckets).map((bucket) => exists("bucket", bucket, () => context.cloudflare.bucketExists(bucket))),
    ])).filter((found) => found !== undefined);
    if (taken.length) throw new DeployError("name_in_use", `the account already has ${taken.join(", ")}`, "Choose another --name. Deploy never takes over what it did not make.");
  }
  // Without a terminal Wrangler replaces a DNS record that is in the way of a Custom Domain. Refuse instead.
  // https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
  try {
    const service = await context.cloudflare.customDomainService(record.hostname);
    if (service && service !== context.names.worker) throw new DeployError("hostname_in_use", `${record.hostname} is the Custom Domain of the Worker ${service}`, "Choose another hostname or another --name.");
    const records = service ? [] : await context.cloudflare.dnsRecords(zone.id, record.hostname);
    if (records.length) throw new DeployError("hostname_in_use", `${record.hostname} has a DNS record (${records.map((item) => item.type).join(", ")})`, "Delete that record or choose another hostname.");
  } catch (error) {
    if (!(error instanceof CloudflareError && error.denied)) throw error;
    context.detail.dns = "not checked (no DNS Read permission): a DNS record that already exists for the hostname would be replaced";
  }
  const subdomain = await context.cloudflare.workersSubdomain();
  if (subdomain) record.workersSubdomain = subdomain;
  context.save();
  if (!subdomain) return { reason: "workers_dev_subdomain_missing", continue: context.continueWith(),
    instructions: [`Open https://dash.cloudflare.com/${zone.account.id}/workers/onboarding and choose the account's workers.dev subdomain. The environment gateway is served there.`] };
} };

const codexAuth: Step = { id: "codex-auth", needs: ["preflight"], async run(context) {
  const target = join(context.directory.config, "cloud", "codex-auth.json"), current = context.directory.read(target);
  const from = context.input.codexAuth ?? (current ? undefined : join(context.runtime.home, ".codex", "auth.json"));
  if (from) {
    if (!existsSync(from)) return { reason: "codex_login_missing", continue: context.continueWith(),
      instructions: [`${from} does not exist. Run \`codex login\` (npm install --global @openai/codex) on this machine, or pass --codex-auth FILE. Partners use this sign-in for their model.`] };
    const bytes = readFileSync(from), inspected = inspectCodexAuth(bytes);
    if (!inspected.ok) throw new DeployError("codex_auth_invalid", `${from}: ${inspected.detail}`, "Run `codex login` again.");
    if (!current?.equals(bytes)) await context.act("copy the Codex sign-in into the deployment's configuration", () => context.directory.write(target, bytes));
  }
  context.detail = { login: inspectCodexAuth(context.directory.read(target) ?? readFileSync(from!)).detail };
} };

const buckets: Step = { id: "buckets", needs: ["preflight"], async run(context) {
  const { cloudflare, names } = context;
  try {
    for (const bucket of Object.values(names.buckets)) {
      const exists = await cloudflare.bucketExists(bucket);
      if (!exists) await context.act(`create R2 bucket ${bucket}`, async () => { await cloudflare.createBucket(bucket); });
      if (bucket !== names.buckets.accessLogs) continue;
      // Access records are kept for 30 days: https://developers.cloudflare.com/r2/buckets/object-lifecycles/
      const rules = exists || !context.dryRun ? await cloudflare.lifecycleRules(bucket) : [];
      if (!rules.some((rule) => rule.id === LIFECYCLE_RULE)) await context.act(`delete objects of ${bucket} 30 days after they were written`, async () => {
        await cloudflare.setLifecycleRules(bucket, [...rules, { id: LIFECYCLE_RULE, enabled: true, conditions: { prefix: "" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 30 * 86400 } } }]);
      });
    }
  } catch (error) {
    if (!(error instanceof CloudflareError)) throw error;
    if (error.codes.includes(10042)) return { reason: "r2_not_enabled", continue: context.continueWith(),
      instructions: [`Open https://dash.cloudflare.com/${context.accountId}/r2 and enable R2 for the account (it asks for a payment method).`] };
    if (error.denied) throw new DeployError("r2_permission_missing", error.message, `The credentials need "Workers R2 Storage Edit" (${TOKEN_DOC}).`);
    throw error;
  }
  context.detail = { buckets: Object.values(names.buckets) };
} };

const r2Credentials: Step = { id: "r2-credentials", needs: ["buckets"], async run(context) {
  const { cloudflare, names, record, input, directory } = context, limited = containerBuckets(record.name);
  const store = (accessKeyId: string, secretAccessKey: string) => {
    directory.write(directory.secret("r2-access-key-id"), context.conceal(accessKeyId) + "\n");
    directory.write(directory.secret("r2-secret-access-key"), context.conceal(secretAccessKey) + "\n");
  };
  const works = async () => {
    const credentials = context.s3();
    if (!credentials) return false;
    for (const bucket of limited) if (!await new Bucket(context.effects, credentials, bucket).reachable()) return false;
    return true;
  };
  const manual = (reason: string): OwnerAction => ({ reason, continue: context.continueWith("--r2-access-key-id-file FILE --r2-secret-access-key-file FILE"), instructions: [
    `Cloudflare dashboard, R2, "Manage API tokens", "Create Account API token": permission "Object Read & Write", applied to these buckets only: ${limited.join(", ")}.`,
    "Save the Access Key ID and the Secret Access Key it shows, each in a file only you can read, and pass the two files.",
    tokenAdvice("Account API Tokens Edit") ] });

  if (input.r2AccessKeyIdFile || input.r2SecretAccessKeyFile) {
    if (!input.r2AccessKeyIdFile || !input.r2SecretAccessKeyFile) throw new DeployError("r2_key_files_incomplete", "both --r2-access-key-id-file and --r2-secret-access-key-file are needed");
    const id = readFileSync(input.r2AccessKeyIdFile, "utf8").trim(), secret = context.conceal(readFileSync(input.r2SecretAccessKeyFile, "utf8").trim());
    if (id !== context.secret("r2-access-key-id") || secret !== context.secret("r2-secret-access-key"))
      await context.act("store the R2 key pair the owner created", () => { store(id, secret); record.r2 = { source: "owner" }; context.save(); });
    if (context.dryRun) return;
  }
  const pending = limited.some((bucket) => context.pending(`create R2 bucket ${bucket}`));
  if (context.s3() && (pending || await works())) { context.detail = { keyPair: record.r2?.source ?? "owner", buckets: limited }; return; }
  if (context.s3() && record.r2?.source !== "api") return manual("r2_key_pair_refused");

  // An R2 key pair is an account API token limited to buckets: the access key id is the token's id, the secret
  // access key the SHA-256 of its value. https://developers.cloudflare.com/r2/api/tokens/
  let group: string | undefined, existing: string | undefined;
  try { group = await cloudflare.permissionGroup(OBJECT_WRITE); existing = await cloudflare.tokenNamed(names.r2Token); }
  catch (error) { if (error instanceof CloudflareError && error.denied) return manual("r2_key_pair_needs_owner"); throw error; }
  if (!group) throw new DeployError("r2_permission_group_not_found", `no permission group named "${OBJECT_WRITE}"`);
  try {
    await context.act(existing ? `give API token ${names.r2Token} a new value (the deployment has lost the old one)` : `create API token ${names.r2Token}: object read and write on ${limited.join(", ")}`, async () => {
      const token = existing ? { id: existing, value: await cloudflare.rollToken(existing) }
        : await cloudflare.createToken(names.r2Token, group, limited.map((bucket) => bucketResource(context.accountId, bucket)));
      context.conceal(token.value);
      store(token.id, sha256(token.value));
      record.r2 = { source: "api", tokenId: token.id };
      context.save();
      // A new token takes a moment to be accepted by R2.
      if (!await until(context, 90, async () => await works() || undefined)) throw new DeployError("r2_key_pair_not_accepted", "R2 still refuses the new key pair", `Run ${context.continueWith()} again in a minute.`);
    });
  } catch (error) { if (error instanceof CloudflareError && error.denied) return manual("r2_key_pair_needs_owner"); throw error; }
  context.detail = { keyPair: "api", buckets: limited };
} };

const gateway: Step = { id: "gateway", needs: ["buckets"], async run(context) {
  const { cloudflare, names, record, directory, source } = context, pin = context.pin!;
  if (!context.gatewaySecrets()) await context.act("generate the gateway's control token and signing key", () =>
    directory.write(directory.secret("gateway.json"), JSON.stringify({ CONTROL_TOKEN: randomBytes(32).toString("base64url"), ACCESS_SIGNING_KEY: randomBytes(32).toString("base64url") }) + "\n"));
  // Sandbox backups are encrypted to this recipient. Its identity stays on the owner's machine.
  const identityFile = directory.secret("environment-backup-identity.txt");
  if (!directory.read(identityFile)) await context.act("generate the age identity that decrypts sandbox backups", () => {
    const pair = generateAgeKeyPair();
    directory.write(identityFile, `# public key: ${pair.recipient}\n${pair.identity}\n`);
  });
  const identity = directory.read(identityFile)?.toString("utf8");
  if (identity) context.conceal(identity.trim().split("\n").at(-1));
  const recipient = /^# public key: (age1[0-9a-z]{58})$/m.exec(identity ?? "")?.[1];

  // The gateway's source is part of the pinned environment package, whose bytes preflight has checked.
  const unpacked = join(context.gatewayDirectory, "revision");
  if (directory.read(unpacked)?.toString("utf8") !== pin.revision) await context.act(`unpack the environment gateway of Agent Kit ${pin.version}`, async () => {
    rmSync(context.gatewayDirectory, { recursive: true, force: true });
    mkdirSync(context.gatewayDirectory, { recursive: true, mode: 0o700 });
    const result = await context.effects.run("tar", ["-xzf", source.archive("environment"), "-C", context.gatewayDirectory, "package/cloudflare"]);
    if (result.code !== 0) throw new DeployError("gateway_source_unpack_failed", result.stderr.trim().slice(-300));
    directory.write(unpacked, pin.revision);
  });

  const backups = names.buckets.environmentBackups, artifact = `${backups}/${AGE.key}`;
  const scratch = mkdtempSync(join(tmpdir(), "mau-deploy-"));
  try {
    const fetched = join(scratch, "age");
    const present = !context.pending(`create R2 bucket ${backups}`) && existsSync(source.wranglerBinary) && await cloudflare.bucketExists(backups) &&
      (await source.wrangler(["r2", "object", "get", artifact, "--remote", "--file", fetched], context.accountId)).code === 0 && sha256(readFileSync(fetched)) === AGE.binarySha256;
    if (!present) await context.act(`upload age ${AGE.version} (the sandbox backup program) to ${backups}`, async () => {
      const response = await context.effects.fetch(AGE.url);
      const archive = Buffer.from(await response.arrayBuffer());
      if (!response.ok || sha256(archive) !== AGE.archiveSha256) throw new DeployError("age_download_failed", `${AGE.url}: ${response.status}, or not the pinned bytes`);
      writeFileSync(join(scratch, "age.tar.gz"), archive);
      const unpack = await context.effects.run("tar", ["-xzf", join(scratch, "age.tar.gz"), "-C", scratch, "age/age"]);
      if (unpack.code !== 0 || sha256(readFileSync(join(scratch, "age", "age"))) !== AGE.binarySha256) throw new DeployError("age_download_failed", "the archive does not hold the pinned program");
      await context.wrangler(["r2", "object", "put", artifact, "--remote", "--file", join(scratch, "age", "age")], "age_upload_failed");
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }

  const url = context.gatewayUrl()!, secrets = context.gatewaySecrets();
  const live = async () => {
    if (!secrets) return undefined;
    const health = await getJson(context, `${url}/health`);
    if (health.status !== 200 || health.body?.revision !== pin.revision) return undefined;
    return (await getJson(context, `${url}/v1/environments`, { "X-Environment-Control": secrets.CONTROL_TOKEN })).status === 200 || undefined;
  };
  const wanted = recipient && existsSync(join(context.gatewayDirectory, "package")) ? renderGatewayWrangler({ name: record.name, accountId: context.accountId, directory: context.gatewayDirectory, pin, backupRecipient: recipient }) : undefined;
  if (!wanted && !context.dryRun) throw new DeployError("backup_identity_unreadable", `${identityFile} does not name its public key`);
  const deployed = wanted && await live() ? await context.settings(names.gateway) : undefined;
  if (!deployed || Object.entries(wanted!.vars as Record<string, string>).some(([key, value]) => deployed.vars[key] !== value)) {
    await context.act(`deploy Worker ${names.gateway} (environment gateway, Agent Kit ${pin.version})`, async () => {
      const config = join(directory.path, "environment.wrangler.json");
      directory.write(config, JSON.stringify(wanted, null, 2) + "\n");
      await context.wrangler(["deploy", "--config", config, "--secrets-file", directory.secret("gateway.json")], "gateway_deploy_failed", 600_000);
      if (!await until(context, 120, live)) throw new DeployError("gateway_not_answering", `${url}/health does not report revision ${pin.revision}, or refuses the control token`, `Run ${context.continueWith()} again.`);
    });
  }
  record.gateway = { url, revision: pin.revision };
  context.save();
  context.detail = { worker: names.gateway, url, revision: pin.revision };
  context.notes.push(`Keep a copy of ${identityFile} in a password manager: only it decrypts the backups the gateway makes of partner sandboxes.`);
} };

const access: Step = { id: "access", needs: ["preflight"], async run(context) {
  const { cloudflare, record, input } = context, liveness = `${record.hostname}/health/live`;
  // What needs no owner sign-in: the liveness probe, and where a computer's Host enrolls and connects with its own credential.
  const open = [{ domain: liveness, name: `${record.name} liveness` },
    { domain: record.hostname + HOST_LINK_PATHS.enroll, name: `${record.name} host link enroll` }, { domain: record.hostname + HOST_LINK_PATHS.socket, name: `${record.name} host link socket` }];
  const manual = (reason: string): OwnerAction => ({ reason, continue: context.continueWith("--access-team-domain https://TEAM.cloudflareaccess.com --access-audience AUDIENCE_TAG"), instructions: [
    `Zero Trust dashboard (https://one.dash.cloudflare.com/), Access, Applications, "Add an application", Self-hosted: public hostname ${record.hostname}; one policy with action Allow that includes the email ${record.ownerEmail}.`,
    `Add a self-hosted application for each of these paths of ${record.hostname}, with one policy with action Bypass that includes Everyone: ${open.map(({ domain }) => domain.slice(record.hostname.length + 1)).join(", ")}. They keep the liveness probe, and the computers that pair with a partner, reachable without a login.`,
    "Pass the first application's Application Audience (AUD) Tag and the team domain (Settings, Team name and domain).",
    tokenAdvice("Access: Apps and Policies Edit") ] });

  if (input.accessTeamDomain || input.accessAudience) {
    if (!input.accessTeamDomain || !input.accessAudience) throw new DeployError("access_flags_incomplete", "both --access-team-domain and --access-audience are needed");
    const teamDomain = "https://" + input.accessTeamDomain.replace(/^https:\/\//, "").replace(/\/$/, "");
    if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)) throw new DeployError("access_team_domain_invalid", input.accessTeamDomain, "It looks like https://TEAM.cloudflareaccess.com");
    if (record.access?.teamDomain !== teamDomain || record.access.audience !== input.accessAudience)
      await context.act("record the Access application the owner created", () => { record.access = { source: "owner", teamDomain, audience: input.accessAudience! }; context.save(); });
  }
  if (record.access?.source === "owner" || context.changes.length) { context.detail = { teamDomain: record.access?.teamDomain ?? input.accessTeamDomain, application: "created by the owner" }; return; }

  // https://developers.cloudflare.com/cloudflare-one/access-controls/policies/ : a path that must stay public gets
  // its own application with a Bypass policy; the more specific path wins.
  let team: string | undefined, application: AccessApplication | undefined;
  try {
    team = await cloudflare.accessTeamDomain();
    if (!team) return { reason: "zero_trust_not_set_up", continue: context.continueWith(),
      instructions: ["Open https://one.dash.cloudflare.com/, choose a team name and the Free plan. Cloudflare Access is the only login of Mau."] };
    application = await cloudflare.accessApplication(record.hostname);
    const ensure = async (domain: string, name: string, decision: "allow" | "bypass", include: unknown[]) => {
      const policy = await cloudflare.accessPolicy(name) ?? await cloudflare.createAccessPolicy(name, decision, include);
      return cloudflare.createAccessApplication(name, domain, policy);
    };
    if (!application) await context.act(`create Access application for ${record.hostname} that admits ${record.ownerEmail} only`, async () => {
      application = await ensure(record.hostname, `${record.name} owner`, "allow", [{ email: { email: record.ownerEmail } }]);
    });
    for (const { domain, name } of open) if (!await cloudflare.accessApplication(domain)) await context.act(`create Access application for ${domain} that needs no login`, async () => {
      await ensure(domain, name, "bypass", [{ everyone: {} }]);
    });
  } catch (error) { if (error instanceof CloudflareError && error.denied) return manual("access_needs_owner"); throw error; }
  if (application) { record.access = { source: "api", teamDomain: `https://${team}`, audience: application.aud, applicationId: application.id }; context.save(); }
  context.detail = { teamDomain: `https://${team}`, application: application?.id ?? "to be created" };
} };

const config: Step = { id: "config", needs: ["codex-auth", "r2-credentials", "gateway", "access"], async run(context) {
  const { record, directory, names } = context, credentials = context.s3(), secrets = context.gatewaySecrets();
  const startHost = join(context.gatewayDirectory, "package", "cloudflare", "examples", "start-host.sh");
  if (!credentials || !secrets || !record.gateway || !record.access || !existsSync(startHost)) {
    // Only a dry run comes here: what the steps before this one make does not exist yet.
    if (!context.dryRun) throw new DeployError("configuration_inputs_missing");
    await context.act(`generate the configuration and upload it to ${names.buckets.config}`, () => undefined);
    return;
  }
  const local = directory.configFiles();
  const rendered = renderConfig(context.source, { name: record.name, hostname: record.hostname, ownerEmail: record.ownerEmail, accountId: context.accountId,
    gatewayUrl: record.gateway.url, controlToken: secrets.CONTROL_TOKEN, teamDomain: record.access.teamDomain, audience: record.access.audience,
    r2AccessKeyId: credentials.accessKeyId, r2SecretAccessKey: credentials.secretAccessKey, startHost: readFileSync(startHost) }, local);
  const changed = [...rendered].filter(([key, bytes]) => !local.get(key)?.equals(bytes));
  if (changed.length) await context.act(`write ${changed.map(([key]) => key).join(", ")} in ${directory.config}`, () => {
    for (const [key, bytes] of changed) directory.write(join(directory.config, ...key.split("/")), bytes);
  });
  // Everything below config/ is the configuration, also what an owner put there.
  const files = new Map([...local, ...rendered]);
  const bucket = new Bucket(context.effects, credentials, names.buckets.config);
  const stale: string[] = [];
  for (const [key, bytes] of files) if (await bucket.digest(key) !== sha256(bytes)) stale.push(key);
  if (stale.length) await context.act(`upload ${stale.join(", ")} to ${names.buckets.config}`, async () => { for (const key of stale) await bucket.put(key, files.get(key)!); });
  record.config = { revision: configRevision(files) };
  context.save();
  context.detail = { objects: files.size, revision: record.config.revision };
} };

const deployWorker: Step = { id: "deploy", needs: ["config"], async run(context) {
  const { record, directory, names } = context, credentials = context.s3(), revision = context.revision!;
  if ((!credentials || !record.config) && !context.dryRun) throw new DeployError("configuration_inputs_missing");
  if (!credentials || !record.config) { await context.act(`deploy Worker ${names.worker} at ${revision} to ${record.hostname} (builds the image)`, () => undefined); return; }
  const wanted = renderWorkerWrangler(context.source, { name: record.name, hostname: record.hostname, accountId: context.accountId, revision,
    configRevision: record.config.revision, backup: existsSync(join(directory.config, "backup.json")) });
  // Secrets cannot be read back, so the record says which key pair the Worker was last given.
  const fingerprint = sha256(`${credentials.accessKeyId}\n${credentials.secretAccessKey}`).slice(0, 16);
  const deployed = await context.settings(names.worker);
  const current = deployed && !revision.endsWith("-dirty") && record.worker?.credentials === fingerprint &&
    ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"].every((secret) => deployed.secrets.includes(secret)) &&
    Object.entries(wanted.vars as Record<string, string>).every(([key, value]) => deployed.vars[key] === value);
  if (!current) await context.act(`deploy Worker ${names.worker} at ${revision} to ${record.hostname} (builds the image)`, async () => {
    const file = join(directory.path, "mau.wrangler.json"), secrets = directory.secret("worker.json");
    directory.write(file, JSON.stringify(wanted, null, 2) + "\n");
    directory.write(secrets, JSON.stringify({ R2_ACCESS_KEY_ID: credentials.accessKeyId, R2_SECRET_ACCESS_KEY: credentials.secretAccessKey }) + "\n");
    // The secrets go in with the version, so no version of the Worker runs without them.
    await context.wrangler(["deploy", "--config", file, "--secrets-file", secrets], "worker_deploy_failed", 3_600_000);
    record.worker = { revision, configRevision: record.config!.revision, credentials: fingerprint };
    context.save();
  });
  context.detail = { worker: names.worker, revision, configRevision: record.config.revision };
} };

const verify: Step = { id: "verify", needs: ["deploy"], async run(context) {
  const { record } = context, url = `https://${record.hostname}`, team = record.access ? new URL(record.access.teamDomain).host : undefined;
  // A dry run only looks, and only when nothing before it is left to change.
  if (context.dryRun && context.outstanding) { await context.act(`wait until ${url}/health/live answers and check that / is behind Cloudflare Access`, () => undefined); return; }
  const toAccess = (location: string | null) => !!location && !!team && URL.canParse(location) && new URL(location).host === team;
  // A first start builds nothing but restores state, issues the certificate and starts the container: minutes.
  let last = 0;
  const healthy = await until(context, context.dryRun ? 0 : 900, async () => {
    const health = await getJson(context, `${url}/health/live`);
    last = health.status;
    if (toAccess(health.location)) throw new DeployError("liveness_behind_access", `${url}/health/live is redirected to the login`, `Add an Access application for ${record.hostname}/health/live with a Bypass policy for Everyone.`);
    return health.status === 200 && health.body?.status === "ok" || undefined;
  });
  if (!healthy) throw new DeployError("mau_not_healthy", `${url}/health/live answered ${last || "nothing"}${context.dryRun ? "" : " for 15 minutes"}`, `Run ${context.continueWith().replace("deploy", "doctor")}; the container's log is in the Cloudflare dashboard under the Worker ${context.names.worker}.`);
  const root = await getJson(context, `${url}/`);
  if (!(root.status >= 300 && root.status < 400 && toAccess(root.location))) throw new DeployError("access_not_protecting", `${url}/ answered ${root.status} without a redirect to ${team}`, `Check the Access application for ${record.hostname}.`);
  context.detail = { url, health: "ok", access: "protects /" };
} };

export const STEPS: Step[] = [preflight, codexAuth, buckets, r2Credentials, gateway, access, config, deployWorker, verify];
