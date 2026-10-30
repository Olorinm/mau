import { expect, it } from "vitest";
import { DurableStore } from "../src/store.js";
import { SessionHistory } from "../src/session-history.js";

it("retrieves original Chinese/Latin history with owner isolation, literal queries and idempotent imports", () => {
  const store = new DurableStore(":memory:", "test");
  try {
    const history = new SessionHistory(store, (owner, agent) => { if (agent !== `${owner}-agent`) throw new Error("not_owned"); });
    history.append("alice", "alice-agent", "one", "run:user", "王总的邮件：明天下午三点开会，no sudo.");
    history.append("bob", "bob-agent", "one", "run:user", "王总的邮件 secret");
    expect(history.search("alice", "alice-agent", { query: "王总的邮件" }).data).toHaveLength(1);
    expect(history.search("alice", "alice-agent", { query: "王总" }).data).toHaveLength(1);
    expect(history.search("alice", "alice-agent", { query: "NO SUDO" }).data).toHaveLength(1);
    expect(history.search("alice", "alice-agent", { query: "%" }).data).toHaveLength(0);
    expect(() => history.search("bob", "alice-agent", { query: "邮件" })).toThrow("not_owned");
    const page = { source: "native", items: [{ id: "native1", items: [{ text: "完整历史原文内容" }] }], cursor: "next" };
    history.importPage("alice", "alice-agent", "two", page); history.importPage("alice", "alice-agent", "two", page);
    const hits = history.search("alice", "alice-agent", { query: "原文内容" });
    expect(hits.data).toHaveLength(1); expect(JSON.parse(String(hits.data[0]!.text))).toEqual(page.items[0]);
    history.append("alice", "alice-agent", "one", "run:user", "updated original");
    expect(history.search("alice", "alice-agent", { query: "王总" }).data).toHaveLength(0);
  } finally { store.close(); }
});
