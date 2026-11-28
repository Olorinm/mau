import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StoreLease } from "@agent-router/server";

/** Durable identity-scoped state. Network calls never run inside a transaction. */
export class DurableStore {
  readonly db: DatabaseSync;
  readonly lease: StoreLease;
  constructor(path: string, identity: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents(collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(collection,id));
      CREATE INDEX IF NOT EXISTS document_status ON documents(collection,json_extract(value,'$.status'));`);
    if (path !== ":memory:") chmodSync(path, 0o600);
    const previous = this.get<string>("meta", "identity");
    if (previous && previous !== identity) { this.db.close(); throw new Error("store_identity_mismatch"); }
    if (!previous) this.set("meta", "identity", identity);
    this.lease = new StoreLease(this.db, path, "environment_coordinator_already_running");
  }
  get<T>(collection: string, id: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM documents WHERE collection=? AND id=?").get(collection, id);
    return row ? JSON.parse(row.value as string) as T : undefined;
  }
  set(collection: string, id: string, value: unknown): void {
    this.db.prepare("INSERT INTO documents VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value")
      .run(collection, id, JSON.stringify(value));
  }
  insert(collection: string, id: string, value: unknown): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO documents VALUES(?,?,?)").run(collection, id, JSON.stringify(value)).changes === 1;
  }
  delete(collection: string, id: string): void {
    this.db.prepare("DELETE FROM documents WHERE collection=? AND id=?").run(collection, id);
  }
  entries<T>(collection: string): Array<{ id: string; value: T }> {
    return this.db.prepare("SELECT id,value FROM documents WHERE collection=? ORDER BY rowid").all(collection)
      .map((row) => ({ id: row.id as string, value: JSON.parse(row.value as string) as T }));
  }
  entriesByStatus<T>(collection: string, statuses: string[]): Array<{ id: string; value: T }> {
    if (!statuses.length) return [];
    return this.db.prepare(`SELECT id,value FROM documents WHERE collection=? AND json_extract(value,'$.status') IN (${statuses.map(() => "?").join(",")}) ORDER BY rowid`)
      .all(collection, ...statuses).map(row => ({ id: row.id as string, value: JSON.parse(row.value as string) as T }));
  }
  /**
   * The newest documents of a collection whose members equal the given values (`{ owner: "..." }`; a list of names
   * means any of them does), newest first. The database filters and stops at `limit`; nothing else is parsed.
   */
  newest<T>(collection: string, where: Array<{ members: string[]; value: string }>, limit: number,
    /** `before`: only documents older than the one with this id. `by`: order by this member's value instead of by age, greatest first. `offset`: skip this many. */
    page: { before?: string | undefined; by?: string | undefined; offset?: number | undefined } = {}): Array<{ id: string; value: T }> {
    const member = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/;
    if (where.some(item => !item.members.length || item.members.some(name => !member.test(name))) || page.by !== undefined && !member.test(page.by)) throw new Error("invalid_document_member");
    const clauses = where.map(item => `(${item.members.map(name => `json_extract(value,'$.${name}')=?`).join(" OR ")})`);
    if (page.before !== undefined) clauses.push("rowid < COALESCE((SELECT rowid FROM documents WHERE collection=? AND id=?), 0)");
    return this.db.prepare(`SELECT id,value FROM documents WHERE collection=?${clauses.map(clause => ` AND ${clause}`).join("")}
      ORDER BY ${page.by ? `json_extract(value,'$.${page.by}') DESC, ` : ""}rowid DESC LIMIT ? OFFSET ?`)
      .all(collection, ...where.flatMap(item => item.members.map(() => item.value)), ...(page.before !== undefined ? [collection, page.before] : []), limit, page.offset ?? 0)
      .map(row => ({ id: row.id as string, value: JSON.parse(row.value as string) as T }));
  }
  /** Delete the documents of a collection in one of the statuses whose `createdAt` is before a time. Returns how many. */
  deleteBefore(collection: string, statuses: string[], createdBefore: string): number {
    if (!statuses.length) return 0;
    return Number(this.db.prepare(`DELETE FROM documents WHERE collection=? AND json_extract(value,'$.status') IN (${statuses.map(() => "?").join(",")})
      AND json_extract(value,'$.createdAt')<?`).run(collection, ...statuses, createdBefore).changes);
  }
  /** All of `work` or none of it. Work that is already inside a transaction joins it. */
  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /**
   * Take or keep the 30-second coordination lease. A lease this owner already holds is written again only in its
   * second half, so a coordinator may ask every second without writing every second.
   */
  acquireLease(owner: string, now = Date.now()): void {
    this.transaction(() => this.lease.acquire(owner, now));
  }
  releaseLease(owner: string): void { this.lease.release(owner); }
  close(): void { this.db.close(); }
}
