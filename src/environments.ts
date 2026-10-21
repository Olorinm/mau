import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { RouterError as WorkError, ServiceHttp, HttpAgentHost, type ConnectionConfiguration, type ManagedService } from "@agent-router/server";
import type { EnvironmentProvider as ComponentProvider, EnvironmentRef as Ref } from "@olorinm/agent-environment";
import { DurableStore } from "./store.js";
import { privateFile } from "./files.js";
import { prepareSsh, type SshConnection } from "./ssh.js";
import { Workspaces } from "./workspaces.js";
import type { WorkspaceBackend, WorkspaceBinding } from "@olorinm/agent-environment/workspace";

const key = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const remotePath = z
  .string()
  .refine(
    (p) =>
      p.startsWith("/") &&
      !p.includes("\0") &&
      posix.normalize(p) === p &&
      p !== "/",
    "absolute normalized path required",
  );
export const environmentOptionsSchema = z
  .object({
    configFile: z.string().min(1),
    modulePath: z.string().min(1).optional(),
    workspaceConfigFile: z.string().min(1).optional(),
    profiles: z
      .array(
        z
          .object({
            id: key,
            label: z.string().min(1).max(100),
            owners: z.array(z.string().min(1)).min(1),
            provider: z.string().min(1),
            template: z.string().min(1),
            kernel: z.string().min(1).max(48),
            runtimeId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/),
            hostConfigFile: z.string().min(1),
            workspace: z.boolean().optional(),
            instructions: z.string().max(200_000).optional(),
            directory: remotePath.default("/home/user/.agent-host-service"),
            port: z.number().int().min(1).max(65535).default(37420),
            ssh: z.object({ port: z.number().int().min(1024).max(65535).default(37421) }).strict().optional(),
            lifetimeSeconds: z.number().int().min(600).max(86400).default(3600),
            onTimeout: z.enum(["kill", "pause"]).default("kill"),
            idlePauseSeconds: z.number().int().min(600).max(2_592_000).optional(),
            files: z
              .array(
                z
                  .object({
                    source: z.string().min(1),
                    destination: remotePath,
                  })
                  .strict(),
              )
              .max(30)
              .default([]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
type Profile = z.infer<typeof environmentOptionsSchema>["profiles"][number];
export type EnvironmentProvider = Pick<ComponentProvider,
  "create" | "list" | "info" | "resume" | "pause" | "destroy" | "setTimeout" | "httpEndpoint" | "exec" | "writeFile">;
export interface Environments {
  provider(id: string): EnvironmentProvider;
}
type Phase =
  | "creating"
  | "starting"
  | "ready"
  | "pausing"
  | "paused"
  | "sleeping"
  | "resuming"
  | "deleting"
  | "deleted"
  | "needs_action";
interface Binding {
  agentId: string;
  operationId: string;
  profileId: string;
  profileHash: string;
  provider: string;
  phase: Phase;
  ref?: Ref;
  error?: string;
  updatedAt: string;
  workspaceId?: string;
  workspace?: WorkspaceBinding;
  tokenPerOperation?: boolean;
  previous?: Binding;
}
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const collection = "environments";
// Only what identifies the created environment and its Host endpoint. Labels, owners,
// instructions, lifetime and bootstrap sources may change without stranding existing Agents.
const profileHash = (p: Profile) =>
  hash(
    JSON.stringify([p.provider, p.template, p.kernel, p.runtimeId, p.directory, p.port, ...(p.workspace ? [true] : [])]),
  );
// One failed renewal request is not evidence the environment stopped. Three 30-second
// attempts stay well inside the shortest 600-second lifetime.
const renewalAttempts = 3;

/** Product-owned provisioning journal; the external module alone operates cloud resources. */
export class EnvironmentManager {
  readonly workspaces: Workspaces;
  private readonly verifiedWorkspaces = new Set<string>();
  private readonly sshActive = new Map<string, number>();
  private readonly sshPreparing = new Map<string, Promise<unknown>>();
  readonly options: z.infer<typeof environmentOptionsSchema>;
  private readonly store: DurableStore;
  private readonly jobs = new Map<
    string,
    { kind: "operation" | "upkeep"; promise: Promise<void> }
  >();
  private readonly renewalFailures = new Map<string, number>();
  // Last Host request per Agent. In memory: a restart only restarts the idle window.
  private readonly activity = new Map<string, number>();
  private readonly lease = randomUUID();
  private timer: ReturnType<typeof setInterval> | undefined;
  private manager: Promise<Environments> | undefined;
  private closed = false;
  private readonly controller = new AbortController();
  constructor(
    private readonly configuration: ConnectionConfiguration,
    private readonly service: ManagedService,
    options: z.infer<typeof environmentOptionsSchema>,
    base: string,
    readonly directory: string,
    private readonly load?: () => Promise<Environments>,
    workspaceLoad?: () => Promise<WorkspaceBackend>,
  ) {
    this.options = structuredClone(options);
    this.options.configFile = resolve(base, options.configFile);
    if (options.modulePath)
      this.options.modulePath = resolve(base, options.modulePath);
    if (
      new Set(options.profiles.map((p) => p.id)).size !==
      options.profiles.length
    )
      throw new Error("duplicate_environment_profile");
    for (const p of this.options.profiles) {
      if (p.ssh?.port === p.port) throw new Error("ssh_port_conflicts_with_host");
      p.hostConfigFile = resolve(base, p.hostConfigFile);
      for (const f of p.files) f.source = resolve(base, f.source);
    }
    this.store = new DurableStore(
      join(directory, "environments.sqlite"),
      service.config.serverName,
    );
    this.workspaces = new Workspaces(this.store,
      options.workspaceConfigFile ? resolve(base, options.workspaceConfigFile) : undefined,
      () => this.assertOpen(), workspaceLoad);
    try {
      this.store.acquireLease(this.lease);
    } catch (error) {
      this.store.close();
      throw error;
    }
    // Interrupted mutations require explicit reconciliation, never a second create.
    for (const { value } of this.store.entries<Binding>(collection))
      if (
        ["creating", "starting", "pausing", "resuming", "deleting"].includes(
          value.phase,
        )
      )
        this.save({
          ...value,
          phase: "needs_action",
          error: "environment_operation_interrupted",
        });
    this.timer = setInterval(() => void this.maintain(), 30_000);
    this.timer.unref();
    // Lease refresh must be shorter than DurableStore's 30-second lease.
    this.leaseTimer = setInterval(() => {
      try {
        this.store.acquireLease(this.lease);
      } catch {
        clearInterval(this.timer);
        clearInterval(this.leaseTimer);
        this.controller.abort();
      }
    }, 10_000);
    this.leaseTimer.unref();
  }
  private leaseTimer: ReturnType<typeof setInterval>;
  private assertOpen() {
    if (this.closed || this.controller.signal.aborted)
      throw new WorkError("environment_coordinator_unavailable", 503);
    this.assertLease();
  }
  private assertLease() {
    const lease = this.store.get<{ owner: string; expires: number }>(
      "meta",
      "lease",
    );
    if (lease?.owner !== this.lease || lease.expires <= Date.now())
      throw new WorkError("environment_coordinator_unavailable", 503);
  }
  private save(record: Binding) {
    this.assertLease();
    this.store.set(collection, record.agentId, {
      ...record,
      updatedAt: new Date().toISOString(),
    });
  }
  private binding(id: string) {
    return this.store.get<Binding>(collection, id);
  }
  private async provider(record: Binding) {
    this.manager ??= this.load ? this.load() : this.importManager();
    try {
      return (await this.manager).provider(record.provider);
    } catch {
      this.manager = undefined;
      throw new WorkError("environment_provider_unavailable", 503);
    }
  }
  private async importManager(): Promise<Environments> {
    const specifier = this.options.modulePath
      ? pathToFileURL(this.options.modulePath).href
      : "@olorinm/agent-environment";
    const module = await import(specifier);
    if (typeof module.loadConfiguration !== "function")
      throw new Error("invalid_environment_module");
    return module.loadConfiguration(this.options.configFile);
  }
  profiles(owner: string) {
    return this.options.profiles.filter(
      (p) => p.owners.includes(owner) || p.owners.includes("*"),
    );
  }
  private profile(record: Binding): Profile {
    const p = this.options.profiles.find((p) => p.id === record.profileId);
    if (!p || profileHash(p) !== record.profileHash)
      throw new WorkError("environment_profile_changed", 409);
    return p;
  }
  summary(owner: string, agentId: string) {
    this.service.owned(agentId, owner);
    return this.view(this.binding(agentId));
  }
  private view(record: Binding | undefined) {
    return record
      ? {
          operationId: record.operationId,
          profileId: record.profileId,
          state: record.phase,
          busy: this.jobs.has(record.agentId),
          updatedAt: record.updatedAt,
          ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
          ...(record.error ? { error: record.error } : {}),
          ...(record.previous ? { previousEnvironment: { profileId: record.previous.profileId, state: record.previous.phase } } : {}),
        }
      : null;
  }
  async begin(owner: string, agentId: string, profileId: string, workspaceId?: string) {
    this.assertOpen();
    const agent = this.service.owned(agentId, owner);
    const profile = this.profiles(owner).find((p) => p.id === profileId);
    if (!profile) throw new WorkError("environment_profile_not_assigned", 403);
    if (workspaceId) {
      if (!profile.workspace) throw new WorkError("environment_workspace_not_supported", 409);
      this.workspaces.owned(owner, workspaceId);
    }
    const existing = this.binding(agentId);
    if (existing) {
      if (existing.profileId !== profileId || workspaceId && existing.workspaceId !== workspaceId)
        throw new WorkError("environment_already_bound", 409);
      return this.view(existing);
    }
    if (this.configuration.configuration(agent)?.host)
      throw new WorkError("host_already_bound", 409);
    // Validate private local inputs before making a billable request.
    this.bundle(profile);
    if (profile.workspace) await this.workspaces.backend();
    const record: Binding = {
      agentId,
      operationId: randomUUID(),
      profileId,
      profileHash: profileHash(profile),
      provider: profile.provider,
      phase: "creating",
      updatedAt: new Date().toISOString(),
      tokenPerOperation: true,
      ...(workspaceId ? { workspaceId } : {}),
    };
    const provider = await this.provider(record);
    this.assertOpen();
    const inserted = this.store.transaction(() => {
      if (this.binding(agentId)) return false;
      if (profile.workspace && !record.workspaceId) record.workspaceId = this.workspaces.create(owner, agent.name).id;
      return this.store.insert(collection, agentId, record);
    });
    if (!inserted) {
      const winner = this.binding(agentId)!;
      if (winner.profileId !== profileId || workspaceId && winner.workspaceId !== workspaceId)
        throw new WorkError("environment_already_bound", 409);
      return this.view(winner);
    }
    this.launch(record, async () => {
      if (record.workspaceId) {
        const workspace = this.workspaces.owned(owner, record.workspaceId);
        record.workspace = await (await this.workspaces.backend()).prepare(workspace.storageOwner, workspace.id, profile.template);
        this.save(record); // persist trusted coordinates before requesting a sandbox
      }
      record.ref = await provider.create({
        template: record.workspace?.template ?? profile.template,
        timeoutSeconds: profile.lifetimeSeconds,
        onTimeout: profile.onTimeout,
        metadata: { "mau-operation": record.operationId, ...record.workspace?.metadata },
      });
      this.save(record); // durable ID precedes bootstrap or further network work
      await this.bootstrap(owner, record, provider, profile);
    });
    return this.view(record);
  }
  /** Replace a stopped execution environment, retaining the Agent's identity and channels. */
  async replace(owner: string, agentId: string, profileId: string, expectedOperationId: string) {
    this.assertOpen();
    this.service.owned(agentId, owner);
    const old = this.binding(agentId);
    if (!old || old.operationId !== expectedOperationId) throw new WorkError("environment_binding_changed", 409);
    if (this.jobs.has(agentId) || this.sshActive.has(agentId)) throw new WorkError("environment_operation_running", 409);
    if (old.previous) throw new WorkError("environment_previous_replacement_retained", 409);
    if (old.phase !== "paused" && old.phase !== "deleted") throw new WorkError("environment_pause_before_replace", 409);
    const profile = this.profiles(owner).find(p => p.id === profileId);
    if (!profile) throw new WorkError("environment_profile_not_assigned", 403);
    if (old.workspaceId || profile.workspace) throw new WorkError("environment_workspace_replacement_unsupported", 409);
    this.bundle(profile);
    if (old.ref && (await (await this.provider(old)).info(old.ref.id)).state !== (old.phase === "deleted" ? "missing" : "paused"))
      throw new WorkError("environment_stop_unconfirmed", 409);
    this.assertOpen();
    if (this.jobs.has(agentId) || this.sshActive.has(agentId) || this.binding(agentId)?.operationId !== expectedOperationId || this.binding(agentId)?.phase !== old.phase)
      throw new WorkError("environment_binding_changed", 409);
    const record: Binding = {
      agentId, operationId: randomUUID(), profileId, profileHash: profileHash(profile), provider: profile.provider,
      phase: "creating", updatedAt: new Date().toISOString(), tokenPerOperation: true, previous: old,
    };
    this.save(record);
    this.verifiedWorkspaces.delete(agentId);
    this.launch(record, async () => {
      const provider = await this.provider(record);
      record.ref = await provider.create({ template: profile.template, timeoutSeconds: profile.lifetimeSeconds,
        onTimeout: profile.onTimeout, metadata: { "mau-operation": record.operationId } });
      this.save(record);
      await this.bootstrap(owner, record, provider, profile);
    });
    return this.view(record);
  }
  /** Return to the retained, stopped environment. Both sets of files remain intact. */
  async rollbackReplacement(owner: string, agentId: string, expectedOperationId: string) {
    this.assertOpen();
    this.service.owned(agentId, owner);
    const current = this.binding(agentId);
    if (!current?.previous || current.operationId !== expectedOperationId) throw new WorkError("environment_binding_changed", 409);
    if (this.jobs.has(agentId) || this.sshActive.has(agentId)) throw new WorkError("environment_operation_running", 409);
    if (!["paused", "deleted", "needs_action"].includes(current.phase)) throw new WorkError("environment_pause_before_replace", 409);
    if (!current.ref) throw new WorkError("environment_creation_requires_operator_reconciliation", 409);
    this.launch(current, async () => {
      const state = (await (await this.provider(current)).info(current.ref!.id)).state;
      if (state !== "paused" && state !== "missing") throw new WorkError("environment_stop_unconfirmed", 409);
      const old = structuredClone(current.previous!);
      const profile = this.profile(old);
      const previousState = old.ref ? (await (await this.provider(old)).info(old.ref.id)).state : "missing";
      if (previousState === "missing") throw new WorkError("previous_environment_missing", 409);
      if (previousState !== "paused") throw new WorkError("previous_environment_stop_unconfirmed", 409);
      this.save(old);
      try {
        await this.configuration.replaceHost(owner, agentId, {
          binding: old.operationId, runtimeId: profile.runtimeId, instanceName: "channel-host",
          instructions: profile.instructions ?? "",
        });
        this.store.set("retired_environments", current.operationId, { ...current, previous: undefined });
      } catch (error) {
        this.save(current);
        throw error;
      }
    });
    return this.view(current);
  }
  private bundle(profile: Profile) {
    const content = readFileSync(profile.hostConfigFile, "utf8");
    const config = JSON.parse(content) as {
      runtimes?: Array<{ id: string; kernel: string; cwd?: string }>;
      stateDirectory?: string;
    };
    if (
      !config.runtimes?.some(
        (r) => r.id === profile.runtimeId && r.kernel === profile.kernel,
      )
    )
      throw new WorkError("environment_runtime_profile_mismatch", 409);
    for (const file of profile.files) readFileSync(file.source);
    if (profile.workspace) {
      const shared = (path: string) => path === "/home/user/workspace" || path.startsWith("/home/user/workspace/");
      if (config.runtimes.find(r => r.id === profile.runtimeId)?.cwd !== "/home/user/workspace" ||
          shared(profile.directory) || config.stateDirectory && shared(config.stateDirectory) ||
          profile.files.some(f => shared(f.destination))) throw new WorkError("invalid_workspace_host_profile", 409);
    }
    return content;
  }
  private launch(
    record: Binding,
    operation: () => Promise<void>,
    kind: "operation" | "upkeep" = "operation",
  ) {
    if (this.jobs.has(record.agentId))
      throw new WorkError("environment_operation_running", 409);
    if (kind === "operation") this.renewalFailures.delete(record.agentId);
    const job = Promise.resolve()
      .then(() => {
        this.assertOpen();
        return operation();
      })
      .catch((error) => {
        const code =
          error instanceof WorkError
            ? error.message
            : "environment_operation_unconfirmed";
        const unchanged =
          record.phase === "ready" &&
          code === "agent_has_active_or_unknown_run";
        this.save({
          ...record,
          phase: unchanged ? "ready" : "needs_action",
          error: code,
        });
      })
      .finally(() => {
        this.jobs.delete(record.agentId);
      });
    this.jobs.set(record.agentId, { kind, promise: job });
    // A journal failure must stop new work, without an unhandled rejection.
    void job.catch(() => this.controller.abort());
  }
  private async exec(
    provider: EnvironmentProvider,
    id: string,
    argv: string[],
  ) {
    this.assertOpen();
    let exit: number | null = null;
    for await (const _ of provider.exec(id, argv, {
      timeoutSeconds: 60,
      onExit: (e) => {
        exit = e.exitCode;
      },
    })) {
      /* Never log private command output. */
    }
    if (exit !== 0)
      throw new WorkError("environment_bootstrap_command_failed", 502);
  }
  private token(record: Binding) {
    if (record.tokenPerOperation) return join(this.directory, "agents", record.agentId, "environments", record.operationId, "environment-token");
    return join(
      join(this.directory, "agents", record.agentId),
      "environment-token",
    );
  }
  private async bootstrap(
    owner: string,
    record: Binding,
    provider: EnvironmentProvider,
    profile: Profile,
  ) {
    const id = record.ref!.id;
    record.phase = "starting";
    delete record.error;
    this.save(record);
    await this.verifyWorkspace(record, provider);
    const config = this.bundle(profile),
      tokenFile = this.token(record);
    let token: string;
    try {
      token = readFileSync(tokenFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      token = randomBytes(32).toString("base64url");
      privateFile(tokenFile, token);
    }
    await this.exec(provider, id, ["mkdir", "-p", "--", profile.directory]);
    await this.exec(provider, id, ["chmod", "--", "700", profile.directory]);
    // The image's entrypoint is already waiting. Publish readiness only after all private files.
    for (const file of profile.files) {
      await this.exec(provider, id, [
        "mkdir",
        "-p",
        "--",
        posix.dirname(file.destination),
      ]);
      await this.exec(provider, id, [
        "chmod",
        "--",
        "700",
        posix.dirname(file.destination),
      ]);
      await provider.writeFile(id, file.destination, readFileSync(file.source));
      await this.exec(provider, id, ["chmod", "--", "600", file.destination]);
    }
    const dir = profile.directory;
    await provider.writeFile(id, posix.join(dir, "host.json.upload"), config);
    await provider.writeFile(id, posix.join(dir, "token.upload"), token);
    await this.exec(provider, id, [
      "chmod",
      "--",
      "600",
      posix.join(dir, "host.json.upload"),
      posix.join(dir, "token.upload"),
    ]);
    await this.exec(provider, id, [
      "mv",
      "--",
      posix.join(dir, "host.json.upload"),
      posix.join(dir, "host.json"),
    ]);
    await this.exec(provider, id, [
      "mv",
      "--",
      posix.join(dir, "token.upload"),
      posix.join(dir, "token"),
    ]);
    await provider.writeFile(
      id,
      posix.join(dir, "ready.json.upload"),
      JSON.stringify({
        version: 1,
        configSha256: hash(config),
        tokenSha256: hash(token),
      }),
    );
    await this.exec(provider, id, [
      "mv",
      "--",
      posix.join(dir, "ready.json.upload"),
      posix.join(dir, "ready.json"),
    ]);
    await this.ready(record, profile);
    const host = { runtimeId: profile.runtimeId, instanceName: "channel-host",
      instructions: profile.instructions ?? "", binding: record.operationId };
    const configured = this.configuration.configuration(this.service.owned(record.agentId, owner));
    if (record.previous && configured?.host?.binding !== record.operationId)
      await this.configuration.replaceHost(owner, record.agentId, host);
    else await this.configuration.edit(owner, record.agentId, config => {
      if (!config.connections.some(connection => connection.kind === "matrix"))
        config.connections.push({ id: "matrix", kind: "matrix", ownerAddresses: [owner], peerAddresses: [], groupIds: [] });
      config.host = host;
    });
    record.phase = "ready";
    delete record.error;
    this.save(record);
    this.activity.set(record.agentId, Date.now());
  }
  http(
    agentId: string,
    operationId: string,
    allowStarting = false,
  ): ServiceHttp {
    const coordinator = this;
    return new (class extends ServiceHttp {
      override async request(
        path: string,
        options: Parameters<ServiceHttp["request"]>[1] = {},
      ) {
        const record = coordinator.binding(agentId);
        if (
          !record?.ref ||
          record.operationId !== operationId ||
          (!allowStarting && (record.phase !== "ready" || record.workspaceId && !coordinator.verifiedWorkspaces.has(agentId)))
        )
          throw new WorkError("environment_not_ready", 409);
        const profile = coordinator.profile(record),
          provider = await coordinator.provider(record);
        const endpoint = await provider.httpEndpoint(
          record.ref.id,
          profile.port,
        );
        coordinator.activity.set(agentId, Date.now());
        const headers = new Headers(endpoint.headers);
        new Headers(options.headers).forEach((v, k) => headers.set(k, v));
        return new ServiceHttp(
          endpoint.url,
          readFileSync(coordinator.token(record), "utf8").trim(),
        ).request(path, { ...options, headers });
      }
    })(`https://${agentId}.mau.invalid`, "");
  }
  host(agentId: string, operationId: string) {
    return new HttpAgentHost(this.http(agentId, operationId));
  }
  private async ready(record: Binding, profile: Profile) {
    const deadline = Date.now() + 180_000,
      http = this.http(record.agentId, record.operationId, true);
    for (;;) {
      this.assertOpen();
      try {
        const health = await http.request("/v1/health");
        const ready = await http.request("/v1/runtimes/inspect", {
          body: { runtimeId: profile.runtimeId },
        });
        if (health.protocolVersion === 1 && ready.available) return;
      } catch {
        /* Keep the same environment while the image starts. */
      }
      if (Date.now() > deadline)
        throw new WorkError("environment_host_not_ready", 409);
      await delay(1000, undefined, { signal: this.controller.signal });
    }
  }
  private async acquireSsh(owner: string, agentId: string) {
    this.assertOpen(); this.service.owned(agentId, owner);
    const running = this.jobs.get(agentId);
    if (running?.kind === "upkeep") await running.promise.catch(() => {});
    this.assertOpen();
    const record = this.binding(agentId);
    if (!record?.ref || record.phase !== "ready" || this.jobs.has(agentId) || record.workspaceId && !this.verifiedWorkspaces.has(agentId))
      throw new WorkError("environment_not_ready", 409);
    const profile = this.profile(record);
    if (!profile.ssh) throw new WorkError("ssh_not_enabled", 409);
    const count = this.sshActive.get(agentId) ?? 0;
    if (count >= 8) throw new WorkError("ssh_connection_limit", 429);
    this.sshActive.set(agentId, count + 1); this.activity.set(agentId, Date.now());
    let released = false;
    return { record, profile, port: profile.ssh.port, release: () => {
      if (released) return; released = true;
      const remaining = (this.sshActive.get(agentId) ?? 1) - 1;
      if (remaining) this.sshActive.set(agentId, remaining); else this.sshActive.delete(agentId);
      this.activity.set(agentId, Date.now());
    } };
  }
  async prepareSsh(owner: string, agentId: string, publicKey: string) {
    const lease = await this.acquireSsh(owner, agentId);
    const previous = this.sshPreparing.get(agentId);
    const pending = (async () => {
      await previous?.catch(() => {});
      this.assertOpen();
      return prepareSsh(await this.provider(lease.record), lease.record.ref!.id,
        lease.profile.directory, join(this.directory, "agents", agentId), lease.port, publicKey);
    })();
    this.sshPreparing.set(agentId, pending);
    try { return await pending; }
    finally { lease.release(); if (this.sshPreparing.get(agentId) === pending) this.sshPreparing.delete(agentId); }
  }
  async connectSsh(owner: string, agentId: string, keyId: string): Promise<SshConnection> {
    const lease = await this.acquireSsh(owner, agentId);
    try {
      const provider = await this.provider(lease.record);
      const endpoint = await provider.httpEndpoint(lease.record.ref!.id, lease.port);
      const token = readFileSync(join(this.directory, "agents", agentId, "ssh-token"), "utf8");
      return { url: new URL("/ssh", endpoint.url), headers: { ...endpoint.headers,
        Authorization: "Bearer " + token, "X-Mau-Ssh-Key": keyId }, release: lease.release };
    } catch (error) { lease.release(); throw error; }
  }
  async action(
    owner: string,
    agentId: string,
    action: "resume" | "pause" | "destroy" | "reconcile",
  ) {
    this.assertOpen();
    this.service.owned(agentId, owner);
    // Renewal is background upkeep; a lifecycle request waits for it instead of failing.
    const running = this.jobs.get(agentId);
    if (running?.kind === "upkeep") await running.promise.catch(() => {});
    this.assertOpen();
    const record = this.binding(agentId);
    if (!record) throw new WorkError("environment_not_configured", 404);
    if (this.jobs.has(agentId))
      throw new WorkError("environment_operation_running", 409);
    if (this.sshActive.has(agentId)) throw new WorkError("environment_has_active_ssh", 409);
    if (record.phase === "deleted")
      throw new WorkError("environment_deleted_create_new_agent", 409);
    this.launch(record, () => this.lifecycle(owner, record, action));
    return this.view(record);
  }
  /** Router calls this while deliverable work waits; only an idle-paused environment wakes. */
  wake(agentId: string, binding: string) {
    try {
      const record = this.binding(agentId);
      if (record?.operationId !== binding || record.phase !== "sleeping" || this.jobs.has(agentId)) return;
      this.assertOpen();
      this.launch(record, () => this.lifecycle(this.service.agent(agentId).owner, record, "resume"));
    } catch {
      /* Router asks again on its next tick. */
    }
  }
  private async lifecycle(
    owner: string,
    record: Binding,
    action: "resume" | "pause" | "destroy" | "reconcile" | "sleep",
  ) {
    const agentId = record.agentId;
    if (action === "pause" && record.phase === "sleeping") {
      // Already paused in the cloud; only stop waking it for new messages.
      record.phase = "paused";
      this.save(record);
      return;
    }
    const provider = await this.provider(record);
    if (!record.ref) {
      const found = await provider.list({
        "mau-operation": record.operationId,
      });
      if (found.length !== 1)
        throw new WorkError(
          "environment_creation_requires_operator_reconciliation",
          409,
        );
      record.ref = { provider: record.provider, id: found[0]!.id };
      this.save(record);
    }
    const id = record.ref.id;
    if (action === "destroy" || action === "pause" || action === "sleep") {
      // Stop workers and reject active/uncertain native work before cloud lifecycle changes.
      await this.configuration.withStoppedRuntime(
        owner, agentId,
        async () => {
          record.phase = action === "destroy" ? "deleting" : "pausing";
          delete record.error;
          this.save(record);
          if (action === "destroy") {
            await provider.destroy(id);
            record.phase = "deleted";
          } else {
            await provider.pause(id);
            const deadline = Date.now() + 180_000;
            while ((await provider.info(id)).state !== "paused") {
              this.assertOpen();
              if (Date.now() > deadline)
                throw new WorkError("environment_pause_unconfirmed", 409);
              await delay(1000, undefined, {
                signal: this.controller.signal,
              });
            }
            record.phase = action === "sleep" ? "sleeping" : "paused";
          }
          this.verifiedWorkspaces.delete(agentId);
          this.save(record);
        },
        async () => {
          record.phase = "needs_action";
          record.error = "environment_lifecycle_unconfirmed";
          this.save(record);
        },
      );
      return;
    }
    const state = (await provider.info(id)).state;
    if (state === "missing")
      throw new WorkError(
        "environment_missing_explicit_replacement_required",
        409,
      );
    if (action === "reconcile" && state === "paused") {
      record.phase = "paused";
      delete record.error;
      this.save(record);
      return;
    }
    const profile = this.profile(record);
    record.phase = "resuming";
    delete record.error;
    this.save(record);
    if (
      (await provider.resume(id, profile.lifetimeSeconds)).state !== "running"
    )
      throw new WorkError("environment_resume_pending", 409);
    const config = this.configuration.configuration(
      this.service.agent(agentId),
    );
    if (config?.host?.binding !== record.operationId)
      await this.bootstrap(owner, record, provider, profile);
    else {
      await this.verifyWorkspace(record, provider);
      await this.ready(record, profile);
      record.phase = "ready";
      delete record.error;
      this.save(record);
    }
    this.activity.set(agentId, Date.now());
  }
  assertReady(agentId: string, operationId: string) {
    const b = this.binding(agentId);
    this.assertOpen();
    if (b?.operationId !== operationId || b.phase !== "ready" || b.workspaceId && !this.verifiedWorkspaces.has(agentId))
      throw new WorkError("environment_not_ready", 409);
  }
  private async verifyWorkspace(record: Binding, provider: EnvironmentProvider) {
    if (!record.workspaceId) return;
    this.verifiedWorkspaces.delete(record.agentId);
    if (!record.workspace || !record.ref) throw new WorkError("workspace_binding_unconfirmed", 409);
    const owner = this.service.agent(record.agentId).owner;
    this.workspaces.owned(owner, record.workspaceId);
    try { await (await this.workspaces.backend()).verify(provider, record.ref.id, record.workspace); }
    catch { throw new WorkError("workspace_mount_unavailable", 503); }
    this.verifiedWorkspaces.add(record.agentId);
  }
  private async maintain() {
    if (this.closed || this.controller.signal.aborted) return;
    for (const { value: record } of this.store.entries<Binding>(collection)) {
      if (
        record.phase !== "ready" ||
        !record.ref ||
        this.jobs.has(record.agentId)
      )
        continue;
      const idle = this.options.profiles.find((p) => p.id === record.profileId)?.idlePauseSeconds;
      if (!this.activity.has(record.agentId)) this.activity.set(record.agentId, Date.now());
      if (idle && !this.sshActive.has(record.agentId) && Date.now() - this.activity.get(record.agentId)! >= idle * 1000) {
        this.launch(
          record,
          async () => {
            try {
              await this.lifecycle(this.service.agent(record.agentId).owner, record, "sleep");
            } catch (error) {
              // Active or unresolved runs count as activity; try again after another idle window.
              if (!(error instanceof WorkError && error.message === "agent_has_active_or_unknown_run")) throw error;
              this.activity.set(record.agentId, Date.now());
            }
          },
          "upkeep",
        );
        continue;
      }
      this.launch(
        record,
        async () => {
          const profile = this.profile(record),
            provider = await this.provider(record),
            id = record.ref!.id;
          let state: string;
          try {
            state = (await provider.info(id)).state;
            if (state === "running") {
              if (record.workspaceId && !this.verifiedWorkspaces.has(record.agentId)) await this.verifyWorkspace(record, provider);
              await provider.setTimeout(id, profile.lifetimeSeconds);
            }
          } catch (error) {
            const failures = (this.renewalFailures.get(record.agentId) ?? 0) + 1;
            this.renewalFailures.set(record.agentId, failures);
            if (failures < renewalAttempts) return;
            throw error;
          }
          this.renewalFailures.delete(record.agentId);
          if (state !== "running")
            throw new WorkError("environment_not_running_resume_required", 409);
        },
        "upkeep",
      );
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.leaseTimer);
    this.controller.abort();
    await Promise.allSettled(this.sshPreparing.values());
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise));
    this.store.releaseLease(this.lease);
    this.store.close();
  }
}
