import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { localHeaders, readSession } from "../cli/session.js";
import { Cloudflare, r2Endpoint } from "./cloudflare.js";
import { systemRuntime, type Runtime } from "./effects.js";
import { Bucket } from "./s3.js";
import { DeployError, Source, inspectCodexAuth } from "./source.js";
import { Directory, configRevision, containerBuckets, defaultDirectory, ownerId, resources, sha256, type Deployment } from "./state.js";

export interface DoctorInput { dir?: string; name?: string; url?: string }
/** `ok: null`: the check could not be made; `detail` says why. */
export interface Check { check: string; ok: boolean | null; detail: string; fix?: string }
export interface DoctorResult { exitCode: 0 | 1; report: { ok: boolean; checks: Check[] } }
type Finding = Omit<Check, "check">;

const CLOUDFLARED = "Install cloudflared (https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/); the CLI signs in to Cloudflare Access with it.";
const good = (detail: string): Finding => ({ ok: true, detail });
const bad = (detail: string, fix: string): Finding => ({ ok: false, detail, fix });
const unknown = (detail: string, fix?: string): Finding => ({ ok: null, detail, ...(fix ? { fix } : {}) });

/**
 * Says what is missing or broken: on this machine, in a deployment (`--dir` or `--name`), and, signed in, in the
 * running service. With the URL of the service `mau local` signed this CLI in to, it checks what local mode needs
 * instead of a deployment. It reads only. Exit code 1 when any check is false.
 */
