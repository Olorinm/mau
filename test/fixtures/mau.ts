// Shared Mau fixture: simulated cloud lifecycle, a stand-in for Cloudflare Access (alice's email is mapped to her
// owner), bearer accounts ("alice", "bob") for direct API calls, Router's ledger and a fixture Host.
import { vi, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RouterError as WorkError } from "@agent-router/server";
import { createMau } from "../../src/app.js";
import { privateFile } from "../../src/files.js";
import type { EnvironmentProvider } from "../../src/environments.js";
import type { ExternalHosts } from "../../src/external-partners.js";
import { accessIssuer } from "./access.js";

export const alice = "@alice:example.test",
  aliceEmail = "alice@example.test",
  bob = "@bob:example.test",
  root = "/_mau/v1";
export async function mauFixture(cleanup: Array<() => unknown>, serving: { webRoot?: string;
  /** Host links for partners that are agents on the owner's computers (`memoryExternalHosts`). */
  externalHosts?: ExternalHosts; host?: (url: URL, init?: RequestInit) => Response | Promise<Response>;
  hostCapabilities?: { runIdempotency?: boolean };
  /** Members added to the runtime description Host returns, for example `capabilities`. */
  runtime?: Record<string, unknown>;
  /** Other runtimes of the fixture's Host by id, each with its `kernel` and what else its description has. */
  runtimes?: Record<string, Record<string, unknown>>;
  /** Members added to the fixture's environment profile, for example `otherKernels`. */
  profile?: Record<string, unknown>;
  /** The runtimes written to the profile's Host configuration, when they are not the ones the Host has. */
  hostConfigRuntimes?: unknown[] } = {}, extraOptions: Record<string, unknown> = {},
  /** Router service settings. Ledger flags given here replace the fixture's (send, cards, control and groups on). */
  routerConfig: Record<string, unknown> = {},
  /** Extra Router dependencies, for example `{ edgeIdentityCerts }`. */
  routerDependencies: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "router-cloud-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const cloud = new Map<
    string,
    {
      metadata: Record<string, string>;
      state: string;
      files: Map<string, string | Uint8Array>;
    }
  >();
  let creates = 0,
    pauses = 0,
    loseCreate = false;
  const provider: EnvironmentProvider = {
    async create(input) {
      creates++;
      const ref = { provider: "cloud", id: randomUUID() };
      cloud.set(ref.id, {
        state: "running",
        metadata: input.metadata,
        files: new Map(),
      });
      if (loseCreate) throw new Error("private-cloud-key");
      return ref;
    },
    async list(metadata) {
      return [...cloud]
        .filter(([, v]) =>
          Object.entries(metadata).every(([k, x]) => v.metadata[k] === x),
        )
        .map(([id]) => ({ id, provider: "cloud" }));
    },
    async info(id) {
      return { state: cloud.get(id)?.state ?? "missing" };
    },
    async resume(id) {
      if (!cloud.has(id)) throw new Error("missing");
      cloud.get(id)!.state = "running";
      return { state: "running" };
    },
    async pause(id) {
      pauses++;
      cloud.get(id)!.state = "paused";
    },
    async destroy(id) {
      cloud.delete(id);
    },
    async setTimeout() {},
    async httpEndpoint(id) {
      return {
        url: `https://host.fixture/${id}`,
        headers: { "x-environment-access": "private-traffic-token" },
      };
    },
    async *exec(id, argv, options) {
      if (argv[0] === "mv") {
        const f = cloud.get(id)!.files;
        f.set(argv[3]!, f.get(argv[2]!)!);
        f.delete(argv[2]!);
      }
      options.onExit({ exitCode: 0 });
    },
    async writeFile(id, path, value) {
      cloud.get(id)!.files.set(path, value);
    },
    async readFile(id, path) {
      const value = cloud.get(id)?.files.get(path);
      if (value === undefined) throw new Error("missing");
      return typeof value === "string" ? new TextEncoder().encode(value) : value;
    },
  };
  const actualFetch = fetch;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname !== "host.fixture") return actualFetch(input, init);
      const id = url.pathname.split("/")[1]!,
        instance = cloud.get(id)!;
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer " + instance.files.get("/home/user/.agent-host-service/token"),
      );
      expect(new Headers(init?.headers).get("x-environment-access")).toBe(
        "private-traffic-token",
      );
      if (url.pathname.endsWith("/health"))
        return Response.json({ protocolVersion: 1, ...(serving.hostCapabilities ? { capabilities: serving.hostCapabilities } : {}) });
      if (url.pathname.endsWith("/runtimes/inspect")) {
        // A Host with one runtime describes it whatever is asked for; one with several answers for the one named.
        const runtimeId = serving.runtimes ? String(JSON.parse(String(init?.body)).runtimeId) : "personal";
        if (runtimeId !== "personal" && !serving.runtimes?.[runtimeId]) return Response.json({ error: "runtime_not_found" }, { status: 404 });
        return Response.json({ id: runtimeId, cwd: "/home/user/workspace", available: true, ...(runtimeId === "personal" ? serving.runtime : serving.runtimes![runtimeId]) });
      }
      if (url.pathname.endsWith("/runtimes"))
        return Response.json({ runtimes: [{ id: "personal" }] });
      if (serving.host) return serving.host(url, init);
      return Response.json({ error: "fixture_unknown_path" }, { status: 404 });
    },
  );
  const optionsFile = join(directory, "onboarding.json"),
    hostConfigFile = join(directory, "profile.json");
  privateFile(hostConfigFile, {
    stateDirectory: "state",
    runtimes: serving.hostConfigRuntimes ?? [
      { id: "personal", kernel: "codex", cwd: "/home/user/workspace" },
      ...Object.entries(serving.runtimes ?? {}).map(([id, runtime]) => ({ id, kernel: runtime.kernel, cwd: "/home/user/workspace" })),
    ],
  });
  const access = await accessIssuer(cleanup);
  /** One Mau process on the fixture's state directory. `restart` closes it and opens another, as a deployment would. */
  const open = async (extra: Record<string, unknown>) => {
    privateFile(optionsFile, {
      edgeIdentity: access.config({ [aliceEmail]: alice }),
      ...extra,
      environments: {
        configFile: "providers.json",
        profiles: [
          {
            id: "cloud",
            label: "Cloud",
            provider: "cloud",
            template: "tools",
            kernel: "codex",
            runtimeId: "personal",
            hostConfigFile,
            instructions: "Work carefully.\nAnswer in the owner's language.",
            owners: [alice],
            ...serving.profile,
          },
        ],
      },
    });
    const mau = createMau(
      {
        serverName: "example.test",
        publicUrl: "http://127.0.0.1" + root,
        stateDir: directory,
        ...routerConfig,
      },
      optionsFile,
      { ...(serving.externalHosts ? { externalHosts: serving.externalHosts } : {}), environments: async () => ({ provider: (id: string) => {
        if (id !== "cloud") throw Object.assign(new Error("Provider is not configured."), { code: "unknown_provider" });
        return provider;
      } }),
        router: {
        edgeIdentityCerts: access.certsUrl,
        ...routerDependencies,
        authenticate: async (token) => {
          if (token === "alice") return alice;
          if (token === "bob") return bob;
          throw new WorkError("account_session_invalid", 401);
        },
      } },
      serving.webRoot ? { webRoot: serving.webRoot } : {},
    );
    const server = mau.app.listen(0, "127.0.0.1");
    mau.attach(server);
    await new Promise<void>((r) => server.once("listening", r));
    let closed: Promise<void> | undefined;
    const close = () => closed ??= (async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await mau.close();
    })();
    return { mau, close, base: `http://127.0.0.1:${(server.address() as any).port}` };
  };
  let current = await open(extraOptions);
  cleanup.push(() => current.close());
  const service = current.mau.router.service;
  const api = async (path: string, body?: unknown, owner = "alice", prefix = root, method?: "PUT") => {
    const response = await fetch(current.base + prefix + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        authorization: "Bearer " + owner,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: (await response.json()) as any };
  };
  const agent = await service.create(alice, "helper");
  const path = `/agents/${agent.id}/environment`;
  const settled = async () => {
    for (let n = 0; n < 200; n++) {
      const result = (await api(path)).data;
      if (!result.busy) return result;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("fixture_timeout");
  };
  return {
    get base() { return current.base; },
    directory,
    hostConfigFile,
    cloud,
    provider,
    get service() { return current.mau.router.service; },
    get mau() { return current.mau; },
    /** Stop this Mau and start another on the same state, optionally with other product options. */
    restart: async (options: Record<string, unknown> = extraOptions) => {
      await current.close();
      current = await open(options);
      await current.mau.router.service.start();
    },
    api,
    agent,
    path,
    settled,
    access,
    /** The header Cloudflare adds behind Access: for a browser context's `extraHTTPHeaders` or a direct request. */
    edgeHeaders: (claims: Record<string, unknown> = {}) => ({ "cf-access-jwt-assertion": access.jwt(claims) }),
    get creates() {
      return creates;
    },
    get pauses() {
      return pauses;
    },
    loseCreate: () => {
      loseCreate = true;
    },
  };
}
