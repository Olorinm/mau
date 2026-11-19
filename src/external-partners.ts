import { RouterError, ServiceHttp, type HostPort, type HostRun, type HostStartInput } from "@agent-router/server";
import type { DurableStore } from "./store.js";
import { validAdmission, type AdmissionValidator, type RunAdmission } from "./run-admission.js";
import { pairCommand } from "./host-links.js";
import { EXTERNAL_SOURCE } from "./partner-text.js";

/** One computer paired with a partner, as the platform's host links describe it. */
export interface HostLink {
  id: string; agentId: string;
  /** The computer's name and operating system, as its Host reported them when it enrolled. */
  name: string; platform: string;
  /** The runtime on that computer the partner is: its id at the Host and the kernel it runs. */
  runtime: { id: string; kernel: string };
  online: boolean; createdAt: string; lastSeenAt: string | null;
}
/** `enrolled`: a computer finished pairing. `revoked`: a link ended, whoever ended it. */
export type HostLinkEvent = { type: "enrolled"; link: HostLink } | { type: "revoked"; agentId: string; linkId: string };
/**
 * The platform's host links, as far as Mau uses them: computers that pair with a code and then connect to the service
 * themselves. Everything Mau does with an agent on the owner's computer goes through this port.
 */
export interface ExternalHosts {
  /** A new pairing code for the Agent; an earlier unused one stops working. */
  pair(owner: string, agentId: string): Promise<{ code: string; expiresAt: string }>;
  /** The owner's paired computers. */
  list(owner: string): HostLink[];
  /** End one link: its computer is disconnected and can no longer connect. */
  revoke(owner: string, linkId: string): Promise<void>;
  /** A deleted Agent: its links and unused codes go. */
  forget(agentId: string): Promise<void>;
  online(agentId: string): boolean;
  /** Called for every link that finishes pairing or ends, until the returned function is called. */
  subscribe(listener: (event: HostLinkEvent) => void): () => void;
  /** Router's Host binding of a link (`binding` is the link's id): refuses while its computer is not connected. */
  assertReady(agentId: string, binding: string): void;
  wake?(agentId: string, binding: string): void;
  host(agentId: string, binding: string): HostPort;
}

/** What Mau records of a partner that is an agent on a computer: whose it is, and its duty. The rest is the link's. */
interface ExternalPartner { agentId: string; owner: string; ownership: "owner"; duty?: string; createdAt: string }
/** Where the partner is found, and the turns Mau starts at it. */
export interface ExternalPartnersPort {
  /** The address of the service, as the computer reaches it. */
  serviceUrl: string;
  /** The Host binding Router has for the Agent. */
  binding(owner: string, agentId: string): { binding?: string | undefined; runtimeId: string } | undefined;
  /** Give Router the Agent's Host binding, or take it away. Either starts fresh execution sessions. */
  bind(owner: string, agentId: string, host: { binding: string; runtimeId: string } | undefined): Promise<void>;
  /** Whether a turn's admission still stands. */
  admits: AdmissionValidator;
  /** The partner whose message a turn handles. */
  sender(admission: RunAdmission): string | undefined;
  /** The notes other partners left for the Agent, for the turn that carries them. */
  notes(admission: RunAdmission): Promise<string | undefined>;
  /** A run seen at the computer, running or ended. */
  observe(agentId: string, run: { id: string; status: string }): void;
  /** A turn completed: the notes it carried were read. */
  completed(admission: RunAdmission): void;
}

const PARTNERS = "external_partners", REQUESTS = "external_run_requests", RUNS = "external_runs";
const unavailable = () => new RouterError("external_partners_unavailable", 503);
const report = (error: unknown) => console.warn(JSON.stringify({ event: "external_partner_link_failed",
  message: error instanceof Error ? error.message : String(error) }));

/**
 * Partners that are agents on the owner's own computers. Mau sends such a partner messages, takes its replies and
 * passes its approvals to the owner; its kernel, model, permissions, memory and skills are its own. A partner has at
 * most one paired computer, and Router has a Host binding for it only while it is paired.
 */