export async function doctor(input: DoctorInput, runtime: Runtime = systemRuntime()): Promise<DoctorResult> {
  const { effects, env } = runtime, source = new Source(runtime), checks: Check[] = [];
  const check = async (name: string, look: () => Promise<Finding> | Finding) => {
    let finding: Finding;
    try { finding = await look(); }
    catch (error) { finding = error instanceof DeployError ? { ok: false, detail: error.detail ?? error.code, ...(error.fix ? { fix: error.fix } : {}) } : unknown(`could not check: ${error instanceof Error ? error.message : String(error)}`); }
    checks.push({ check: name, ...finding });
    return finding.ok;
  };
  const get = async (url: string, headers: Record<string, string> = {}, method = "GET") => {
    const response = await effects.fetch(url, { method, redirect: "manual", headers: { Accept: "application/json", ...headers, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}) });
    return { status: response.status, location: response.headers.get("location"), body: await response.json().catch(() => undefined) as any };
  };
  const version = async (program: string, args = ["--version"]) => { const result = await effects.run(program, args, { timeoutMs: 30_000 }); return result.code === 0 ? (result.stdout.trim() || result.stderr.trim()).split("\n").at(-1)! : undefined; };

  const session = readSession(env, runtime.home), asked = input.url?.replace(/\/$/, "");
  const local = session && "login" in session && asked === session.url && !input.dir && !input.name ? session : undefined;

  // This machine.
  await check("node", () => Number(runtime.nodeVersion.split(".")[0]) >= 24 ? good(`Node.js ${runtime.nodeVersion}`) : bad(`Node.js ${runtime.nodeVersion}`, "Install Node.js 24 or later."));
  let checkout = false, revision: string | undefined;
  await check("source-checkout", async () => {
    if (local) { source.assertCheckout("local"); return good(source.root); }
    try { source.assertCheckout(); revision = await source.revision(); }
    catch (error) { if (error instanceof DeployError) return unknown(`${error.detail}; only a deployment needs it`, error.fix); throw error; }
    checkout = true;
    return good(`${source.root} at ${revision}`);
  });
  await check("docker", async () => { const engine = await version(local ? "docker" : env.WRANGLER_DOCKER_BIN ?? "docker", ["info", "--format", "{{.ServerVersion}}"]); return engine ? good(`engine ${engine}`)
    : bad("no Docker engine answers", `Start Docker (or another Docker-compatible engine); ${local ? "each partner's environment is a container" : "deploy builds the image with it"}.`); });
  const codexSignIn = (bytes: Buffer | undefined, again: string) => {
    if (!bytes) return bad("the configuration has no Codex sign-in", `codex login, then ${again}`);
    const inspected = inspectCodexAuth(bytes);
    return inspected.ok ? good(inspected.detail) : bad(inspected.detail, `codex login, then ${again}`);
  };
  if (local) {
    // What `mau local` keeps: a private directory with the owner token and the configuration.
    const path = dirname(local.tokenFile);
    await check("local-directory", () => {
      if (!existsSync(local.tokenFile)) return bad(`${local.tokenFile} does not exist`, "mau local");
      const loose = [path, local.tokenFile].filter((item) => (statSync(item).mode & 0o077) !== 0);
      return loose.length ? bad(`readable by others: ${loose.join(", ")}`, `chmod -R go-rwx ${path}`) : good(path);
    });
    await check("codex-sign-in", () => codexSignIn(new Directory(path).read(join(path, "config", "cloud", "codex-auth.json")), "mau local"));
  }
  if (!local) await check("wrangler", async () => {
    if (!checkout) return unknown("needs the source checkout");
    const found = existsSync(source.wranglerBinary) ? await version(source.wranglerBinary) : undefined;
    return found ? good(`wrangler ${found}`) : bad("the pinned Wrangler is not installed", `npm --prefix ${source.path("cloudflare")} ci`);
  });
  if (!local) await check("cloudflared", async () => { const found = await version("cloudflared"); return found ? good(found) : bad("cloudflared is not installed", CLOUDFLARED); });
  let cloudflare: Cloudflare | undefined;
  if (!local) await check("cloudflare-credentials", async () => {
    const client = new Cloudflare(effects, await source.credentials()), accounts = await client.accounts();
    cloudflare = client;
    return good(`${client.credentials.source === "api-token" ? "CLOUDFLARE_API_TOKEN" : "wrangler login"}; ${accounts.length} account${accounts.length === 1 ? "" : "s"}`);
  });

  // The deployment.
  const name = input.name ?? "mau", directory = new Directory(resolve(input.dir ?? defaultDirectory(env, runtime.home, name)));
  let record: Deployment | undefined;
  const again = `mau deploy${input.dir ? ` --dir ${directory.path}` : name === "mau" ? "" : ` --name ${name}`}`;
  if (!local) await check("deployment", () => {
    record = directory.load();
    if (!record) return input.url && !input.dir && !input.name ? unknown(`no deployment in ${directory.path}; checking ${input.url} only`) : bad(`no deployment in ${directory.path}`, "mau deploy --hostname HOSTNAME --owner-email EMAIL");
    const loose = [directory.path, directory.config, directory.secrets].filter((path) => existsSync(path) && (statSync(path).mode & 0o077) !== 0);
    if (loose.length) return bad(`readable by others: ${loose.join(", ")}`, `chmod -R go-rwx ${directory.path}`);
    const unfinished = Object.entries(record.steps).filter(([, step]) => step.status !== "done" && step.status !== "skipped").map(([id, step]) => `${id}: ${step.status}`);
    return unfinished.length ? bad(`the last deploy stopped at ${unfinished.join(", ")}`, again) : good(`${record.hostname}, owner ${record.ownerEmail}, in ${directory.path}`);
  });
  if (record) {
    const deployment = record, names = resources(deployment.name), url = `https://${deployment.hostname}`;
    const account = cloudflare && deployment.accountId ? cloudflare.forAccount(deployment.accountId) : undefined;
    const needsAccount = unknown("needs Cloudflare credentials and a deployment that passed preflight");
    for (const bucket of Object.values(names.buckets)) await check(`bucket:${bucket}`, async () => !account ? needsAccount : await account.bucketExists(bucket) ? good("exists") : bad("does not exist", again));

    const keyId = directory.readSecret("r2-access-key-id"), key = directory.readSecret("r2-secret-access-key");
    const s3 = keyId && key && deployment.accountId ? { endpoint: r2Endpoint(deployment.accountId), accessKeyId: keyId, secretAccessKey: key } : undefined;
    const usable = await check("r2-key-pair", async () => {
      if (!s3) return bad("the deployment has no R2 key pair", again);
      const refused: string[] = [];
      for (const bucket of containerBuckets(deployment.name)) if (!await new Bucket(effects, s3, bucket).reachable()) refused.push(bucket);
      return refused.length ? bad(`refused on ${refused.join(", ")}`, again) : good("reads the configuration, state and attachment buckets");
    });
    const files = directory.configFiles();
    await check("configuration-objects", async () => {
      if (!files.size) return bad(`${directory.config} is empty`, again);
      if (!s3 || !usable) return unknown("needs a working R2 key pair");
      const bucket = new Bucket(effects, s3, names.buckets.config), differing: string[] = [];
      for (const [object, bytes] of files) if (await bucket.digest(object) !== sha256(bytes)) differing.push(object);
      return differing.length ? bad(`missing or different in ${names.buckets.config}: ${differing.join(", ")}`, again) : good(`${files.size} objects in ${names.buckets.config} match ${directory.config}`);
    });
    await check("codex-sign-in", () => codexSignIn(directory.read(join(directory.config, "cloud", "codex-auth.json")), `${again} --codex-auth ~/.codex/auth.json`));

    await check("gateway", async () => {
      if (!deployment.gateway) return bad("the environment gateway was not deployed", again);
      const health = await get(`${deployment.gateway.url}/health`);
      if (health.status !== 200 || health.body?.service !== "agent-environment") return bad(`${deployment.gateway.url}/health answered ${health.status}`, again);
      const pinned = checkout ? source.pin().revision : deployment.gateway.revision;
      return health.body.revision === pinned ? good(`revision ${pinned}`) : bad(`runs revision ${health.body.revision ?? "unknown"}, this checkout pins ${pinned}`, again);
    });
    await check("gateway-key", async () => {
      const secrets = directory.read(directory.secret("gateway.json"));
      if (!secrets || !deployment.gateway) return bad("the deployment has no gateway key", again);
      const listed = await get(`${deployment.gateway.url}/v1/environments`, { "X-Environment-Control": (JSON.parse(secrets.toString("utf8")) as { CONTROL_TOKEN: string }).CONTROL_TOKEN });
      return listed.status === 200 ? good(`accepted; ${Array.isArray(listed.body) ? listed.body.length : 0} environments`) : bad(`the gateway answered ${listed.status} to its control token`, again);
    });

    await check("health", async () => { const health = await get(`${url}/health/live`); return health.status === 200 && health.body?.status === "ok" ? good(`${url}/health/live is ok`) : bad(`${url}/health/live answered ${health.status}`, again); });
    await check("access", async () => {
      if (!deployment.access) return bad("no Access application is recorded", again);
      const root = await get(`${url}/`), team = new URL(deployment.access.teamDomain).host;
      const redirected = root.status >= 300 && root.status < 400 && !!root.location && URL.canParse(root.location) && new URL(root.location).host === team;
      return redirected ? good(`an unauthenticated request to / is sent to ${team}`) : bad(`an unauthenticated request to / answered ${root.status} without a redirect to ${team}`, `Check the Access application for ${deployment.hostname} in the Zero Trust dashboard.`);
    });
    const settings = account ? await account.workerSettings(names.worker).catch(() => null) : null;
    await check("deployed-revision", () => {
      if (!revision) return unknown("needs the source checkout");
      if (settings === null) return unknown("the Worker's settings cannot be read with these credentials");
      const deployed = settings?.vars.SOURCE_REVISION;
      return deployed === revision ? good(`the Worker runs ${revision}`) : bad(`the Worker ${deployed ? `runs ${deployed}` : "is not deployed"}, this checkout is ${revision}`, again);
    });
    await check("deployed-configuration", () => {
      if (settings === null) return unknown("the Worker's settings cannot be read with these credentials");
      const current = configRevision(files), deployed = settings?.vars.CONFIG_REVISION;
      return deployed === current ? good(`the container runs configuration ${current}`) : bad(`the container runs configuration ${deployed ?? "none"}, ${directory.config} is ${current}`, again);
    });
    await check("backup", () => existsSync(join(directory.config, "backup.json")) ? good("backup.json is in the configuration")
      : unknown("no daily backup of Mau's state is configured; the state bucket is its only copy", "docs/deployment.md#daily-backup"));
  }

  // The running service, as its owner.
  const service = asked ?? (record ? `https://${record.hostname}` : undefined);
  if (service) {
    const signIn = local ? "mau local" : `cloudflared access login ${service}`;
    const configured = (variable: string) => (env[variable + "_FILE"] ? readFileSync(env[variable + "_FILE"]!, "utf8") : env[variable])?.trim() || undefined;
    const id = local ? undefined : configured("CF_ACCESS_CLIENT_ID"), secret = local ? undefined : configured("CF_ACCESS_CLIENT_SECRET");
    const token = local || id && secret ? undefined : configured("CF_ACCESS_TOKEN") ?? (await effects.run("cloudflared", ["access", "token", `-app=${service}`], { timeoutMs: 30_000 }).then((result) => result.code === 0 && !/\s/.test(result.stdout.trim()) ? result.stdout.trim() : undefined));
    const headers: Record<string, string> | undefined = local ? localHeaders(local) : id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret, Origin: service } : token ? { "cf-access-token": token, Origin: service } : undefined;
    const signedOut = local ? bad(`${local.tokenFile} holds no owner token`, signIn)
      : unknown("no Access credential", `${signIn} (or CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET of a service token)`);
    const signedIn = await check("account", async () => {
      if (!headers) return signedOut;
      // A local service runs only while `mau local` does.
      const account = await get(`${service}/_mau/v1/account`, headers).catch((error: unknown) => { if (local) throw new DeployError("service_unreachable", `${service} does not answer`, signIn); throw error; });
      if (account.status !== 200) return bad(`${service}/_mau/v1/account answered ${account.status}${account.body?.error ? ` ${account.body.error}` : ""}`, signIn);
      const expected = local ? local.owner : record ? ownerId(record.hostname) : undefined;
      return !expected || account.body.owner === expected ? good(`signed in as ${account.body.owner} (${account.body.via})`) : bad(`signed in as ${account.body.owner}, the owner is ${expected}`, local ? signIn : `Sign in with ${record!.ownerEmail}.`);
    });
    await check("environment-profile", async () => {
      if (!signedIn) return headers ? unknown("needs the account check to pass") : signedOut;
      const profiles = ((await get(`${service}/_mau/v1/options`, headers)).body?.environments ?? []) as Array<{ id: string }>;
      return profiles.length ? good(`profiles for this owner: ${profiles.map((profile) => profile.id).join(", ")}`) : bad("no environment profile is assigned to this owner", local ? signIn : record ? again : "Assign a profile to the owner in mau.json.");
    });
    if (signedIn) {
      const partners = ((await get(`${service}/_mau/v1/agents`, headers)).body?.data ?? []) as Array<{ agent: { id: string; name?: string }; environment: { state: string; error?: string } | null }>;
      for (const partner of partners) await check(`partner:${partner.agent.name ?? partner.agent.id}`, async () => {
        const name = partner.agent.name ?? "NAME";
        const environment = partner.environment;
        if (!environment) return unknown("has no environment");
        if (environment.state === "needs_action") return bad(`environment needs action${environment.error ? `: ${environment.error}` : ""}`, `mau env reconcile ${name}`);
        if (environment.state !== "ready") return good(`environment ${environment.state}; channels are checked while it is ready`);
        // Router's channel check asks the running Host and each connection; it changes nothing.
        const result = await get(`${service}/_agent-router/v1/agents/${partner.agent.id}/check`, headers, "POST");
        if (result.status === 403) return good("environment ready; channels not checked (a service token may not ask)");
        const failing = ((result.body?.checks ?? []) as Array<{ kind?: string; status: string; detail?: string }>).filter((item) => item.status === "needs_action");
        return result.status === 200 && !failing.length ? good(`environment ready; ${(result.body?.checks ?? []).length} channel checks pass`)
          : bad(result.status === 200 ? failing.map((item) => `${item.kind ?? "channel"}: ${item.detail ?? item.status}`).join("; ") : `the channel check answered ${result.status}`, `mau partner check ${name}`);
      });
    }
  }
  const ok = checks.every((item) => item.ok !== false);
  return { exitCode: ok ? 0 : 1, report: { ok, checks } };
}
