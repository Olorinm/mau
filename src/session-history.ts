import { createHash } from "node:crypto";
import { z } from "zod";
import { DurableStore } from "./store.js";

export const historyQuery = z.object({ query: z.string().trim().min(1).max(1000), sessionId: z.string().max(160).optional(),
  limit: z.number().int().min(1).max(50).default(10), offset: z.number().int().min(0).max(10000).default(0) }).strict();

/** Original text, separate from curated memory. SQLite does retrieval, never a model summary. */
export class SessionHistory {
  constructor(private readonly store: DurableStore, private readonly assertOwned: (owner: string, agent: string) => void) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_history (
      id TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, agent TEXT NOT NULL, session TEXT NOT NULL,
      source TEXT NOT NULL, text TEXT NOT NULL, created TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_history_fts USING fts5(text, content='memory_history', content_rowid='rowid', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS memory_history_insert AFTER INSERT ON memory_history BEGIN
        INSERT INTO memory_history_fts(rowid,text) VALUES(new.rowid,new.text); END;
      CREATE TRIGGER IF NOT EXISTS memory_history_update AFTER UPDATE ON memory_history BEGIN
        INSERT INTO memory_history_fts(memory_history_fts,rowid,text) VALUES('delete',old.rowid,old.text);
        INSERT INTO memory_history_fts(rowid,text) VALUES(new.rowid,new.text); END;
      CREATE INDEX IF NOT EXISTS memory_history_scope ON memory_history(owner,agent,session);`);
  }
  append(owner: string, agent: string, session: string, source: string, text: string) {
    this.assertOwned(owner, agent);
    if (!text || Buffer.byteLength(text) > 2_000_000) return;
    const id = createHash("sha256").update(JSON.stringify([owner, agent, session, source])).digest("hex");
    this.store.db.prepare(`INSERT INTO memory_history(id,owner,agent,session,source,text,created) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET text=excluded.text`).run(id, owner, agent, session, source, text, new Date().toISOString());
  }
  importPage(owner: string, agent: string, session: string, page: unknown) {
    this.assertOwned(owner, agent);
    const parsed = z.object({ source: z.literal("native"), items: z.array(z.unknown()).max(1000), cursor: z.string().nullable().optional() }).passthrough().parse(page);
    this.store.transaction(() => {
      for (const entry of parsed.items) {
        const raw = JSON.stringify(entry), id = typeof entry === "object" && entry && "id" in entry && typeof entry.id === "string"
          ? entry.id : createHash("sha256").update(raw).digest("hex");
        this.append(owner, agent, session, `native:${id}`, raw);
      }
    });
    return { imported: parsed.items.length, nextCursor: parsed.cursor ?? null };
  }
  search(owner: string, agent: string, input: unknown) {
    this.assertOwned(owner, agent);
    const query = historyQuery.parse(input), long = Array.from(query.query).length >= 3;
    const pattern = long ? `"${query.query.replaceAll('"', '""')}"` : `%${query.query.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = this.store.db.prepare(`SELECT h.session AS sessionId,h.source,h.text,h.created AS createdAt
      FROM memory_history h ${long ? "JOIN memory_history_fts f ON f.rowid=h.rowid" : ""}
      WHERE h.owner=? AND h.agent=? ${query.sessionId ? "AND h.session=?" : ""}
      AND ${long ? "memory_history_fts MATCH ?" : "h.text LIKE ? ESCAPE '\\'"}
      ORDER BY h.rowid DESC LIMIT ? OFFSET ?`).all(owner, agent, ...(query.sessionId ? [query.sessionId] : []), pattern, query.limit + 1, query.offset);
    const data = rows.slice(0, query.limit).map(row => {
      const raw = String(row.text), found = raw.toLowerCase().indexOf(query.query.toLowerCase());
      const start = raw.length <= 4000 ? 0 : Math.max(0, found - 1000);
      return { ...row, text: raw.slice(start, start + 4000), textOffset: start, truncated: raw.length > 4000 };
    });
    return { data, nextOffset: rows.length > query.limit ? query.offset + query.limit : null,
      coverage: "completed_turns_observed_by_mau_and_explicitly_imported_native_history", format: "original_text" };
  }
}
