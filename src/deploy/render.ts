// The files a deployment generates. Each starts from the example in this repository (or, for a file the
// deployment already has, from that file) and sets only the values deploy owns, so what an owner added stays.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { r2Endpoint } from "./cloudflare.js";
import { AGE, parseJsonc, type Pin, type Source } from "./source.js";
import { ownerId, resources, sha256 } from "./state.js";

type Json = Record<string, any>;
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");

/** The id of the one environment profile deploy maintains, and of its provider. */
export const PROFILE = "codex", PROVIDER = "cloudflare";
/** Where the Host archive is placed in a sandbox; its checksum manifest names this path. */
const HOST_ARCHIVE = "/opt/agent-environment/agent-host.tgz";

export interface ConfigInputs {
  name: string; hostname: string; ownerEmail: string; accountId: string;
  gatewayUrl: string; controlToken: string;
  teamDomain: string; audience: string;
  r2AccessKeyId: string; r2SecretAccessKey: string;
  /** `examples/start-host.sh` of the pinned environment gateway. */
  startHost: Uint8Array;
}

/** `KEY=value` lines of an env file, set in place; keys that are not there yet are appended. */
function setEnv(text: string, values: Record<string, string>) {
  const pending = new Map(Object.entries(values));
  const lines = text.replace(/\n$/, "").split("\n").map((line) => {
    const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
    if (key === undefined || !pending.has(key)) return line;
    const value = pending.get(key)!; pending.delete(key);
    return `${key}=${value}`;
  });
  return Buffer.from([...lines, ...[...pending].map(([key, value]) => `${key}=${value}`)].join("\n") + "\n");
}

/**
 * The configuration bucket's objects that deploy owns, by key. `existing` is what the deployment's `config/` holds now.
 * The Codex sign-in (`cloud/codex-auth.json`) is not here: it is the owner's file, copied in by its own step.
 */
