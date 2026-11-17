import { afterEach, expect, it, vi } from "vitest";
import { DurableStore } from "../src/store.js";
import { Partners, type PartnerMessage, type PartnersPort } from "../src/partners.js";

// The records of messages between partners: how long they are kept, and how the owner's list reads them.
const stores: DurableStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); vi.restoreAllMocks(); });
const day = 24 * 3_600_000, ago = (days: number) => new Date(Date.now() - days * day).toISOString();
function fixture() {
  const store = new DurableStore(":memory:", "records"); stores.push(store);
  // Nothing here is open, so no delivery step asks the rest of the product for anything.
  return { store, partners: new Partners(store, {} as PartnersPort) };
}
const message = (id: string, fields: Partial<PartnerMessage> = {}): PartnerMessage => ({ id, owner: "alice", intent: "ask", status: "returned", createdAt: ago(1), text: `text of ${id}`,
  from: { agentId: "desk", name: "desk" }, to: { agentId: "trip", name: "trip" }, origin: { sessionId: "s", connectionId: "web", chain: 0, taskId: "t" },
  sender: { feishu: true, connections: [], write: true }, grants: { feishu: true, connections: [], write: true },
  result: { status: "completed", answer: "done", settledAt: ago(1), durationMs: 1000 }, delivery: { attempts: 1, nextAttemptAt: ago(1), via: "turn" }, ...fields });

it("removes messages and hand-overs 30 days after they were created, once they have ended, and nothing else", async () => {
  const { store, partners } = fixture();
  for (const status of ["returned", "collected", "seen", "dropped"] as const) {
    store.set("partner_messages", `pm-old-${status}`, message(`pm-old-${status}`, { status, createdAt: ago(31) }));
    store.set("partner_messages", `pm-new-${status}`, message(`pm-new-${status}`, { status, createdAt: ago(29) }));
  }
  // A record that has not ended is kept however old it is: the delivery rules end it, not its age.
  store.set("partner_messages", "pm-old-queued", message("pm-old-queued", { status: "queued", intent: "inform", createdAt: ago(40) }));
  store.set("partner_returns", "pr-old-completed", { id: "pr-old-completed", status: "completed", createdAt: ago(31), messageIds: [] });
  store.set("partner_returns", "pr-old-failed", { id: "pr-old-failed", status: "failed", createdAt: ago(45), messageIds: [] });
  store.set("partner_returns", "pr-new-completed", { id: "pr-new-completed", status: "completed", createdAt: ago(2), messageIds: [] });
  store.set("partner_recruits", "recruit", { owner: "alice", name: "trip", at: ago(400) });
  await partners.tick();
  expect(store.entries("partner_messages").map(entry => entry.id).sort()).toEqual(["pm-new-collected", "pm-new-dropped", "pm-new-returned", "pm-new-seen", "pm-old-queued"]);
  expect(store.entries("partner_returns").map(entry => entry.id)).toEqual(["pr-new-completed"]);
  expect(store.entries("partner_recruits")).toHaveLength(1);
  // The removal runs once an hour, not with every delivery cycle.
  const removed = vi.spyOn(store, "deleteBefore");
  await partners.tick(); await partners.tick();
  expect(removed).not.toHaveBeenCalled();
});

it("lists the newest messages of an owner, or of one partner, by asking the database for just those", () => {
  const { store, partners } = fixture();
  for (let index = 0; index < 120; index++) store.set("partner_messages", `pm-${index}`, message(`pm-${index}`,
    index % 3 === 0 ? { to: { agentId: "hotels", name: "hotels" } } : index % 3 === 1 ? { from: { agentId: "hotels", name: "hotels" }, to: { agentId: "desk", name: "desk" } } : {}));
  store.set("partner_messages", "pm-bob", message("pm-bob", { owner: "bob" }));
  const whole = vi.spyOn(store, "entries");
  expect(partners.messages("alice").map(item => item.id)).toEqual(Array.from({ length: 50 }, (_, index) => `pm-${119 - index}`));
  expect(partners.messages("alice", { limit: 3 })).toMatchObject([{ id: "pm-119", from: { id: "desk", name: "desk" }, to: { id: "trip", name: "trip" }, text: "text of pm-119", status: "returned" },
    { id: "pm-118" }, { id: "pm-117" }]);
  // One partner: the messages it sent and the ones it received.
  expect(partners.messages("alice", { agentId: "hotels", limit: 4 }).map(item => item.id)).toEqual(["pm-118", "pm-117", "pm-115", "pm-114"]);
  expect(partners.messages("alice", { agentId: "nobody" })).toEqual([]);
  expect(partners.messages("bob").map(item => item.id)).toEqual(["pm-bob"]);
  expect(whole).not.toHaveBeenCalled();
  // Member names never come from a request; one that is not a plain path is refused all the same.
  expect(() => store.newest("partner_messages", [{ members: ["owner') OR 1=1 --"], value: "alice" }], 10)).toThrow("invalid_document_member");
});
