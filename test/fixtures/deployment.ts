// A stand-in for everything `mau deploy` and `mau doctor` reach: a Cloudflare account (REST API, R2's S3 API,
// Wrangler), the two deployed Workers, Docker, git and cloudflared. Nothing here leaves the machine.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemEffects, type CommandResult, type Effects, type Runtime } from "../../src/deploy/effects.js";
import { AGE } from "../../src/deploy/source.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
/** The release deploy really pins; a fixture replaces it and puts it back. */
const PINNED_AGE = { ...AGE };
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const ACCOUNT = "0123456789abcdef0123456789abcdef", ZONE = "example.com", TEAM = "example-team.cloudflareaccess.com";
export const API_TOKEN = "cloudflare-api-token-of-the-test", ACCESS_TOKEN = "access-token-of-the-owner";
/** A Codex sign-in whose access token is a JWT that expires in 2100. */
export const codexAuth = (exp = 4102444800) => JSON.stringify({ tokens: { access_token: `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.codex-access-signature`,
  refresh_token: "codex-refresh-token-of-the-test", account_id: "account" }, last_refresh: "2026-11-01T00:00:00Z" });

type Failure = "before" | "after" | undefined;
interface Worker { vars: Record<string, string>; secrets: Record<string, string> }
interface Token { name: string; value: string; buckets: string[] }
interface Application { id: string; name: string; domain: string; aud: string; type: string; policies: unknown[] }

