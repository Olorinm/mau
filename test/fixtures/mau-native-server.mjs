// Deterministic native protocol scenarios for the independent Mau package consumer.
// Unhandled methods still go through Host's supplied upstream protocol fixture.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
const child = spawn(process.execPath, [process.env.MAU_TEST_BASE_FIXTURE], { stdio: ["pipe", "pipe", "inherit"] });
// The base fixture's small counter restarts with its process; real native IDs
// do not. Prefix generated IDs so the restart/create scenario cannot collide.
const prefix = randomUUID();
const uniqueIds = value => Array.isArray(value) ? value.map(uniqueIds) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ["id", "threadId", "turnId", "parentThreadId"].includes(key) && typeof item === "string" && /^(thread|fork|turn)-\d+$/.test(item) ? `${prefix}:${item}` : uniqueIds(item)])) : value;
createInterface({ input: child.stdout }).on("line", line => process.stdout.write(JSON.stringify(uniqueIds(JSON.parse(line))) + "\n"));
child.on("exit", code => process.exit(code ?? 0));
process.on("SIGTERM", () => child.kill());
let nextId = 0;
const pending = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (id, result) => send({ id, result });
const ask = (threadId, turnId, tool, args) => new Promise(resolve => {
  const id = `mau-request-${++nextId}`; pending.set(id, resolve);
  send({ id, method: "item/tool/call", params: { threadId, turnId, callId: id, tool, arguments: args } });
});
const complete = (threadId, turnId, text) => {
  send({ method: "item/completed", params: { threadId, turnId, item: { id: `mau-answer-${nextId}`, type: "agentMessage", phase: "final_answer", text } } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
};
createInterface({ input: process.stdin }).on("line", async line => {
  const message = JSON.parse(line), params = message.params ?? {};
  if (pending.has(message.id)) { pending.get(message.id)(message.result); pending.delete(message.id); return; }
  const special = ["skills/list", "skills/config/write", "memory/status", "thread/memoryMode/set"].includes(message.method);
  const orchestration = message.method === "turn/start" && params.input?.some(item => item.text?.includes("employee-orchestrate"));
  const delivery = message.method === "turn/start" && params.toolOutput?.namespace === "mau";
  if (!special && !orchestration && !delivery) { child.stdin.write(line + "\n"); return; }
  if (process.env.CODEX_TEST_LOG) appendFileSync(process.env.CODEX_TEST_LOG, line + "\n");
  if (message.method === "skills/list") return reply(message.id, { data: [{ skills: [{ name: "fixture-skill", path: "/trusted/fixture/SKILL.md", enabled: true }] }] });
  if (message.method === "skills/config/write") return reply(message.id, { effectiveEnabled: params.enabled });
  if (message.method === "memory/status") return reply(message.id, { state: "disabled", fixture: true });
  if (message.method === "thread/memoryMode/set") return reply(message.id, {});
  const turnId = `mau-turn-${++nextId}`, threadId = params.threadId;
  reply(message.id, { turn: { id: turnId } });
  if (orchestration) {
    const created = await ask(threadId, turnId, "work_sessions", { action: "create", input: "child fixture work" });
    const event = JSON.parse(created.contentItems[0].text);
    if (!event.eventId) return complete(threadId, turnId, JSON.stringify({ error: "child_not_created", created }));
    let after, observed;
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await ask(threadId, turnId, "work_sessions", { action: "wait", eventIds: [event.eventId], timeoutMs: 5000, ...(after ? { after } : {}) });
      observed = JSON.parse(response.contentItems[0].text); after = observed.cursor;
      if (observed.data?.[0]?.status === "completed") break;
    }
    return complete(threadId, turnId, JSON.stringify({ event, observed }));
  }
  const input = JSON.parse(params.toolOutput.output);
  if (params.toolOutput.name === "proactive_work") return complete(threadId, turnId, JSON.stringify({
    decision: "notify", reason: "fixture-check-completed", summary: "Scheduled fixture report", findings: [], sources: [], approvalProposals: [],
  }));
  complete(threadId, turnId, `Delegated fixture: ${input.message}`);
});
