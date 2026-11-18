import { expect, it } from "vitest";
import { DurableStore } from "../src/store.js";

const changes = (store: DurableStore) => Number(store.db.prepare("SELECT total_changes() AS n").get()!.n);

it("keeps a held lease without writing until its second half, and refuses another owner while it is valid", () => {
  const store = new DurableStore(":memory:", "test");
  const start = 1_000_000;
  store.acquireLease("a", start);
  const afterFirst = changes(store);
  // A coordinator that asks every second writes nothing for the first fourteen seconds.
  for (let second = 1; second < 15; second++) store.acquireLease("a", start + second * 1000);
  expect(changes(store)).toBe(afterFirst);
  store.acquireLease("a", start + 15_000);
  expect(changes(store)).toBe(afterFirst + 1);
  expect(store.get<{ expires: number }>("meta", "lease")!.expires).toBe(start + 45_000);

  expect(() => store.acquireLease("b", start + 44_999)).toThrow("environment_coordinator_already_running");
  store.acquireLease("b", start + 45_000);
  expect(store.get<{ owner: string }>("meta", "lease")!.owner).toBe("b");
  store.releaseLease("a");
  expect(store.get("meta", "lease")).toBeDefined();
  store.releaseLease("b");
  expect(store.get("meta", "lease")).toBeUndefined();
  store.close();
});
