import { RouterError, type HostLinkEvent, type HostLinks } from "@agent-router/server";
import type { DurableStore } from "./store.js";

/** The command the owner runs on the computer whose agent becomes a partner. */
export const pairCommand = (service: string, code: string) => `agent-host link --config host.json --url ${service} --code ${code}`;

/** What Mau records of a partner that is an agent on a computer: whose it is, and its duty. The rest is the link's. */
interface ExternalPartner { agentId: string; owner: string; ownership: "owner"; duty?: string; createdAt: string }
export interface ExternalPartnersPort {
  /** The address of the service, as the computer reaches it. */
  serviceUrl: string;
  /** The Host binding Router has for the Agent. */
  binding(owner: string, agentId: string): { binding?: string | undefined; runtimeId: string } | undefined;
  /** Give Router the Agent's Host binding, or take it away. Either starts fresh execution sessions. */
  bind(owner: string, agentId: string, host: { binding: string; runtimeId: string } | undefined): Promise<void>;
}

const PARTNERS = "external_partners";
const report = (error: unknown) => console.warn(JSON.stringify({ event: "external_partner_link_failed",
  message: error instanceof Error ? error.message : String(error) }));

/**
 * Partners that are agents on the owner's own computers. Mau sends such a partner messages, takes its replies and
 * passes its approvals to the owner; its kernel, model, permissions, memory and skills are its own. A partner has at
 * most one paired computer (a new pairing replaces it), and Router has a Host binding for it only while it is paired: Mau writes the binding
 * when a computer enrolls and removes it when the link ends. Router resolves that binding itself, so no turn of
 * such a partner passes through Mau's Host (`BusinessHost`): it gets no tools, memory or skills of Mau's. A deleted
 * partner's record goes with its other product records (`forgetPartnerRecords`).
 */
export class ExternalPartners {
  private readonly unsubscribe: () => void;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly store: DurableStore, private readonly hosts: HostLinks, private readonly port: ExternalPartnersPort) {
    this.unsubscribe = hosts.subscribe(event => { void this.after(() => this.changed(event)).catch(report); });
  }
  /** Changes of Host bindings happen one after the other, each on what the one before left. */
  private after(step: () => Promise<void>) {
    const done = this.queue.then(step);
    this.queue = done.catch(() => undefined);
    return done;
  }
  close() { this.unsubscribe(); }
  private record(agentId: string) { return this.store.get<ExternalPartner>(PARTNERS, agentId); }
  has(agentId: string) { return this.record(agentId) !== undefined; }
  isOwned(owner: string, agentId: string) { return this.record(agentId)?.owner === owner; }
  /** The owner's partner of this kind, or a refusal. */
  private owned(owner: string, agentId: string) {
    const record = this.record(agentId);
    if (record?.owner !== owner) throw new RouterError("partner_not_external", 409);
    return record;
  }
  duty(agentId: string) { return this.record(agentId)?.duty; }
  private link(agentId: string) { return this.has(agentId) ? this.hosts.get(agentId) : undefined; }
  kernel(agentId: string) { return this.link(agentId)?.runtime.kernel; }

  /** For now only the owner's own agent can be created. */
  creatable(ownership: "owner" | "other") {
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
  /** A pairing code and the command that uses it. The computer that pairs replaces the one paired before. */
  pair(owner: string, agentId: string) {
    const record = this.owned(owner, agentId), { code, expiresAt } = this.hosts.createCode(owner, record.agentId);
    return { code, expiresAt, command: pairCommand(this.port.serviceUrl, code) };
  }
  /** End the partner's pairing: its computer is disconnected and Router no longer has a Host for it. */
  async unpair(owner: string, agentId: string) {
    if (!this.isOwned(owner, agentId)) return;
    for (const link of this.hosts.list(owner)) if (link.agentId === agentId) this.hosts.revoke(owner, link.id);
    // After what the ended links themselves set off; a binding whose link was already gone ends here.
    await this.after(async () => { if (this.port.binding(owner, agentId)) await this.port.bind(owner, agentId, undefined); });
  }
  private async changed({ type, owner, link, binding }: HostLinkEvent) {
    if (!this.isOwned(owner, link.agentId) || type === "online" || type === "offline") return;
    const bound = this.port.binding(owner, link.agentId);
    if (type === "revoked") { if (bound?.binding === binding) await this.port.bind(owner, link.agentId, undefined); return; }
    if (bound?.binding !== binding || bound.runtimeId !== link.runtime.id) await this.port.bind(owner, link.agentId, { binding, runtimeId: link.runtime.id });
  }

  /** What the owner is shown of the partner: whose it is, whether its computer is connected, and that computer. */
  view(owner: string, agentId: string) {
    const record = this.owned(owner, agentId), link = this.link(agentId);
    return { ownership: record.ownership, connection: !link ? "pairing" as const : link.online ? "online" as const : "offline" as const,
      device: link ? { id: link.id, name: link.deviceName, platform: link.platform, kernel: link.runtime.kernel, online: link.online,
        pairedAt: link.createdAt, lastOnlineAt: link.lastOnlineAt } : null };
  }
  /** The owner's partners of this kind, oldest first. */
  list(owner: string) {
    return this.store.entries<ExternalPartner>(PARTNERS).map(entry => entry.value).filter(record => record.owner === owner)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(record => ({ agentId: record.agentId, ...this.view(owner, record.agentId) }));
  }
  /**
   * Whether the partner can be found, as partners working together see it. A message can be left for a paired
   * computer that is off: Router keeps it until the computer is back. `undefined`: not a partner of this kind.
   */
  presence(agentId: string) {
    if (!this.has(agentId)) return undefined;
    const link = this.link(agentId);
    return { state: !link ? "unpaired" : link.online ? "ready" : "offline", reachable: link !== undefined, external: true };
  }
}