export function deploymentFixture(cleanup: Array<() => unknown>) {
  const base = mkdtempSync(join(tmpdir(), "mau-deploy-test-"));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  // A checkout with what deploy reads from one: the examples, the pin, the pinned archives and a Wrangler to call.
  const root = join(base, "checkout") + "/", home = join(base, "home");
  for (const path of ["examples", "components.json", "cloudflare/wrangler.example.jsonc", ".packages/agent-host.tgz", ".packages/agent-router.tgz",
    ".packages/agent-connectors.tgz", ".packages/agent-environment.tgz"]) cpSync(join(repository, path), join(root, path), { recursive: true });
  for (const [path, content] of [["Dockerfile", "FROM scratch\n"], ["cloudflare/src/index.ts", "export default {};\n"], ["cloudflare/node_modules/.bin/wrangler", ""]] as const) {
    mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), content);
  }
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), codexAuth());
  // The pinned `age` release is replaced by a small archive of the same shape.
  mkdirSync(join(base, "age-release", "age"), { recursive: true });
  writeFileSync(join(base, "age-release", "age", "age"), "the age program");
  execFileSync("tar", ["-czf", join(base, "age.tar.gz"), "-C", join(base, "age-release"), "age/age"]);
  const ageArchive = readFileSync(join(base, "age.tar.gz"));
  Object.assign(AGE, { archiveSha256: sha256(ageArchive), binarySha256: sha256("the age program") });
  cleanup.push(() => Object.assign(AGE, PINNED_AGE));

  const cloud = {
    revision: "1".repeat(40), dirty: false, docker: true, subdomain: "example-sub" as string | undefined, team: TEAM as string | undefined,
    /** What the credentials may not do: "tokens", "access", "dns". */
    denied: new Set<string>(),
    buckets: new Map<string, Map<string, { bytes: Buffer; sha256: string }>>(), lifecycle: new Map<string, Array<{ id: string }>>(),
    tokens: new Map<string, Token>(), policies: new Map<string, { name: string; decision: string; include: unknown[] }>(), applications: [] as Application[],
    workers: new Map<string, Worker>(), domains: new Map<string, string>(), dns: [] as Array<{ id: string; type: string; name: string }>,
    partners: [] as Array<{ agent: { id: string; name: string }; environment: { state: string; error?: string } | null }>,
    /** Every change made to the account, in order. */
    writes: [] as string[],
    /** Fails a change: "before" it happens, or "after" it happened, as when the answer is lost. */
    fail: undefined as ((write: string, index: number) => Failure) | undefined,
    /** Printed by a failing `wrangler deploy`. */
    wranglerNoise: "",
    counter: 0,
  };
  class Injected extends Error {}
  const write = <T>(label: string, apply: () => T): T => {
    const mode = cloud.fail?.(label, cloud.writes.length);
    if (mode === "before") throw new Injected(label);
    cloud.writes.push(label);
    const result = apply();
    if (mode === "after") throw new Injected(label);
    return result;
  };
  const id = (prefix: string) => `${prefix}-${++cloud.counter}`;
  const api = (result: unknown, status = 200, code?: number) => Response.json(status < 300 ? { success: true, result, errors: [] } : { success: false, result: null, errors: [{ code: code ?? status, message: String(result) }] }, { status });
  const forbidden = () => api("Authentication error", 403, 10000);

  function rest(method: string, url: URL, body: any): Response {
    const path = url.pathname.replace("/client/v4", ""), account = `/accounts/${ACCOUNT}`;
    const at = (pattern: RegExp) => pattern.exec(path);
    let match: RegExpExecArray | null;
    if (path === "/accounts") return api([{ id: ACCOUNT, name: "Example" }]);
    if (path === "/zones") return api(url.searchParams.get("name") === ZONE ? [{ id: "zone-1", name: ZONE, status: "active", account: { id: ACCOUNT, name: "Example" } }] : []);
    if (path === "/zones/zone-1/dns_records") return cloud.denied.has("dns") ? forbidden() : api(cloud.dns.filter((record) => record.name === url.searchParams.get("name.exact")));
    if (path === `${account}/workers/domains`) return api([...cloud.domains].map(([hostname, service]) => ({ hostname, service })));
    if (path === `${account}/workers/subdomain`) return cloud.subdomain ? api({ subdomain: cloud.subdomain }) : api("not found", 404, 10007);
    if (path === `${account}/r2/buckets` && method === "POST") return api(write(`create bucket ${body.name}`, () => { cloud.buckets.set(body.name, new Map()); return { name: body.name }; }));
    if ((match = at(/\/r2\/buckets\/([^/]+)$/))) return cloud.buckets.has(match[1]!) ? api({ name: match[1] }) : api("NoSuchBucket", 404, 10006);
    if ((match = at(/\/r2\/buckets\/([^/]+)\/lifecycle$/))) {
      const bucket = match[1]!;
      if (method === "GET") return api({ rules: cloud.lifecycle.get(bucket) ?? [] });
      return api(write(`set lifecycle of ${bucket}`, () => { cloud.lifecycle.set(bucket, body.rules); return {}; }));
    }
    if (path.startsWith(`${account}/tokens`) && cloud.denied.has("tokens")) return forbidden();
    if (path === `${account}/tokens/permission_groups`) return api([{ id: "group-object-write", name: "Workers R2 Storage Bucket Item Write" }]);
    if (path === `${account}/tokens` && method === "GET") return api([...cloud.tokens].map(([token, { name }]) => ({ id: token, name })));
    if (path === `${account}/tokens`) return api(write(`create token ${body.name}`, () => {
      const token = { id: id("token"), value: `value-of-${id("secret")}` };
      cloud.tokens.set(token.id, { name: body.name, value: token.value, buckets: Object.keys(body.policies[0].resources).map((key: string) => key.split("_default_")[1]!) });
      return token;
    }));
    if ((match = at(/\/tokens\/([^/]+)\/value$/))) { const token = cloud.tokens.get(match[1]!)!; return api(write(`roll token ${token.name}`, () => token.value = `value-of-${id("secret")}`)); }
    if (path.startsWith(`${account}/access`) && cloud.denied.has("access")) return forbidden();
    if (path === `${account}/access/organizations`) return cloud.team ? api({ auth_domain: cloud.team }) : api("not found", 404);
    if (path === `${account}/access/policies` && method === "GET") return api([...cloud.policies].map(([policy, { name }]) => ({ id: policy, name })));
    if (path === `${account}/access/policies`) return api(write(`create policy ${body.name}`, () => { const policy = id("policy"); cloud.policies.set(policy, body); return { id: policy }; }));
    if (path === `${account}/access/apps` && method === "GET") return api(cloud.applications);
    if (path === `${account}/access/apps`) return api(write(`create application ${body.domain}`, () => {
      const application = { id: id("application"), name: body.name, domain: body.domain, type: body.type, aud: sha256(body.domain), policies: body.policies };
      cloud.applications.push(application);
      return application;
    }));
    if ((match = at(/\/workers\/scripts\/([^/]+)\/settings$/))) {
      const worker = cloud.workers.get(match[1]!);
      return worker ? api({ bindings: [...Object.entries(worker.vars).map(([name, text]) => ({ type: "plain_text", name, text })), ...Object.keys(worker.secrets).map((name) => ({ type: "secret_text", name }))] }) : api("not found", 404, 10007);
    }
    return api(`unknown ${method} ${path}`, 404);
  }

  function s3(method: string, url: URL, headers: Headers, body: Buffer): Response {
    const [, bucket, ...rest] = url.pathname.split("/"), key = decodeURIComponent(rest.join("/"));
    const token = cloud.tokens.get(/Credential=([^/]+)\//.exec(headers.get("authorization") ?? "")?.[1] ?? "");
    if (!token || !token.buckets.includes(bucket!)) return new Response(null, { status: 403 });
    const objects = cloud.buckets.get(bucket!);
    if (!objects) return new Response(null, { status: 404 });
    if (method === "GET" && !key) return new Response("<ListBucketResult/>", { status: 200 });
    if (method === "HEAD") { const object = objects.get(key); return new Response(null, object ? { status: 200, headers: { "x-amz-meta-sha256": object.sha256 } } : { status: 404 }); }
    write(`put ${bucket}/${key}`, () => objects.set(key, { bytes: body, sha256: headers.get("x-amz-meta-sha256") ?? "" }));
    return new Response(null, { status: 200 });
  }

  /** The deployed Mau, as someone outside sees it through Cloudflare Access. */
  function service(method: string, url: URL, headers: Headers): Response {
    const worker = cloud.workers.get(cloud.domains.get(url.host) ?? "");
    if (!worker) return new Response(null, { status: 530 });
    const guarded = cloud.applications.filter((application) => `${url.host}${url.pathname}`.startsWith(application.domain)).sort((a, b) => b.domain.length - a.domain.length)[0];
    const bypass = guarded && (cloud.policies.get((guarded.policies[0] as { id: string }).id)?.decision === "bypass");
    if (url.pathname === "/health/live") return guarded && !bypass ? new Response(null, { status: 302, headers: { location: `https://${cloud.team}/cdn-cgi/access/login` } }) : Response.json({ status: "ok" });
    if (guarded && headers.get("cf-access-token") !== ACCESS_TOKEN) return new Response(null, { status: 302, headers: { location: `https://${cloud.team}/cdn-cgi/access/login/${url.host}` } });
    if (!guarded && url.pathname === "/") return new Response("console", { status: 200 });
    if (url.pathname === "/_mau/v1/account") return Response.json({ owner: `@owner:${url.host}`, via: "edge", email: "owner@example.com" });
    if (url.pathname === "/_mau/v1/options") return Response.json({ environments: [{ id: "codex", label: "Codex", kernel: "codex", kernels: ["codex"] }] });
    if (url.pathname === "/_mau/v1/agents") return Response.json({ data: cloud.partners });
    if (method === "POST" && url.pathname.endsWith("/check")) return Response.json({ checks: [{ kind: "host", status: "verified" }] });
    return new Response(null, { status: 404 });
  }

  const effects: Effects = {
    sleep: async () => undefined,
    async fetch(input, init = {}) {
      const url = new URL(input), method = init.method ?? "GET", headers = new Headers(init.headers);
      try {
        if (url.host === "api.cloudflare.com") return headers.get("authorization") === `Bearer ${API_TOKEN}` ? rest(method, url, init.body ? JSON.parse(String(init.body)) : undefined) : api("Invalid token", 401, 1000);
        if (url.host === `${ACCOUNT}.r2.cloudflarestorage.com`) return s3(method, url, headers, init.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0));
        if (input === AGE.url) return new Response(ageArchive);
        if (url.host.endsWith(".workers.dev")) {
          const worker = cloud.workers.get(url.host.split(".")[0]!);
          if (!worker || url.host.split(".")[1] !== cloud.subdomain) return new Response(null, { status: 404 });
          if (url.pathname === "/health") return Response.json({ service: "agent-environment", provider: "cloudflare", version: 2, revision: worker.vars.SOURCE_REVISION ?? null });
          return headers.get("x-environment-control") === worker.secrets.CONTROL_TOKEN ? Response.json([]) : Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return service(method, url, headers);
      } catch (error) { if (error instanceof Injected) return api(`injected failure: ${error.message}`, 500); throw error; }
    },
    async run(command, args, options): Promise<CommandResult> {
      const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" }), failed = (stderr: string): CommandResult => ({ code: 1, stdout: "", stderr });
      try {
        if (command === "tar") return systemEffects.run(command, args, options);
        if (command === "git") return ok(args.includes("rev-parse") ? cloud.revision + "\n" : cloud.dirty ? " M src/app.ts\n" : "");
        if (command === "docker") return cloud.docker ? ok("29.0.0\n") : failed("Cannot connect to the Docker daemon");
        if (command === "cloudflared") return args[0] === "--version" ? ok("cloudflared version 2026.11.0\n") : ok(ACCESS_TOKEN + "\n");
        if (!command.endsWith("wrangler")) return failed(`unexpected command ${command}`);
        if (args[0] === "--version") return ok("4.164.0\n");
        if (args[0] === "auth") return ok(JSON.stringify({ type: "oauth", token: API_TOKEN }) + "\n");
        if (args[0] === "r2") {
          const [bucket, ...key] = args[3]!.split("/"), objects = cloud.buckets.get(bucket!), file = args[args.indexOf("--file") + 1]!;
          if (!args.includes("--remote") || !objects) return failed("The specified bucket does not exist.");
          if (args[2] === "get") { const object = objects.get(key.join("/")); if (!object) return failed("The specified key does not exist."); writeFileSync(file, object.bytes); return ok(); }
          write(`put ${args[3]}`, () => objects.set(key.join("/"), { bytes: readFileSync(file), sha256: "" }));
          return ok();
        }
        if (args[0] === "deploy") {
          const config = JSON.parse(readFileSync(args[args.indexOf("--config") + 1]!, "utf8")), secrets = JSON.parse(readFileSync(args[args.indexOf("--secrets-file") + 1]!, "utf8"));
          write(`deploy ${config.name}`, () => {
            cloud.workers.set(config.name, { vars: config.vars, secrets });
            for (const route of config.routes ?? []) cloud.domains.set(route.pattern, config.name);
          });
          return ok(`Deployed ${config.name}\n`);
        }
        return failed(`unexpected wrangler ${args.join(" ")}`);
      } catch (error) { if (error instanceof Injected) return failed(`injected failure: ${error.message} ${cloud.wranglerNoise}`); throw error; }
    },
  };
  const progress: string[] = [];
  const runtime: Runtime = { effects, env: { CLOUDFLARE_API_TOKEN: API_TOKEN }, home, root, nodeVersion: "24.22.2", progress: (line) => { progress.push(line); } };
  return { cloud, runtime, progress, home, root, directory: join(home, ".config", "mau", "deployments", "mau") };
}
