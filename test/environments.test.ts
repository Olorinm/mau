import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { RouterError as WorkError } from "@agent-router/server";
import { createMau } from "../src/app.js";
import { privateFile } from "../src/files.js";
import { DurableStore } from "../src/store.js";
import { EnvironmentManager, type EnvironmentProvider } from "../src/environments.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});
const alice = "@alice:example.test",
  bob = "@bob:example.test",
  root = "/_mau/v1";
async function fixture() {
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
    { environments: async () => ({ provider: () => provider }), router: {
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
  );
  const service = mau.router.service;
  const server = mau.app.listen(0, "127.0.0.1");
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

it("owner-scoped durable allocation publishes verified bootstrap once and binds a private Host", async () => {
  const f = await fixture();
  expect((await f.api("/options", undefined, "bob")).data.environments).toEqual(
    [],
  );
  expect((await f.api(f.path, { profileId: "cloud" }, "bob")).status).toBe(404);
  expect(
    (await f.api(f.path, { profileId: "cloud", command: "evil" })).status,
  ).toBe(400);
  expect((await f.api(f.path, { profileId: "cloud" })).status).toBe(202);
  const ready = await f.settled();
  expect(ready.state).toBe("ready");
  expect(f.creates).toBe(1);
  await f.api(f.path, { profileId: "cloud" });
  expect(f.creates).toBe(1);
  const files = [...f.cloud.values()][0]!.files,
    dir = "/home/user/.agent-host-service/";
  const marker = JSON.parse(String(files.get(dir + "ready.json")));
  expect(marker.configSha256).toBe(
    createHash("sha256")
      .update(String(files.get(dir + "host.json")))
      .digest("hex"),
  );
  expect(marker.tokenSha256).toBe(
    createHash("sha256")
      .update(String(files.get(dir + "token")))
      .digest("hex"),
  );
  const setup = (await f.api(`/agents/${f.agent.id}`)).data;
  expect(setup.host.runtimeId).toBe("personal");
  expect(setup.environment.operationId).toBe(ready.operationId);
  expect(JSON.stringify(setup)).not.toContain(String(files.get(dir + "token")));
  expect(JSON.stringify(setup)).not.toContain("private-traffic-token");
  expect(
    statSync(
      join(
        f.directory,
        "mau",
        "agents",
        f.agent.id,
        "environment-token",
      ),
    ).mode & 0o777,
  ).toBe(0o600);
  const checks = (await f.api(`/agents/${f.agent.id}/check`, {}, "alice", "/_agent-router/v1")).data
    .checks;
  expect(checks[0].status).toBe("verified");
  expect((await f.api(f.path + "/pause", {})).status).toBe(202);
  expect((await f.settled()).state).toBe("paused");
  await f.api(f.path + "/resume", {});
  expect((await f.settled()).state).toBe("ready");
  expect(f.creates).toBe(1);
  await f.api(f.path + "/destroy", {});
  expect((await f.settled()).state).toBe("deleted");
  expect(f.cloud.size).toBe(0);
  expect((await f.api(f.path + "/resume", {})).status).toBe(409);
});
it("Mau creates the Router identity under the same owner and Router no longer exposes provisioning", async () => {
  const f = await fixture();
  const denied = await f.api("/agents", { name: "other", profileId: "cloud" }, "bob");
  expect(denied.status).toBe(403);
  expect(f.service.agents(bob)).toHaveLength(0);
  const created = await f.api("/agents", { name: "helper", profileId: "cloud" });
  expect(created.status).toBe(202);
  expect(created.data.agent.id).toBe(f.agent.id);
  expect(created.data.agent.owner).toBe(alice);
  expect((await f.settled()).state).toBe("ready");
  expect(f.service.agents(alice)).toHaveLength(1);
  for (const path of ["/setup", `/agents/${f.agent.id}/setup/environment`])
    expect((await f.api(path, undefined, "alice", "/_agent-router/v1")).status).toBe(404);
  expect((await f.api("/connection-options", undefined, "alice", "/_agent-router/v1")).data)
    .not.toHaveProperty("environments");
  const issued = f.service.issue(f.agent.id, "worker");
  expect((await f.api(f.path + "/pause", {}, issued.token)).status).toBe(401);
  expect(f.pauses).toBe(0);
});
it("lost creation response reconciles by operation metadata without buying a second environment", async () => {
  const f = await fixture();
  f.loseCreate();
  await f.api(f.path, { profileId: "cloud" });
  const failed = await f.settled();
  expect(failed.state).toBe("needs_action");
  expect(JSON.stringify(failed)).not.toContain("private-cloud-key");
  await f.api(f.path, { profileId: "cloud" });
  expect(f.creates).toBe(1);
  await f.api(f.path + "/reconcile", {});
  expect((await f.settled()).state).toBe("ready");
  expect(f.creates).toBe(1);
});
it("active or uncertain runs prevent pause before any cloud mutation and leave the worker usable", async () => {
  const f = await fixture();
  await f.api(f.path, { profileId: "cloud" });
  await f.settled();
  const runtime = await f.service.runtime(f.agent.id);
  runtime.connector.store.set("communication_runs", "fixture-run", {
    phase: "unknown",
  });
  await f.api(f.path + "/pause", {});
  const state = await f.settled();
  expect(state.state).toBe("ready");
  expect(state.error).toBe("agent_has_active_or_unknown_run");
  expect(f.pauses).toBe(0);
});
it("missing environments never silently create a replacement", async () => {
  const f = await fixture();
  await f.api(f.path, { profileId: "cloud" });
  await f.settled();
  f.cloud.clear();
  await f.api(f.path + "/resume", {});
  const state = await f.settled();
  expect(state.error).toBe("environment_missing_explicit_replacement_required");
  expect(f.creates).toBe(1);
});

it("concurrent requests allocate once and changing account assignments preserves existing execution bindings", async () => {
  const f = await fixture();
  const requests = await Promise.all([
    f.api(f.path, { profileId: "cloud" }),
    f.api(f.path, { profileId: "cloud" }),
  ]);
  expect(requests.every((r) => r.status === 202)).toBe(true);
  expect(requests[0]!.data.operationId).toBe(requests[1]!.data.operationId);
  expect((await f.settled()).state).toBe("ready");
  f.mau.environments.options.profiles[0]!.owners.push(bob);
  f.mau.environments.options.profiles[0]!.label = "Renamed display label";
  await f.api(f.path + "/resume", {});
  expect((await f.settled()).state).toBe("ready");
  expect(f.creates).toBe(1);
});
it("renewal failure stays visible and requires reconciliation without replacing the environment", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const f = await fixture();
    await f.api(f.path, { profileId: "cloud" });
    await f.settled();
    const renew = vi
      .spyOn(f.provider, "setTimeout")
      .mockRejectedValue(new Error("private-cloud-error"));
    await vi.advanceTimersByTimeAsync(30_000);
    const failed = await f.settled();
    expect(renew).toHaveBeenCalledOnce();
    expect(failed.state).toBe("needs_action");
    expect(JSON.stringify(failed)).not.toContain("private-cloud-error");
    renew.mockRestore();
    await f.api(f.path + "/reconcile", {});
    expect((await f.settled()).state).toBe("ready");
    expect(f.creates).toBe(1);
  } finally {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.useRealTimers();
  }
});

it("a second coordinator cannot acquire the same journal and a stale owner cannot mutate cloud resources", async () => {
  const f = await fixture();
  expect(() => new EnvironmentManager(f.mau.router.connections, f.service,
    f.mau.environments.options, f.directory, join(f.directory, "mau"), async () => ({ provider: () => f.provider })))
    .toThrow("environment_coordinator_already_running");
  await f.api(f.path, { profileId: "cloud" });
  await f.settled();
  const journal = new DurableStore(
    join(f.directory, "mau", "environments.sqlite"),
    "example.test",
  );
  try {
    journal.set("meta", "lease", {
      owner: "replacement-coordinator",
      expires: Date.now() + 60000,
    });
  } finally {
    journal.close();
  }
  expect((await f.api(f.path + "/pause", {})).status).toBe(503);
  expect(f.pauses).toBe(0);
  expect(f.creates).toBe(1);
});
