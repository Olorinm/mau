// An in-memory stand-in for the platform's host links: computers pair with a code, connect and disconnect when the
// test says so, and run the turns they are given by a script.
import { RouterError, type HostPort, type HostRun, type HostStartInput } from "@agent-router/server";
import type { ExternalHosts, HostLink, HostLinkEvent } from "../../src/external-partners.js";

/** One turn as the computer's Host received it. */
export interface ExternalTurn { agentId: string; runId: string; request: HostStartInput }
type Script = (turn: ExternalTurn) => Promise<string> | string;

export function memoryExternalHosts() {
  const links = new Map<string, HostLink & { owner: string }>(), codes = new Map<string, { owner: string; agentId: string; expiresAt: string }>();
  const listeners = new Set<(event: HostLinkEvent) => void>(), runs = new Map<string, HostRun & { requestKey?: string }>(), turns: ExternalTurn[] = [];
  let script: Script = turn => `answer to ${turn.request.input}`, issued = 0;
  const emit = (event: HostLinkEvent) => { for (const listener of listeners) listener(event); };
  const view = ({ owner: _owner, ...link }: HostLink & { owner: string }): HostLink => ({ ...link });
  const connected = (agentId: string, binding: string) => {
    const link = links.get(binding);
    if (link?.agentId !== agentId || !link.online) throw new RouterError("external_partner_offline", 409);
  };
  const hosts: ExternalHosts = {
    async pair(owner, agentId) {
      for (const [code, pairing] of codes) if (pairing.agentId === agentId) codes.delete(code);
      const code = `PAIR-${String(++issued).padStart(4, "0")}`, expiresAt = new Date(Date.now() + 600_000).toISOString();
      codes.set(code, { owner, agentId, expiresAt });
      return { code, expiresAt };
    },
    list: owner => [...links.values()].filter(link => link.owner === owner).map(view),
    async revoke(owner, linkId) {
      const link = links.get(linkId);
      if (link?.owner !== owner) return;
      links.delete(linkId);
      emit({ type: "revoked", agentId: link.agentId, linkId });
    },
    async forget(agentId) {
      for (const [id, link] of links) if (link.agentId === agentId) links.delete(id);
      for (const [code, pairing] of codes) if (pairing.agentId === agentId) codes.delete(code);
    },
    online: agentId => [...links.values()].some(link => link.agentId === agentId && link.online),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    assertReady: connected,
    host(agentId, binding): HostPort {
      const found = (id: string) => { const run = runs.get(id); if (!run) throw new RouterError("run_not_found", 404); return run; };
      return {
        identity: `link:${binding}`, supportsRunLookup: true,
        async connect() {},
        async start(input) {
          connected(agentId, binding);
          const prior = [...runs.values()].find(run => input.requestKey && run.requestKey === input.requestKey);
          if (prior) return prior;
          const run: HostRun & { requestKey?: string } = { id: `external-run-${runs.size + 1}`, sessionId: input.sessionId, runtimeId: input.runtimeId, status: "running", answer: "",
            ...(input.requestKey ? { requestKey: input.requestKey } : {}) };
          runs.set(run.id, run);
          const turn = { agentId, runId: run.id, request: structuredClone(input) };
          turns.push(turn);
          void Promise.resolve().then(() => script(turn)).then(answer => { if (run.status === "running") Object.assign(run, { status: "completed", answer }); },
            () => { if (run.status === "running") Object.assign(run, { status: "failed", outcome: { status: "failed", error: "failed" } }); });
          return run;
        },
        async findRun(_runtimeId, requestKey) { return [...runs.values()].find(run => run.requestKey === requestKey) ?? null; },
        async inspectRuntime(runtimeId) { return { id: runtimeId, cwd: "/home/owner", available: true }; },
        async get(id) { return found(id); },
        async cancel(id) { const run = found(id); if (run.status === "running") run.status = "cancelled"; },
        async calls() { return []; },
        async resolve() {},
        // What a Host can also do, and Mau must not pass on.
        async readFile() { return { content: "private", encoding: "utf8" }; },
        async writeFile() {},
        async nativeRequest() { return {}; },
        async nativeSessions() { return {}; },
        async discoverRuntime() { return {}; },
      };
    },
  };
  return { hosts, links, turns,
    /** A computer uses a pairing code, as its Host would at the enroll path. It is connected from then on. */
    enroll(code: string, device: { name?: string; platform?: string; runtime?: { id: string; kernel: string } } = {}) {
      const pairing = codes.get(code);
      if (!pairing || Date.parse(pairing.expiresAt) <= Date.now()) throw new RouterError("pairing_code_invalid", 403);
      codes.delete(code);
      const link = { id: `link-${links.size + 1}-${code.toLowerCase()}`, agentId: pairing.agentId, owner: pairing.owner, name: device.name ?? "laptop", platform: device.platform ?? "darwin",
        runtime: device.runtime ?? { id: "local", kernel: "claude" }, online: true, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
      links.set(link.id, link);
      emit({ type: "enrolled", link: view(link) });
      return view(link);
    },
    /** The partner's computer connects or disconnects. */
    connect(agentId: string, online: boolean) {
      for (const link of links.values()) if (link.agentId === agentId) Object.assign(link, { online, lastSeenAt: new Date().toISOString() });
    },
    /** What every following run does. Throwing fails the run. */
    respond(next: Script) { script = next; },
  };
}
export type MemoryExternalHosts = ReturnType<typeof memoryExternalHosts>;