export class ExternalPartners {
  private readonly unsubscribe: (() => void) | undefined;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly store: DurableStore, private readonly hosts: ExternalHosts | undefined, private readonly port: ExternalPartnersPort) {
    this.unsubscribe = hosts?.subscribe(event => { void this.after(() => this.changed(event)).catch(report); });
  }
  /** Changes of Host bindings happen one after the other, each on what the one before left. */
  private after(step: () => Promise<void>) {
    const done = this.queue.then(step);
    this.queue = done.catch(() => undefined);
    return done;
  }
  close() { this.unsubscribe?.(); }
  /** Whether this service can pair computers at all. */
  get available() { return this.hosts !== undefined; }
  private links() { if (!this.hosts) throw unavailable(); return this.hosts; }
  private record(agentId: string) { return this.store.get<ExternalPartner>(PARTNERS, agentId); }
  has(agentId: string) { return this.record(agentId) !== undefined; }
  /** The owner's partner of this kind, or a refusal. */
  private owned(owner: string, agentId: string) {
    const record = this.record(agentId);
    if (record?.owner !== owner) throw new RouterError("partner_not_external", 409);
    return record;
  }
  isOwned(owner: string, agentId: string) { return this.record(agentId)?.owner === owner; }
  duty(agentId: string) { return this.record(agentId)?.duty; }
  private link(record: ExternalPartner) { return this.hosts?.list(record.owner).find(link => link.agentId === record.agentId); }
  kernel(agentId: string) { const record = this.record(agentId); return record && this.link(record)?.runtime.kernel; }

  /** Refuses what cannot be created: any such partner without host links, and for now an agent that is not the owner's own. */
  creatable(ownership: "owner" | "other") {
    this.links();
    if (ownership !== "owner") throw new RouterError("external_ownership_not_supported", 400);
    return ownership;
  }
  /** Make an Agent that has nothing yet (`fresh`) a partner of this kind. Repeating the request with the same duty changes nothing. */
  register(owner: string, agentId: string, ownership: "owner", duty: string | undefined, fresh: boolean) {
    const existing = this.record(agentId);
    if (existing ? existing.owner !== owner : !fresh) throw new RouterError("partner_not_external", 409);
    if (existing) { if (duty !== undefined && duty !== existing.duty) throw new RouterError("agent_duty_immutable", 409); return; }
    this.store.set(PARTNERS, agentId, { agentId, owner, ownership, ...(duty !== undefined ? { duty } : {}), createdAt: new Date().toISOString() } satisfies ExternalPartner);
  }
  /** A pairing code and the command that uses it. Pairing a computer replaces the one paired before. */
  async pair(owner: string, agentId: string) {
    const record = this.owned(owner, agentId), { code, expiresAt } = await this.links().pair(owner, record.agentId);
    return { code, expiresAt, command: pairCommand(this.port.serviceUrl, code) };
  }
  /** End the partner's pairing: its computer is disconnected and Router no longer has a Host for it. */
  async unpair(owner: string, agentId: string) {
    const record = this.record(agentId);
    if (record?.owner !== owner || !this.hosts) return;
    for (const link of this.hosts.list(owner)) if (link.agentId === agentId) await this.hosts.revoke(owner, link.id);
    // After what the ended links themselves set off; a binding whose link was already gone ends here.
    await this.after(async () => { if (this.port.binding(owner, agentId)) await this.port.bind(owner, agentId, undefined); });
  }
  /** A deleted partner: its links and its record go. */
  async forget(agentId: string) {
    if (!this.has(agentId)) return;
    await this.hosts?.forget(agentId);
    this.store.delete(PARTNERS, agentId);
  }
  private async changed(event: HostLinkEvent) {
    const agentId = event.type === "enrolled" ? event.link.agentId : event.agentId, record = this.record(agentId);
    if (!record) return;
    const bound = this.port.binding(record.owner, agentId);
    if (event.type === "revoked") { if (bound?.binding === event.linkId) await this.port.bind(record.owner, agentId, undefined); return; }
    const { id, runtime } = event.link;
    if (bound?.binding !== id || bound.runtimeId !== runtime.id) await this.port.bind(record.owner, agentId, { binding: id, runtimeId: runtime.id });
    // One computer per partner: the one paired before is disconnected.
    for (const link of this.links().list(record.owner)) if (link.agentId === agentId && link.id !== id) await this.links().revoke(record.owner, link.id);
  }

  /** What the owner is shown of the partner: whose it is, whether its computer is connected, and that computer. */
  view(owner: string, agentId: string) {
    const record = this.owned(owner, agentId), link = this.link(record);
    return { ownership: record.ownership, connection: !link ? "pairing" as const : link.online ? "online" as const : "offline" as const,
      device: link ? { id: link.id, name: link.name, platform: link.platform, kernel: link.runtime.kernel, online: link.online,
        pairedAt: link.createdAt, lastSeenAt: link.lastSeenAt } : null };
  }
  /** The owner's partners of this kind, oldest first. */
  list(owner: string) {
    return this.store.entries<ExternalPartner>(PARTNERS).map(entry => entry.value).filter(record => record.owner === owner)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(record => ({ agentId: record.agentId, ...this.view(owner, record.agentId) }));
  }
  /**
   * Whether the partner can be found, as partners working together see it. A message can be left for a paired
   * computer that is off: it is handled when the computer is back. `undefined`: not a partner of this kind.
   */
  presence(agentId: string) {
    const record = this.record(agentId);
    if (!record) return undefined;
    const link = this.link(record);
    return { state: !link ? "unpaired" : link.online ? "ready" : "offline", reachable: link !== undefined, external: true };
  }

  // ---- Router's Host binding of a paired computer ----

  assertReady(agentId: string, binding: string) { this.links().assertReady(agentId, binding); }
  wake(agentId: string, binding: string) { this.hosts?.wake?.(agentId, binding); }
  /**
   * The partner's Host as Router uses it. A turn reaches the computer with its input and one sentence saying who it is
   * from, and with the notes partners left: no instructions, tools, settings or context of Mau or Router. Of the
   * Host's other abilities only what a turn needs is passed on: reading files, native sessions and native requests
   * of the computer are not.
   */
  host(agentId: string, binding: string): HostPort {
    const record = this.record(agentId);
    if (!record) throw new RouterError("partner_not_external", 409);
    const inner = this.links().host(agentId, binding), { store, port } = this, scope = `${agentId}:${binding}`;
    const seen = (run: HostRun) => {
      port.observe(agentId, run);
      const key = `${scope}:${run.id}`, started = store.get<{ admission?: RunAdmission; completed?: true }>(RUNS, key);
      if (run.status !== "completed" || run.outcome?.outcomeUnknown || !started?.admission || started.completed) return run;
      port.completed(started.admission);
      store.set(RUNS, key, { ...started, completed: true });
      return run;
    };
    const started = (run: HostRun, admission: RunAdmission | undefined) => {
      store.insert(RUNS, `${scope}:${run.id}`, admission ? { admission } : {});
      return seen(run);
    };
    return {
      identity: inner.identity ?? `external:${binding}`,
      ...(inner.supportsRunLookup === undefined ? {} : { supportsRunLookup: inner.supportsRunLookup }),
      connect: () => inner.connect(),
      async start(input: HostStartInput) {
        const admission = input.admission === undefined ? undefined : validAdmission(input.admission, agentId, record.owner, port.admits);
        // Nothing is scheduled at a partner of this kind, and a turn whose admission does not stand is not started.
        if (input.admission && (!admission || admission.kind === "schedule")) throw new RouterError("business_run_admission_invalid", 403);
        const requestId = input.requestKey ? `${scope}:${input.runtimeId}:${input.requestKey}` : undefined;
        // What a turn is told is read once, with its first request; a retry sends what was saved.
        let request = requestId ? store.get<HostStartInput>(REQUESTS, requestId) : undefined;
        if (!request) {
          const sender = admission && port.sender(admission), notes = admission && await port.notes(admission);
          request = { sessionId: input.sessionId, runtimeId: input.runtimeId, instructions: "", input: delivered(input),
            ...(input.requestKey ? { requestKey: input.requestKey } : {}), ...(input.attachments?.length ? { attachments: input.attachments } : {}),
            ...(input.mode ? { mode: input.mode } : {}),
            context: { source: sender ? EXTERNAL_SOURCE.partner(sender) : admission?.kind === "owner" ? EXTERNAL_SOURCE.owner : EXTERNAL_SOURCE.channel,
              ...(notes ? { partnerNotes: notes } : {}) } };
          if (requestId && !store.insert(REQUESTS, requestId, request)) request = store.get<HostStartInput>(REQUESTS, requestId)!;
        }
        return started(await inner.start(request), admission);
      },
      ...(inner.findRun ? { async findRun(runtimeId: string, requestKey: string) { const run = await inner.findRun!(runtimeId, requestKey); return run && seen(run); } } : {}),
      ...(inner.inspectRuntime ? { inspectRuntime: (runtimeId: string) => inner.inspectRuntime!(runtimeId) } : {}),
      get: async id => seen(await inner.get(id)),
      cancel: id => inner.cancel(id),
      calls: id => inner.calls(id),
      resolve: (id, callId, result) => inner.resolve(id, callId, result),
      ...(inner.events ? { events: (id: string, after: number, limit?: number) => inner.events!(id, after, limit) } : {}),
      ...(inner.steer ? { steer: (id: string, text: string) => inner.steer!(id, text) } : {}),
    };
  }
  /** What Router's check of the partner's Host asks: whether the computer is connected and still has the runtime. */
  http(agentId: string, binding: string): ServiceHttp {
    const partners = this;
    return new (class extends ServiceHttp {
      override async request(path: string) {
        const record = partners.record(agentId), link = record && partners.link(record);
        if (link?.id !== binding || !link.online) throw new RouterError("external_partner_offline", 409);
        if (path === "/v1/health") return { protocolVersion: 1 };
        if (path === "/v1/runtimes") return { runtimes: [{ id: link.runtime.id }] };
        throw new RouterError("not_available_for_external_partner", 409);
      }
    })(`https://${agentId}.mau.invalid`, "");
  }
}

/**
 * The text of a turn. Router hands delegated input to a runtime as the output of a product tool; a partner of this
 * kind has no product tools, so it is given the message itself.
 */
function delivered(input: HostStartInput): string {
  if (!input.toolOutput) return input.input;
  let output: unknown = input.toolOutput.output;
  if (typeof output === "string") { try { output = JSON.parse(output); } catch { /* Refused below. */ } }
  const message = output && typeof output === "object" ? (output as { message?: unknown }).message : undefined;
  if (typeof message !== "string") throw new RouterError("external_partner_delivery_unsupported", 422);
  return message;
}
