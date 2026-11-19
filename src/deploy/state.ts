import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type StepStatus = "done" | "skipped" | "needs_owner" | "failed";
/** What a human must do before deploy can go on, and the command that goes on. */
export interface OwnerAction { reason: string; instructions: string[]; continue: string }

/**
 * `deployment.json`: what was asked for, what was found or created, and how each step ended. It holds names and
 * identifiers only. Secrets are files below `secrets/` and `config/`.
 */
export interface Deployment {
  version: 1;
  name: string;
  hostname: string;
  ownerEmail: string;
  accountId?: string;
  zone?: { id: string; name: string };
  workersSubdomain?: string;
  r2?: { source: "api" | "owner"; tokenId?: string };
  gateway?: { url: string; revision: string };
  access?: { source: "api" | "owner"; teamDomain: string; audience: string; applicationId?: string };
  config?: { revision: string };
  /** What the last deploy of the Worker carried. `credentials` is a digest of the R2 key pair, never the pair. */
  worker?: { revision: string; configRevision: string; credentials: string };
  steps: Record<string, { status: StepStatus; at: string; detail: unknown }>;
}

export const NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Every name a deployment gives a Cloudflare resource, from its one prefix. */
export const resources = (name: string) => ({
  worker: name,
  gateway: `${name}-environment`,
  buckets: {
    config: `${name}-config`, state: `${name}-state`, attachments: `${name}-attachments`,
    accessLogs: `${name}-access-logs`, environmentBackups: `${name}-environment-backups`,
  },
  r2Token: `${name}-container-r2`,
});
/** The buckets the container reads and writes with its own key pair. */
export const containerBuckets = (name: string) => { const b = resources(name).buckets; return [b.config, b.state, b.attachments]; };

/** The owner of a deployment is one account in the namespace of its hostname. */
export const ownerId = (hostname: string) => `@owner:${hostname}`;

export const defaultDirectory = (env: Record<string, string | undefined>, home: string, name: string) =>
  join(env.MAU_CONFIG_DIR ?? join(home, ".config", "mau"), "deployments", name);

export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** The private deployment directory. Nothing is created until something is written. */
export class Directory {
  constructor(readonly path: string) {}
  get recordFile() { return join(this.path, "deployment.json"); }
  get config() { return join(this.path, "config"); }
  get secrets() { return join(this.path, "secrets"); }
  secret(name: string) { return join(this.secrets, name); }

  load(): Deployment | undefined {
    if (!existsSync(this.recordFile)) return undefined;
    const record = JSON.parse(readFileSync(this.recordFile, "utf8")) as Deployment;
    if (record.version !== 1) throw new Error("deployment_record_version_unknown");
    return record;
  }
  save(record: Deployment) { this.write(this.recordFile, JSON.stringify(record, null, 2) + "\n"); }

  /** Writes a file readable by its owner only, in directories that are the same. */
  write(path: string, value: string | Uint8Array) {
    for (const directory of [this.path, this.config, this.secrets, dirname(path)]) { mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700); }
    const temporary = `${path}.${randomUUID()}`;
    writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  }
  read(path: string): Buffer | undefined { return existsSync(path) ? readFileSync(path) : undefined; }
  readSecret(name: string): string | undefined { return this.read(this.secret(name))?.toString("utf8").trim() || undefined; }

  /** Every file below `config/`, by its object key in the configuration bucket. */
  configFiles(): Map<string, Buffer> {
    const files = new Map<string, Buffer>();
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) files.set(relative(this.config, path).split(sep).join("/"), readFileSync(path));
      }
    };
    if (existsSync(this.config)) walk(this.config);
    return files;
  }
}

/** One value for the whole configuration: it changes when any object's key or bytes change. */
export const configRevision = (files: Map<string, Uint8Array>) =>
  sha256([...files].sort(([a], [b]) => a < b ? -1 : 1).map(([key, bytes]) => `${key}\0${sha256(bytes)}\n`).join("")).slice(0, 16);
