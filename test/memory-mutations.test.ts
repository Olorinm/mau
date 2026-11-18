import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PartnerContext } from "../src/partner-context.js";
import { DurableStore } from "../src/store.js";
import { mauFixture } from "./fixtures/mau.js";

// Every change of a partner's memory is recorded with where it came from, and the owner can take one back.
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = "alice", agentId = "11111111-1111-4111-8111-111111111111";
function fixture(options: { writeApproval?: boolean } = {}) {
  const store = new DurableStore(":memory:", "memory"); cleanup.push(() => store.close());
  const directory = mkdtempSync(join(tmpdir(), "mau-memory-mutations-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const memory = new PartnerContext(store, (o, a) => { if (o !== owner || a !== agentId) throw new Error("not_owned"); }, { directory, ...options });
  return { store, memory, entries: () => memory.read(owner, agentId).entries };
}
const trip = { kind: "message" as const, partners: [{ id: "p-1", name: "trip" }] };

it("records each change with its origin and takes one back: an addition, a replacement, a removal and a batch", () => {
  const f = fixture();
  f.memory.mutate(owner, agentId, { action: "batch", operations: [{ action: "add", content: "First" }, { action: "add", content: "Second" }, { action: "add", content: "Third" }] });
  f.memory.mutate(owner, agentId, { action: "add", content: "Planted" }, { origin: "delegation", source: trip });
  f.memory.mutate(owner, agentId, { action: "replace", old_text: "Second", content: "Second, rewritten" }, { origin: "delegation", source: { kind: "result", partners: trip.partners } });
  f.memory.mutate(owner, agentId, { action: "remove", old_text: "First" }, { origin: "delegation" });
  const [removal, replacement, addition, own] = f.memory.mutations(owner, agentId);
  expect(removal).toMatchObject({ seq: 4, origin: "delegation", changes: [{ action: "remove", text: "First", index: 0 }], unseen: true });
  expect(removal).not.toHaveProperty("source");
  expect(replacement).toMatchObject({ seq: 3, source: { kind: "result" }, changes: [{ action: "replace", before: "Second", after: "Second, rewritten" }], unseen: true });
  expect(addition).toMatchObject({ seq: 2, origin: "delegation", source: trip, changes: [{ action: "add", text: "Planted" }], unseen: true, at: expect.any(String) });
  expect(own).toMatchObject({ seq: 1, origin: "owner", unseen: false }); expect(own!.changes).toHaveLength(3);
  // Seen up to a change: later ones stay unseen, and the mark never goes back or past the newest change.
  expect(f.memory.markSeen(owner, agentId, 3)).toEqual({ seen: 3 });
  expect(f.memory.mutations(owner, agentId).map(mutation => mutation.unseen)).toEqual([true, false, false, false]);
  expect(f.memory.markSeen(owner, agentId, 1)).toEqual({ seen: 3 }); expect(f.memory.markSeen(owner, agentId, 99)).toEqual({ seen: 4 });

  expect(f.entries()).toEqual(["Second, rewritten", "Third", "Planted"]);
  expect(f.memory.undo(owner, agentId, removal!.id)).toMatchObject({ done: true, undone: removal!.id });
  expect(f.entries()).toEqual(["First", "Second, rewritten", "Third", "Planted"]);
  f.memory.undo(owner, agentId, replacement!.id); expect(f.entries()).toEqual(["First", "Second", "Third", "Planted"]);
  f.memory.undo(owner, agentId, addition!.id); expect(f.entries()).toEqual(["First", "Second", "Third"]);
  // An undo is the owner's change, names what it took back, and marks that change.
  const after = f.memory.mutations(owner, agentId);
  expect(after[0]).toMatchObject({ seq: 7, origin: "owner", undoOf: addition!.id, changes: [{ action: "remove", text: "Planted", index: 3 }], unseen: false });
  expect(after.find(mutation => mutation.id === addition!.id)!.undoneAt).toEqual(expect.any(String));
  expect(() => f.memory.undo(owner, agentId, addition!.id)).toThrow("memory_mutation_already_undone");
  // A batch is taken back whole, in reverse.
  f.memory.mutate(owner, agentId, { action: "batch", operations: [{ action: "remove", old_text: "Second" }, { action: "replace", old_text: "Third", content: "Third, rewritten" }, { action: "add", content: "Fourth" }] }, { origin: "delegation", source: trip });
  expect(f.entries()).toEqual(["First", "Third, rewritten", "Fourth"]);
  f.memory.undo(owner, agentId, f.memory.mutations(owner, agentId)[0]!.id); expect(f.entries()).toEqual(["First", "Second", "Third"]);
});

it("refuses an undo when the memory changed in that place, and leaves the memory as it is", () => {
  const f = fixture(), last = () => f.memory.mutations(owner, agentId)[0]!;
  f.memory.mutate(owner, agentId, { action: "add", content: "Kept" });
  f.memory.mutate(owner, agentId, { action: "add", content: "Planted" }, { origin: "delegation", source: trip });
  const addition = last();
  f.memory.mutate(owner, agentId, { action: "replace", old_text: "Planted", content: "Planted, then edited" });
  expect(() => f.memory.undo(owner, agentId, addition.id)).toThrow("memory_undo_conflict");
  // The replacement's old text is back already; the removed entry is back already.
  f.memory.mutate(owner, agentId, { action: "replace", old_text: "Kept", content: "Changed" }, { origin: "delegation" });
  const replacement = last();
  f.memory.mutate(owner, agentId, { action: "add", content: "Kept" });
  expect(() => f.memory.undo(owner, agentId, replacement.id)).toThrow("memory_undo_conflict");
  f.memory.mutate(owner, agentId, { action: "remove", old_text: "Changed" }, { origin: "delegation" });
  const removal = last();
  f.memory.mutate(owner, agentId, { action: "add", content: "Changed" });
  expect(() => f.memory.undo(owner, agentId, removal.id)).toThrow("memory_undo_conflict");
  expect(f.entries()).toEqual(["Planted, then edited", "Kept", "Changed"]);
  expect(f.memory.mutations(owner, agentId).some(mutation => mutation.undoOf || mutation.undoneAt)).toBe(false);
  expect(() => f.memory.undo(owner, agentId, "unknown")).toThrow("memory_mutation_not_found");
  expect(() => f.memory.undo("bob", agentId, removal.id)).toThrow("not_owned");
});

it("keeps the last hundred changes of a partner, and lists a staged write when the owner approves it", () => {
  const f = fixture();
  for (let n = 0; n < 52; n++) { f.memory.mutate(owner, agentId, { action: "add", content: `Note ${n}` }, { origin: "delegation" }); f.memory.mutate(owner, agentId, { action: "remove", old_text: `Note ${n}` }, { origin: "delegation" }); }
  const kept = f.memory.mutations(owner, agentId);
  expect(kept).toHaveLength(100); expect(kept[0]!.seq).toBe(104); expect(kept.at(-1)!.seq).toBe(5);
  expect(f.store.entries("memory_mutations")).toHaveLength(100);
  const staged = fixture({ writeApproval: true });
  const { pending_id } = staged.memory.mutate(owner, agentId, { action: "add", content: "Proposed" }, { origin: "delegation", source: trip }) as { pending_id: string };
  expect(staged.memory.mutations(owner, agentId)).toEqual([]);
  staged.memory.approve(owner, agentId, pending_id);
  expect(staged.memory.mutations(owner, agentId)).toMatchObject([{ origin: "owner", changes: [{ action: "add", text: "Proposed" }], unseen: false }]);
});

it("serves a partner's memory changes to its owner only: list, seen and undo", async () => {
  const f = await mauFixture(cleanup, {}, { nativeWork: { partnerTools: true } });
  const base = `/agents/${f.agent.id}/memory`;
  f.mau.facts.mutate(f.agent.owner, f.agent.id, { action: "add", content: "From a partner" }, { origin: "delegation", source: trip });
  expect((await f.api(base, { action: "add", content: "From the owner" })).status).toBe(200);
  const listed = (await f.api(`${base}/mutations`)).data.data;
  expect(listed).toMatchObject([{ origin: "owner", unseen: false }, { origin: "delegation", source: trip, changes: [{ action: "add", text: "From a partner" }], unseen: true }]);
  const id = listed[1].id as string;
  // Another owner, or no owner, reaches nothing; another partner's id names nothing.
  for (const path of [`${base}/mutations`, `${base}/mutations/seen`, `${base}/mutations/${id}/undo`]) {
    const body = path.endsWith("/mutations") ? undefined : path.endsWith("/seen") ? { through: 2 } : {};
    expect((await f.api(path, body, "bob")).status).toBe(404); expect((await f.api(path, body, "invalid")).status).toBe(401);
  }
  expect((await f.api(`/agents/22222222-2222-4222-8222-222222222222/memory/mutations/${id}/undo`, {})).status).toBe(404);
  expect((await f.api(`${base}/mutations/seen`, {})).status).toBe(400);
  expect((await f.api(`${base}/mutations/seen`, { through: listed[0].seq })).data).toEqual({ seen: 2 });
  expect((await f.api(`${base}/mutations`)).data.data.map((mutation: any) => mutation.unseen)).toEqual([false, false]);
  expect((await f.api(`${base}/mutations/${id}/undo`, {})).data).toMatchObject({ done: true, undone: id });
  expect((await f.api(base)).data.entries).toEqual(["From the owner"]);
  expect(await f.api(`${base}/mutations/${id}/undo`, {})).toMatchObject({ status: 409, data: { error: "memory_mutation_already_undone" } });
  // A conflict is said as one.
  f.mau.facts.mutate(f.agent.owner, f.agent.id, { action: "add", content: "Second" }, { origin: "delegation" });
  const second = (await f.api(`${base}/mutations`)).data.data[0].id;
  await f.api(base, { action: "replace", old_text: "Second", content: "Second, edited" });
  expect(await f.api(`${base}/mutations/${second}/undo`, {})).toMatchObject({ status: 409, data: { error: "memory_undo_conflict" } });
  expect((await f.api(`${base}/mutations/unknown/undo`, {})).status).toBe(404);
});
