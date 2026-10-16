import { expect, it } from "vitest";
import { RunReader, type RunDetail, type runApi } from "../web/src/api/runs.js";

it("resumes after the last committed event following a disconnect without duplicated text", async () => {
  let fail = true;
  const cursors: number[] = [];
  const detail = { run: { id: "run", status: "running" }, calls: [] } as unknown as RunDetail;
  const api = {
    run: async () => detail,
    events: async (_claim: string, after: number) => {
      cursors.push(after);
      if (after === 1 && fail) { fail = false; throw new Error("disconnected"); }
      return after === 0 ? { events: [{ sequence: 1, event: { type: "assistant.delta", runId: "run", text: "first" } }], cursor: 1, hasMore: true, historyTruncated: false }
        : { events: [{ sequence: 2, event: { type: "assistant.delta", runId: "run", text: " second" } }], cursor: 2, hasMore: false, historyTruncated: false };
    },
  } as unknown as ReturnType<typeof runApi>;
  const reader = new RunReader(api, "claim");
  const first = await reader.refresh();
  expect(first.view.text).toBe("first"); expect(first.more).toBe(true);
  expect(cursors).toEqual([0]);
  await expect(reader.refresh()).rejects.toThrow("disconnected");
  const result = await reader.refresh();
  expect(result.view.text).toBe("first second"); expect(cursors).toEqual([0, 1, 1]);
});
it("marks retained-history gaps and refuses cross-run events", async () => {
  const detail = { run: { id: "run", status: "completed", answer: "complete answer" }, calls: [] } as unknown as RunDetail;
  const api = { run: async () => detail, events: async () => ({ events: [{ sequence: 20, event: { type: "assistant.delta", runId: "run", text: "tail" } }], cursor: 20, hasMore: false, historyTruncated: true }) } as unknown as ReturnType<typeof runApi>;
  const result = await new RunReader(api, "claim").refresh(); expect(result.truncated).toBe(true); expect(result.detail.run.answer).toBe("complete answer");
  api.events = async () => ({ events: [{ sequence: 21, event: { type: "assistant.delta", runId: "other", text: "private" } }], cursor: 21, hasMore: false, historyTruncated: false });
  await expect(new RunReader(api, "claim").refresh()).rejects.toMatchObject({ code: "invalid_response" });
});

it("starts event reads alongside metadata and drains completion events after a terminal status race", async () => {
  let finishDetail!: (detail: RunDetail) => void;
  const pendingDetail = new Promise<RunDetail>((resolve) => { finishDetail = resolve; });
  const cursors: number[] = [];
  let details = 0;
  const api = {
    run: () => { details++; return pendingDetail; },
    events: async (_claim: string, after: number) => {
      cursors.push(after);
      return { events: [{ sequence: after + 1, event: { type: "assistant.delta", runId: "run", text: after ? " final" : "first" } }], cursor: after + 1, hasMore: false, historyTruncated: false };
    },
  } as unknown as ReturnType<typeof runApi>;
  const reader = new RunReader(api, "claim"), pending = reader.refresh();
  expect(cursors).toEqual([0]);
  finishDetail({ run: { id: "run", status: "completed" }, calls: [] } as unknown as RunDetail);
  const first = await pending;
  expect(first.view.text).toBe("first"); expect(first.more).toBe(true);
  const final = await reader.refresh();
  expect(final.view.text).toBe("first final"); expect(final.more).toBe(false);
  expect(details).toBe(1); expect(cursors).toEqual([0, 1]);
});
