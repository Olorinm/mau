// Shared Mau fixture: simulated cloud lifecycle, fake Router accounts ("alice", "bob") and a fixture Host.
import { vi, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RouterError as WorkError } from "@agent-router/server";
import { createMau } from "../../src/app.js";
import { privateFile } from "../../src/files.js";
import type { EnvironmentProvider } from "../../src/environments.js";
import type { WorkspaceBackend } from "@olorinm/agent-environment/workspace";

export const alice = "@alice:example.test",
  bob = "@bob:example.test",
  root = "/_mau/v1";
export async function mauFixture(cleanup: Array<() => unknown>, serving: { webRoot?: string } = {}, workspaceBackend?: WorkspaceBackend) {
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
      const ref = { provider: "volc", id: randomUUID() };
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
        .map(([id]) => ({ id, provider: "volc" }));
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
        headers: { "e2b-traffic-access-token": "private-traffic-token" },
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
      expect(new Headers(init?.headers).get("e2b-traffic-access-token")).toBe(
        "private-traffic-token",
      );
      if (url.pathname.endsWith("/health"))
        return Response.json({ protocolVersion: 1 });
      if (url.pathname.endsWith("/runtimes/inspect"))
        return Response.json({ id: "personal", available: true });
      if (url.pathname.endsWith("/runtimes"))
        return Response.json({ runtimes: [{ id: "personal" }] });
      return Response.json({ error: "fixture_unknown_path" }, { status: 404 });
    },
  );
  const optionsFile = join(directory, "onboarding.json"),
    hostConfigFile = join(directory, "profile.json");
  privateFile(hostConfigFile, {
    stateDirectory: "state",
    runtimes: [
      { id: "personal", kernel: "codex", cwd: "/home/user/workspace" },
    ],
  });
  privateFile(optionsFile, {
    environments: {
      configFile: "providers.json",
      profiles: [
        {
          id: "cloud",
          label: "Cloud",
          provider: "volc",
          template: "tools",
          kernel: "codex",
          runtimeId: "personal",
          hostConfigFile,
          owners: [alice],
          ...(workspaceBackend ? { workspace: true } : {}),
        },
      ],
    },
  });
  const mau = createMau(
    {
      serverName: "example.test",
      homeserver: "https://matrix.fixture",
      publicUrl: "http://127.0.0.1" + root,
      stateDir: directory,
      asToken: "a".repeat(48),
      hsToken: "h".repeat(48),
    },
    optionsFile,
    { environments: async () => ({ provider: () => provider }),
      ...(workspaceBackend ? { workspaces: async () => workspaceBackend } : {}), router: {
      provision: async () => {},
      authenticate: async (token) => {
        if (token === "alice") return alice;
        if (token === "bob") return bob;
        throw new WorkError("account_session_invalid", 401);
      },
      transport: (agent) => ({
        identity: async () => agent.matrixId,
        sync: async (since) => {
          await new Promise((r) => setTimeout(r, 10));
          return { next_batch: since ?? "0" };
        },
        state: async () => [],
        history: async () => ({ events: [] }),
        createRoom: async () => "!fixture:example.test",
        join: async () => {},
        send: async () => "$fixture",
        stop: () => {},
      }),
    } },
    serving,
  );
  const service = mau.router.service;
  const server = mau.app.listen(0, "127.0.0.1");
  mau.attach(server);
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  cleanup.push(() => mau.close());
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const api = async (path: string, body?: unknown, owner = "alice", prefix = root) => {
    const response = await fetch(base + prefix + path, {
      method: body === undefined ? "GET" : "POST",
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
    base,
    directory,
    cloud,
    provider,
    service,
    mau,
    api,
    agent,
    path,
    settled,
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
