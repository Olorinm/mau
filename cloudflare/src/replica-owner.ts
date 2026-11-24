interface ParentKey {
  R2_ENDPOINT: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

export interface ReplicaBoot { id: string; source: string; target: string }
export interface ReplicaHead { id: string; prefix: string }
export interface ReplicaOwner {
  active?: ReplicaHead;
  pending?: ReplicaBoot;
  released?: boolean;
  drainSince?: number;
}

export const POINTER = "replica-head.json";
const DRAIN_MS = 90_000;
const prefixPattern = /^replicas\/[a-f0-9-]{36}\/$/;

export function parseHead(text: string): ReplicaHead {
  const value = JSON.parse(text) as ReplicaHead;
  if (!value || !prefixPattern.test(value.prefix) || typeof value.id !== "string") throw new Error("invalid_replica_head");
  return value;
}

/** A prefix may be reused only after its writer has acknowledged its final flush and exit.
 * An unresponsive writer retains credentials for its own branch and cannot damage the next one. */
export function prepareReplica(owner: ReplicaOwner, head: ReplicaHead | undefined, id: string, now: number): ReplicaBoot | undefined {
  const clean = !!head && owner.active?.id === head.id && owner.released === true;
  if (head && !clean && now - (owner.drainSince ??= now) < DRAIN_MS) return undefined;
  const source = head?.prefix ?? "";
  const boot = { id, source, target: clean ? source : `replicas/${id}/` };
  owner.pending = boot;
  return boot;
}

const encoder = new TextEncoder();
function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Cloudflare R2's locally signed temporary credentials, in AWS credential_process format. */
export async function temporaryKey(env: ParentKey, bucket: string, prefix: string, writable: boolean, now: number) {
  const host = new URL(env.R2_ENDPOINT).hostname;
  const account = host.split(".")[0];
  const exp = Math.floor(now / 1000) + 900;
  const claims = { sub: account, iss: env.R2_ACCESS_KEY_ID, aud: host, iat: Math.floor(now / 1000), exp,
    bucket, scope: writable ? "object-read-write" : "object-read-only",
    ...(prefix ? { paths: { prefixPaths: [prefix], objectPaths: [prefix.slice(0,-1)] } } : {}) };
  const unsigned = [ { alg: "HS256", typ: "JWT" }, claims ].map(v => base64url(encoder.encode(JSON.stringify(v)))).join(".");
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.R2_SECRET_ACCESS_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const jwt = unsigned + "." + base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(unsigned))));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(jwt)));
  return { Version: 1, AccessKeyId: env.R2_ACCESS_KEY_ID, SecretAccessKey: Array.from(hash, byte => byte.toString(16).padStart(2,"0")).join(""),
    SessionToken: btoa("jwt/" + jwt), Expiration: new Date(exp * 1000).toISOString() };
}
