// An in-memory stand-in for Agent Kit's host links, with the shape of its `HostLinks`: computers pair with a code,
// connect and disconnect when the test says so, and run the turns they are given by a script. The pinned Router has no
// host links, so `attach` also stands in for what Router does with them: it resolves a `link:` binding itself,
// without asking the product's Host provider, and sends such a Host text only.
import { RouterError, type HostBindingProvider, type HostPort, type HostRun, type HostStartInput } from "@agent-router/server";
import type { ExternalHosts, HostLink, HostLinkEvent } from "../../src/external-partners.js";

/** One turn as the computer's Host received it. */
export interface LinkTurn { agentId: string; runId: string; request: HostStartInput }
type Script = (turn: LinkTurn) => Promise<string> | string;
const PREFIX = "link:";

export function memoryHostLinks() {
  const links = new Map<string, HostLink & { owner: string }>(), codes = new Map<string, { owner: string; agentId: string; expiresAt: string }>();
  const listeners = new Set<(event: HostLinkEvent) => unknown>(), runs = new Map<string, HostRun & { requestKey?: string }>(), turns: LinkTurn[] = [];
  let script: Script = turn => `answer to ${turn.request.input}`, issued = 0;
  const view = ({ owner: _owner, ...link }: HostLink & { owner: string }): HostLink => ({ ...link });
  const emit = (type: HostLinkEvent["type"], link: HostLink & { owner: string }) => { for (const listener of listeners) listener({ type, owner: link.owner, link: view(link), binding: PREFIX + link.id }); };
  const of = (agentId: string) => [...links.values()].find(link => link.agentId === agentId);
  const connected = (agentId: string, binding: string) => {
    const link = links.get(binding.slice(PREFIX.length));
    if (link?.agentId !== agentId || !link.online) throw new RouterError("host_link_offline", 409);
  };
  const hosts: ExternalHosts & { remove(agentId: string): void } = {
    createCode(owner, agentId) {
      for (const [code, pairing] of codes) if (pairing.agentId === agentId) codes.delete(code);
      const code = `PAIR-${String(++issued).padStart(4, "0")}`, expiresAt = new Date(Date.now() + 600_000).toISOString();
      codes.set(code, { owner, agentId, expiresAt });
      return { code, expiresAt };
    },
    list: owner => [...links.values()].filter(link => link.owner === owner).map(view),
    get: agentId => { const link = of(agentId); return link && view(link); },
    online: agentId => of(agentId)?.online === true,
    revoke(owner, linkId) {
      const link = links.get(linkId);
      if (link?.owner !== owner) return;
      links.delete(linkId);
      emit("revoked", link);
    },
    remove(agentId) {
      for (const [id, link] of links) if (link.agentId === agentId) links.delete(id);
      for (const [code, pairing] of codes) if (pairing.agentId === agentId) codes.delete(code);
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  /** The Host of a paired computer. Like Agent Kit's, it takes text only and refuses a run that carries anything else. */
  const host = (agentId: string, binding: string): HostPort => {
    const found = (id: string) => { const run = runs.get(id); if (!run) throw new RouterError("run_not_found", 404); return run; };
    return {
      identity: binding, supportsRunLookup: true,
      async connect() {},
      async start(input) {
        connected(agentId, binding);
        if (input.instructions || input.tools?.length || input.toolOutput || input.inputItems?.length || input.attachments?.length) throw new RouterError("host_link_text_only", 403);
        const prior = [...runs.values()].find(run => input.requestKey && run.requestKey === input.requestKey);
        if (prior) return prior;
        const run: HostRun & { requestKey?: string } = { id: `link-run-${runs.size + 1}`, sessionId: input.sessionId, runtimeId: input.runtimeId, status: "running", answer: "",
          ...(input.requestKey ? { requestKey: input.requestKey } : {}) };
        runs.set(run.id, run);
        const turn = { agentId, runId: run.id, request: structuredClone(input) };
        turns.push(turn);
        void Promise.resolve().then(() => script(turn)).then(answer => { if (run.status === "running") Object.assign(run, { status: "completed", answer }); },
          () => { if (run.status === "running") Object.assign(run, { status: "failed", outcome: { status: "failed", error: "failed" } }); });
        return run;
      },
      async findRun(_runtimeId, requestKey) { return [...runs.values()].find(run => run.requestKey === requestKey) ?? null; },
      // A runtime that takes no native tool output: Router delivers a partner's message to it as text.
      async inspectRuntime(runtimeId) { return { id: runtimeId, available: true, capabilities: { features: { "input.nativeItems": { status: "unsupported" } } } }; },
      async get(id) { return found(id); },
      async cancel(id) { const run = found(id); if (run.status === "running") run.status = "cancelled"; },
      async calls() { return []; },
      async resolve() {},
    };
  };
  return { hosts, links, turns,
    /**
     * Stands in for a Router that has host links: a `link:` binding is answered here and never reaches the product's
     * provider, the Host gets neither Router's instructions nor its tools, and a deleted Agent's links go.
     */
    attach(provider: HostBindingProvider) {
      const own = { ...provider }, linked = (binding: string) => binding.startsWith(PREFIX);
      Object.assign(provider, {
        assertReady: (id, binding) => linked(binding) ? connected(id, binding) : own.assertReady(id, binding),
        wake: (id, binding) => { if (!linked(binding)) own.wake?.(id, binding); },
        host: (id, binding) => {
          if (!linked(binding)) return own.host(id, binding);
          const link = host(id, binding);
          return { ...link, start: ({ tools: _tools, ...input }) => link.start({ ...input, instructions: "" }) };
        },
      } satisfies Partial<HostBindingProvider>);
    },
    /** A computer uses a pairing code, as its Host would at the enroll path. It is connected from then on. */
    enroll(code: string, device: { name?: string; platform?: string; runtime?: { id: string; kernel: string } } = {}) {
      const pairing = codes.get(code);
      if (!pairing || Date.parse(pairing.expiresAt) <= Date.now()) throw new RouterError("pairing_code_invalid", 403);
      codes.delete(code);
      const link = { id: `l${links.size + 1}-${code.toLowerCase()}`, agentId: pairing.agentId, owner: pairing.owner, deviceName: device.name ?? "laptop", platform: device.platform ?? "darwin",
        runtime: device.runtime ?? { id: "local", kernel: "claude" }, online: true, createdAt: new Date().toISOString(), lastOnlineAt: new Date().toISOString() };
      links.set(link.id, link);
      emit("enrolled", link);
      return view(link);
    },
    /** The partner's computer connects or disconnects. */
    connect(agentId: string, online: boolean) {
      const link = of(agentId);
      if (!link) return;
      Object.assign(link, { online, lastOnlineAt: new Date().toISOString() });
      emit(online ? "online" : "offline", link);
    },
    /** What every following run does. Throwing fails the run. */
    respond(next: Script) { script = next; },
  };
}
export type MemoryHostLinks = ReturnType<typeof memoryHostLinks>;
