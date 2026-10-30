import { expect, it } from "vitest";
import { ServiceHttp } from "@agent-router/server";
import { BusinessHost, type EmployeeTools } from "../src/business-tools.js";
import { DurableStore } from "../src/store.js";

it("freezes memory in native instructions across writes, restart, fork and scheduled continuation", async () => {
  const store = new DurableStore(":memory:", "memory-test");
  let current = "MEMORY: first", run = 0;
  const requests: any[] = [], completions: unknown[] = [];
  const employee: EmployeeTools = { definitions: [], context: admission => admission.kind === "schedule" ? undefined : { text: current }, execute: async () => ({}) };
  const http = new class extends ServiceHttp {
    override async request(path: string, options: any = {}) {
      if (path === "/v1/native-sessions") return {};
      if (path === "/v1/runs") { requests.push(options.body); return { id: `run-${++run}`, sessionId: options.body.sessionId, runtimeId: "native", status: "completed", answer: "done" }; }
      throw new Error("unexpected_request");
    }
  }("https://host.test", "token");
  const owner = { kind: "owner" as const, owner: "alice", agentId: "employee", reference: "input" };
  const make = () => new BusinessHost(http, undefined, store, "employee:binding", undefined, { owner: "alice", agentId: "employee" }, employee, turn => completions.push(turn));
  const input = { sessionId: "first", runtimeId: "native", instructions: "Stable role", input: "hi", admission: owner };
  try {
    let host = make(); await host.start(input);
    current = "MEMORY: updated"; host = make(); await host.start(input);
    expect(requests[1].instructions).toBe("Stable role\n\nMEMORY: first");
    await host.nativeSessions({ runtimeId: "native", action: "fork", sessionId: "first", targetSessionId: "child" });
    await host.start({ ...input, sessionId: "child", instructions: "" });
    expect(requests[2].instructions).toBe(requests[0].instructions);
    await host.start({ ...input, sessionId: "second" });
    expect(requests[3].instructions).toContain("updated");
    const schedule = { ...owner, kind: "schedule" as const, toolGrants: {} };
    await host.start({ ...input, instructions: "", admission: schedule });
    expect(requests[4].instructions).toBe(requests[0].instructions);
    await host.start({ ...input, sessionId: "scheduled", instructions: "", admission: schedule });
    expect(requests[5].instructions).toBe("");
    expect(completions).toHaveLength(6);
  } finally { store.close(); }
});

it("initializes the memory snapshot independently of a saved tool catalog", async () => {
  const store = new DurableStore(":memory:", "catalog-only"); let body: any, snapshots = 0, memory = "current memory";
  store.set("business_session_catalog", "agent:binding:session", []);
  const http = new class extends ServiceHttp { override async request(_path: string, options: any) { body = options.body; return { id: "run", sessionId: "session", runtimeId: "native", status: "running", answer: "" }; } }("https://host.test", "token");
  try {
    const host = new BusinessHost(http, undefined, store, "agent:binding", undefined, { owner: "alice", agentId: "agent" },
      { definitions: [], context: () => { snapshots++; return { text: memory }; }, execute: async () => ({}) });
    const input = { sessionId: "session", runtimeId: "native", instructions: "Stable role", input: "hi",
      admission: { kind: "owner" as const, owner: "alice", agentId: "agent", reference: "request" } };
    await host.start(input);
    expect(body.instructions).toBe("Stable role\n\ncurrent memory");
    expect(store.get("business_session_instructions", "agent:binding:session")).toBe(body.instructions);
    memory = "later memory";
    await host.start(input);
    expect(body.instructions).toBe("Stable role\n\ncurrent memory");
    expect(snapshots).toBe(1);
  } finally { store.close(); }
});