export function renderConfig(source: Source, inputs: ConfigInputs, existing: Map<string, Uint8Array>): Map<string, Buffer> {
  const names = resources(inputs.name), owner = ownerId(inputs.hostname);
  const example = (path: string) => readFileSync(source.path("examples", path));
  const base = (key: string, path: string) => Buffer.from(existing.get(key) ?? example(path));
  const template = JSON.parse(example("mau.json").toString("utf8")) as Json;

  // The profile with this id is deploy's and is replaced as a whole; profiles an owner added under other ids stay.
  const mau = existing.has("mau.json") ? JSON.parse(Buffer.from(existing.get("mau.json")!).toString("utf8")) as Json
    : { ...template, environments: { ...template.environments, profiles: [] }, edgeIdentity: { ...template.edgeIdentity, owners: {} } };
  mau.environments = { ...mau.environments, configFile: template.environments.configFile };
  const profile = { ...template.environments.profiles[0], id: PROFILE, provider: PROVIDER, owners: [owner] };
  const others = ((mau.environments.profiles ?? []) as Json[]).filter((item) => item.id !== PROFILE);
  mau.environments.profiles = [profile, ...others];
  mau.nativeWork = { ...template.nativeWork, ...mau.nativeWork };
  mau.edgeIdentity = { ...mau.edgeIdentity, provider: "cloudflare-access", teamDomain: inputs.teamDomain, audiences: [inputs.audience],
    owners: { ...mau.edgeIdentity?.owners, [inputs.ownerEmail]: owner } };

  const providers = JSON.parse(base("providers.json", "providers.json").toString("utf8")) as { providers: Json[] };
  const provider = { ...(JSON.parse(example("providers.json").toString("utf8")) as { providers: Json[] }).providers[0], id: PROVIDER, apiUrl: inputs.gatewayUrl };
  providers.providers = providers.providers.some((item) => item.id === PROVIDER) ? providers.providers.map((item) => item.id === PROVIDER ? provider : item) : [...providers.providers, provider];

  const host = readFileSync(source.archive("host"));
  return new Map<string, Buffer>([
    ["mau.env", setEnv(base("mau.env", "mau.env").toString("utf8"), {
      MATRIX_SERVER_NAME: inputs.hostname, AGENT_SERVICE_URL: `https://${inputs.hostname}/_agent-router/v1`,
      AGENT_BLOB_STORE: "r2", AGENT_R2_ENDPOINT: r2Endpoint(inputs.accountId), AGENT_R2_BUCKET: names.buckets.attachments,
      AGENT_R2_ACCESS_KEY_ID_FILE: "/config/r2-access-key-id", AGENT_R2_SECRET_ACCESS_KEY_FILE: "/config/r2-secret-access-key",
    })],
    ["mau.json", json(mau)],
    ["providers.json", json(providers)],
    ["gateway-key", Buffer.from(inputs.controlToken + "\n")],
    ["r2-access-key-id", Buffer.from(inputs.r2AccessKeyId + "\n")],
    ["r2-secret-access-key", Buffer.from(inputs.r2SecretAccessKey + "\n")],
    // An environment that exists keeps the Host configuration it was created with, so this file is written once.
    ["cloud/host-profile.json", base("cloud/host-profile.json", "cloud/host-profile.json")],
    ["cloud/agent-host.tgz", host],
    ["cloud/agent-host.sha256", Buffer.from(`${sha256(host)}  ${HOST_ARCHIVE}\n`)],
    ["cloud/start-host.sh", Buffer.from(inputs.startHost)],
  ]);
}
export interface GatewayInputs { name: string; accountId: string; directory: string; pin: Pin; backupRecipient: string }
/** The environment gateway's Wrangler configuration, from the example its pinned package ships. */
export function renderGatewayWrangler(inputs: GatewayInputs): Json {
  const names = resources(inputs.name), cloudflare = join(inputs.directory, "package", "cloudflare");
  const config = parseJsonc(readFileSync(join(cloudflare, "wrangler.example.jsonc"), "utf8")) as Json;
  return { ...config, name: names.gateway, account_id: inputs.accountId, main: join(cloudflare, "src", "index.ts"), workers_dev: true,
    r2_buckets: [{ ...config.r2_buckets[0], bucket_name: names.buckets.environmentBackups }],
    vars: { ...config.vars, BACKUP_RECIPIENT: inputs.backupRecipient, AGE_KEY: AGE.key, AGE_SHA256: AGE.binarySha256, SOURCE_REVISION: inputs.pin.revision } };
}

export interface WorkerInputs { name: string; hostname: string; accountId: string; revision: string; configRevision: string; backup: boolean }
/** Mau's Wrangler configuration, from `cloudflare/wrangler.example.jsonc`. */
export function renderWorkerWrangler(source: Source, inputs: WorkerInputs): Json {
  const names = resources(inputs.name);
  const config = parseJsonc(readFileSync(source.path("cloudflare", "wrangler.example.jsonc"), "utf8")) as Json;
  const { LOCATION_HINT: _placement, BACKUP_HOUR_UTC: backupHour, ...vars } = config.vars as Record<string, string>;
  const container = config.containers[0] as Json;
  return { ...config, name: names.worker, account_id: inputs.accountId, main: source.path("cloudflare", "src", "index.ts"),
    routes: [{ pattern: inputs.hostname, custom_domain: true }],
    containers: [{ ...container, images: { mau: { dockerfile: source.path("Dockerfile"), build_context: source.root, build_vars: { SOURCE_REVISION: inputs.revision } } } }],
    r2_buckets: [{ ...config.r2_buckets[0], bucket_name: names.buckets.accessLogs }],
    vars: { ...vars, ...(inputs.backup ? { BACKUP_HOUR_UTC: backupHour } : {}), CONFIG_REVISION: inputs.configRevision, SOURCE_REVISION: inputs.revision,
      R2_ENDPOINT: r2Endpoint(inputs.accountId), CONFIG_BUCKET: names.buckets.config, STATE_BUCKET: names.buckets.state } };
}
