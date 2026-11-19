// The configuration bucket is read and written through R2's S3 API with the container's own key pair, so a
// deployment whose objects are in place is also one whose key pair works on the bucket.
// Signature Version 4: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
// R2: region "auto", endpoint https://<account>.r2.cloudflarestorage.com (https://developers.cloudflare.com/r2/api/tokens/).
import { createHash, createHmac } from "node:crypto";
import type { Effects } from "./effects.js";

export interface S3Credentials { endpoint: string; accessKeyId: string; secretAccessKey: string; region?: string }

const hex = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Uint8Array, value: string) => createHmac("sha256", key).update(value).digest();
const encode = (segment: string) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** The request headers, `Authorization` included, for one path-style S3 request. `time` is its `x-amz-date`. */
export function signS3(credentials: S3Credentials, method: string, url: URL, headers: Record<string, string>, payload: Uint8Array, time: Date): Record<string, string> {
  const region = credentials.region ?? "auto", stamp = time.toISOString().replace(/[-:]|\.\d{3}/g, ""), day = stamp.slice(0, 8);
  const all: Record<string, string> = { ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.trim()])),
    host: url.host, "x-amz-content-sha256": hex(payload), "x-amz-date": stamp };
  const names = Object.keys(all).sort();
  const query = [...url.searchParams].map(([name, value]) => `${encode(name)}=${encode(value)}`).sort().join("&");
  const canonical = [method, url.pathname.split("/").map((segment) => encode(decodeURIComponent(segment))).join("/"), query,
    ...names.map((name) => `${name}:${all[name]}`), "", names.join(";"), all["x-amz-content-sha256"]].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const key = ["s3", "aws4_request"].reduce<Uint8Array>((secret, part) => hmac(secret, part), hmac(hmac("AWS4" + credentials.secretAccessKey, day), region));
  const signature = hmac(key, ["AWS4-HMAC-SHA256", stamp, scope, hex(canonical)].join("\n")).toString("hex");
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

/** One bucket, as the holder of a key pair sees it. Objects carry their SHA-256 as metadata, which is what is compared. */
export class Bucket {
  constructor(private readonly effects: Effects, private readonly credentials: S3Credentials, readonly name: string) {}
  private async send(method: string, key: string, headers: Record<string, string> = {}, payload: Uint8Array = new Uint8Array()) {
    const url = new URL(`${this.credentials.endpoint}/${this.name}/${key.split("/").map(encode).join("/")}`);
    const { host: _host, ...signed } = signS3(this.credentials, method, url, headers, payload, new Date());
    return this.effects.fetch(url.href, { method, headers: signed, ...(method === "PUT" ? { body: Buffer.from(payload) } : {}) });
  }
  /** Whether the key pair may use this bucket, and the bucket exists: one listing of at most one object. */
  async reachable(): Promise<boolean> {
    const url = new URL(`${this.credentials.endpoint}/${this.name}?list-type=2&max-keys=1`);
    const { host: _host, ...signed } = signS3(this.credentials, "GET", url, {}, new Uint8Array(), new Date());
    const response = await this.effects.fetch(url.href, { method: "GET", headers: signed });
    if (response.status === 401 || response.status === 403 || response.status === 404) return false;
    if (!response.ok) throw new Error(`r2_request_failed: GET ${response.status}`);
    return true;
  }
  /** The stored SHA-256 of an object; null when there is no such object. A refused key pair throws `r2_credentials_refused`. */
  async digest(key: string): Promise<string | null> {
    const response = await this.send("HEAD", key);
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) throw new Error("r2_credentials_refused");
    if (!response.ok) throw new Error(`r2_request_failed: HEAD ${response.status}`);
    return response.headers.get("x-amz-meta-sha256") ?? "";
  }
  async put(key: string, bytes: Uint8Array) {
    const response = await this.send("PUT", key, { "x-amz-meta-sha256": hex(bytes) }, bytes);
    if (response.status === 401 || response.status === 403) throw new Error("r2_credentials_refused");
    if (!response.ok) throw new Error(`r2_request_failed: PUT ${response.status}`);
  }
}
