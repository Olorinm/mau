// The owner's computer, for tests of partners that are agents on one: it exchanges a pairing code at Router's enroll
// path, opens Router's host link socket with the credential it got, and answers the Host requests Router sends
// through it. Its runs follow a script, so a turn ends when the test says so.
import { HOST_LINK_ENROLL_PATH, HOST_LINK_SOCKET_PATH } from "@agent-router/server";

/** One turn as the computer's Host received it: the body of its `POST /v1/runs`. */
export interface LinkTurn { runId: string; body: any }
type Script = (turn: LinkTurn) => Promise<string> | string;
interface Run { id: string; sessionId: string; runtimeId: string; status: string; answer: string; requestKey?: string; outcome?: unknown }

/** Enroll a computer with a pairing code. It is connected when this returns. */
export async function linkComputer(base: string, code: string, cleanup: Array<() => unknown>,
  device: { name?: string; platform?: string; runtime?: { id: string; kernel: string } } = {}) {
  const runtime = device.runtime ?? { id: "local", kernel: "claude" };
  const response = await fetch(base + HOST_LINK_ENROLL_PATH, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, deviceName: device.name ?? "laptop", platform: device.platform ?? "darwin", runtime }) });
  if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? `enroll_${response.status}`);
  const { linkId, credential } = await response.json() as { linkId: string; credential: string };
  const runs = new Map<string, Run>(), turns: LinkTurn[] = [], refused: string[] = [];
  let script: Script = turn => `answer to ${turn.body.input}`, socket: WebSocket | undefined;
  const answer = (method: string, path: string, body: any): { status: number; body: unknown } => {
    const url = new URL(path, "http://host.local"), [, , area, id, action] = url.pathname.split("/");
    if (path === "/v1/health") return { status: 200, body: { ok: true, protocolVersion: 1, capabilities: { runIdempotency: true } } };
    if (path === "/v1/runtimes") return { status: 200, body: { runtimes: [{ id: runtime.id }] } };
    // Like Agent Kit's Host on a link: runs only, and a run of text only.
    if (area !== "runs") { refused.push(`${method} ${url.pathname}`); return { status: 403, body: { error: "link_route_not_allowed" } }; }
    const view = ({ requestKey: _key, ...run }: Run) => run;
    if (method === "POST" && !id) {
      const field = ["instructions", "tools", "toolOutput", "inputItems", "attachments"].find(name => Array.isArray(body[name]) ? body[name].length : body[name]);
      if (field) { refused.push(`run with ${field}`); return { status: 403, body: { error: `link_field_not_allowed:${field}` } }; }
      let run = [...runs.values()].find(item => body.requestKey && item.requestKey === body.requestKey);
      if (!run) {
        const started: Run = run = { id: `run-${runs.size + 1}`, sessionId: body.sessionId, runtimeId: body.runtimeId, status: "running", answer: "", ...(body.requestKey ? { requestKey: body.requestKey } : {}) };
        runs.set(started.id, started);
        const turn = { runId: started.id, body };
        turns.push(turn);
        void Promise.resolve().then(() => script(turn)).then(text => { if (started.status === "running") Object.assign(started, { status: "completed", answer: text }); },
          () => { if (started.status === "running") Object.assign(started, { status: "failed", outcome: { status: "failed", error: "failed" } }); });
      }
      return { status: 202, body: view(run) };
    }
    if (id === "by-request") { const run = [...runs.values()].find(item => item.requestKey === url.searchParams.get("requestKey")); return { status: 200, body: { run: run ? view(run) : null } }; }
    const run = runs.get(id!);
    if (!run) return { status: 404, body: { error: "run_not_found" } };
    if (!action) return { status: 200, body: view(run) };
    if (action === "events") return { status: 200, body: { events: [], cursor: Number(url.searchParams.get("after")), hasMore: false, historyTruncated: false, liveGap: false } };
    if (action === "calls") return { status: 200, body: { calls: [] } };
    if (action === "cancel") { if (run.status === "running") run.status = "cancelled"; return { status: 200, body: { cancellationRequested: true } }; }
    return { status: 404, body: { error: "route_not_found" } };
  };
  /** Open the socket as the computer's Host does; resolves with whether Router greeted it. */
  const connect = () => new Promise<boolean>(resolve => {
    // Node's WebSocket takes request headers beside the protocols.
    const ws = new WebSocket(base.replace(/^http/, "ws") + HOST_LINK_SOCKET_PATH, { headers: { authorization: `Bearer ${credential}` } } as unknown as string[]);
    socket = ws;
    ws.addEventListener("error", () => resolve(false));
    ws.addEventListener("close", () => resolve(false));
    ws.addEventListener("message", event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "hello") return resolve(true);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "response", id: frame.id, ...answer(frame.method, frame.path, frame.body) }));
    });
  });
  cleanup.push(() => socket?.close());
  if (!await connect()) throw new Error("host_link_not_connected");
  return { linkId, turns,
    /** What Router asked of the computer that its Host refuses. */
    refused,
    /** The computer goes offline. */
    disconnect() { socket?.close(); },
    /** The computer comes back; false when its credential is refused. */
    connect,
    /** What every following run does. Throwing fails the run. */
    respond(next: Script) { script = next; } };
}
export type LinkedComputer = Awaited<ReturnType<typeof linkComputer>>;
