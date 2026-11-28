import { createHash } from "node:crypto";
import { z } from "zod";
import { DurableStore } from "./store.js";

export const historyQuery = z.object({ query: z.string().trim().min(1).max(1000), sessionId: z.string().max(160).optional(),
  limit: z.number().int().min(1).max(50).default(10), offset: z.number().int().min(0).max(10000).default(0) }).strict();

/** What the `session_search` tool takes: a text to find, or a session to read. */
export const sessionQuery = z.object({
  query: z.string().trim().min(1).max(1000).optional().describe("The text to find. Empty: read the session sessionId names."),
  sessionId: z.string().max(160).optional().describe("A session id, as action=sessions of the partners tool lists them. With query: look only there. Without: the session to read."),
  show: z.enum(["sessions", "text"]).optional().describe("With query. sessions: which sessions say it, and how often. text: each place, with what is said there. Empty: sessions, or text when sessionId is given."),
  fromTurn: z.number().int().min(1).optional().describe("Reading: the first turn to return. Empty: the last ones."),
  toTurn: z.number().int().min(1).optional().describe("Reading: the last turn to return. Empty: the session's last turn, or as many as one call returns after fromTurn."),
  view: z.enum(["lines", "full"]).optional().describe("Reading. lines: how each turn's request and answer begin, up to 50 turns. full: their text, up to 10 turns. Empty: full."),
  part: z.enum(["asked", "answered"]).optional().describe("Reading one turn (fromTurn = toTurn) on from textOffset: which of its two texts."),
  textOffset: z.number().int().min(0).optional().describe("Reading one turn: where to go on in a text that was cut."),
  limit: z.number().int().min(1).max(50).optional().describe("With query: how many to return. Empty: 10."),
  offset: z.number().int().min(0).max(10_000).optional().describe("With query: how many to skip."),
}).strict().refine(input => input.query !== undefined || input.sessionId !== undefined, { message: "query or sessionId is required" });
export type SessionQuery = z.infer<typeof sessionQuery>;

/** Turns one read returns, and how much of each text. */
const READ_TURNS = 3, FULL_TURNS = 10, LINE_TURNS = 50, TEXT_CHARACTERS = 2000, LINE_CHARACTERS = 100, EXCERPT_CHARACTERS = 600;
/** Who the input of a turn is from, and what it says: the owner's words, or what a delivery carried. */
function said(role: string, text: string): { by: string; text: string } {
  if (role !== "tool") return { by: "owner", text };
  let value: unknown = text;
  // A delivery is one JSON object; a kernel that takes it as a tool output has it inside that output.
  for (let depth = 0; depth < 2 && typeof value === "string"; depth++) {
    try { const parsed = JSON.parse(value) as unknown; value = parsed && typeof parsed === "object" && typeof (parsed as { output?: unknown }).output === "string" ? (parsed as { output: string }).output : parsed; }
    catch { return { by: "delivered", text }; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { by: "delivered", text };
  const { from, message, results, ...rest } = value as { from?: unknown; message?: unknown; results?: unknown } & Record<string, unknown>;
  const partner = from && typeof from === "object" && typeof (from as { partner?: unknown }).partner === "string" ? (from as { partner: string }).partner : undefined;
  if (typeof message === "string") return { by: partner ?? (typeof from === "string" ? from : "delivered"), text: message };
  if (Array.isArray(results)) return { by: "partners' results", text: JSON.stringify({ results, ...rest }) };
  return { by: partner ?? "delivered", text };
}
/** A piece of a text from `start`, never cut inside a character, and how many characters follow it. */
function piece(text: string, start: number, length: number): { text: string; more: number } {
  let from = Math.min(Math.max(0, start), text.length), to = Math.min(text.length, from + length);
  const low = (index: number) => { const unit = text.charCodeAt(index); return unit >= 0xdc00 && unit <= 0xdfff; };
  if (from > 0 && from < text.length && low(from)) from++;
  if (to < text.length && low(to)) to--;
  return { text: text.slice(from, to), more: text.length - to };
}
const firstLine = (text: string) => piece(text.replace(/\s+/g, " ").trim(), 0, LINE_CHARACTERS);

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
  /** Remove a deleted Agent's original text, keeping the external-content index in step. */
  forget(owner: string, agent: string) {
    this.store.transaction(() => {
      const rows = this.store.db.prepare("SELECT rowid, text FROM memory_history WHERE owner=? AND agent=?").all(owner, agent) as Array<{ rowid: number; text: string }>;
      const unindex = this.store.db.prepare("INSERT INTO memory_history_fts(memory_history_fts,rowid,text) VALUES('delete',?,?)");
      for (const row of rows) unindex.run(row.rowid, row.text);
      this.store.db.prepare("DELETE FROM memory_history WHERE owner=? AND agent=?").run(owner, agent);
    });
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
  /**
   * The turns of a session that Mau saw complete, in the order they ended: each is a request and the answer to it, and
   * its number never changes. Imported native history is not part of them.
   */
  private turns(owner: string, agent: string, session: string) {
    const rows = this.store.db.prepare(`SELECT rowid,source,created FROM memory_history WHERE owner=? AND agent=? AND session=? AND source NOT LIKE 'native:%'
      ORDER BY rowid`).all(owner, agent, session) as Array<{ rowid: number; source: string; created: string }>;
    const turns: Array<{ turn: number; run: string; at: string; role: string; asked?: number; answered?: number }> = [], byRun = new Map<string, (typeof turns)[number]>();
    for (const row of rows) {
      const cut = row.source.lastIndexOf(":"), run = row.source.slice(0, cut), role = row.source.slice(cut + 1);
      let turn = byRun.get(run);
      if (!turn) { turn = { turn: turns.length + 1, run, at: row.created, role: "user" }; turns.push(turn); byRun.set(run, turn); }
      if (role === "assistant") turn.answered = row.rowid; else { turn.asked = row.rowid; turn.role = role; }
    }
    return { turns, byRow: new Map(turns.flatMap(turn => [[turn.asked, turn], [turn.answered, turn]] as const).filter((entry): entry is [number, (typeof turns)[number]] => entry[0] !== undefined)) };
  }
  private text(rowid: number | undefined) {
    return rowid === undefined ? undefined : (this.store.db.prepare("SELECT text FROM memory_history WHERE rowid=?").get(rowid) as { text: string } | undefined)?.text;
  }
  /** How a session began: who its first request is from, how that request begins, and when its first turn ended. */
  opening(owner: string, agent: string, session: string): { by: string; first: string; at: string; turns: number } | undefined {
    this.assertOwned(owner, agent);
    const { turns } = this.turns(owner, agent, session), first = turns[0];
    if (!first) return undefined;
    const asked = said(first.role, this.text(first.asked) ?? "");
    return { by: asked.by, first: firstLine(asked.text).text, at: first.at, turns: turns.length };
  }
  /**
   * Read a session by its turns. `lines`: how each request and answer begin. `full`: their text, a turn's two texts
   * each up to a limit; a text that was cut says how to read on. Without a range, the last turns.
   */
  read(owner: string, agent: string, input: SessionQuery & { sessionId: string }) {
    this.assertOwned(owner, agent);
    const { turns } = this.turns(owner, agent, input.sessionId), total = turns.length, lines = input.view === "lines", most = lines ? LINE_TURNS : FULL_TURNS;
    // A turn the session does not have is not answered with another one: `of` says how many there are.
    if (!total || (input.fromTurn ?? 1) > total || (input.toTurn ?? total) < (input.fromTurn ?? 1)) return { turns: [], showing: { of: total } };
    const last = Math.min(total, input.toTurn ?? (input.fromTurn === undefined ? total : input.fromTurn + most - 1));
    const first = Math.max(1, Math.min(last, input.fromTurn ?? last - (lines ? LINE_TURNS : READ_TURNS) + 1), last - most + 1);
    const single = first === last && input.textOffset !== undefined;
    const shown = turns.slice(first - 1, last).map(turn => {
      const asked = said(turn.role, this.text(turn.asked) ?? ""), answered = this.text(turn.answered) ?? "";
      if (lines) return { turn: turn.turn, at: turn.at, by: asked.by, asked: firstLine(asked.text).text, answered: firstLine(answered).text };
      const part = (name: "asked" | "answered", text: string) => {
        if (single && input.part !== undefined && input.part !== name) return undefined;
        const start = single && (input.part ?? "answered") === name ? input.textOffset! : 0, taken = piece(text, start, TEXT_CHARACTERS);
        return taken.more ? `${taken.text}\n[cut: ${taken.more} more characters; fromTurn=${turn.turn} toTurn=${turn.turn} part=${name} textOffset=${start + taken.text.length} reads on]` : taken.text;
      };
      const texts = { asked: part("asked", asked.text), answered: part("answered", answered) };
      return { turn: turn.turn, at: turn.at, by: asked.by, ...(texts.asked !== undefined ? { asked: texts.asked } : {}), ...(texts.answered !== undefined ? { answered: texts.answered } : {}) };
    });
    return { showing: { fromTurn: first, toTurn: last, of: total }, turns: shown };
  }
  /** Which sessions say a text, and how often: the session that said it last first. */
  mentions(owner: string, agent: string, input: SessionQuery & { query: string }) {
    this.assertOwned(owner, agent);
    const long = Array.from(input.query).length >= 3, limit = input.limit ?? 10, offset = input.offset ?? 0;
    const pattern = long ? `"${input.query.replaceAll('"', '""')}"` : `%${input.query.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = this.store.db.prepare(`SELECT h.session AS id, COUNT(*) AS places, MAX(h.created) AS lastAt
      FROM memory_history h ${long ? "JOIN memory_history_fts f ON f.rowid=h.rowid" : ""}
      WHERE h.owner=? AND h.agent=? AND ${long ? "memory_history_fts MATCH ?" : "h.text LIKE ? ESCAPE '\\'"}
      GROUP BY h.session ORDER BY MAX(h.rowid) DESC LIMIT ? OFFSET ?`).all(owner, agent, pattern, limit + 1, offset) as Array<{ id: string; places: number; lastAt: string }>;
    return { sessions: rows.slice(0, limit), ...(rows.length > limit ? { nextOffset: offset + limit } : {}) };
  }
  /** Each place a text is said, the latest first: the session, the turn and which of its two texts, and what is said around it. */
  places(owner: string, agent: string, input: SessionQuery & { query: string }) {
    this.assertOwned(owner, agent);
    const found = this.matches(owner, agent, { query: input.query, ...(input.sessionId ? { sessionId: input.sessionId } : {}), limit: input.limit ?? 10, offset: input.offset ?? 0 });
    const indexes = new Map<string, ReturnType<SessionHistory["turns"]>>(), needle = input.query.toLowerCase();
    const places = found.rows.map(row => {
      const index = indexes.get(row.sessionId) ?? indexes.set(row.sessionId, this.turns(owner, agent, row.sessionId)).get(row.sessionId)!, turn = index.byRow.get(row.rowid);
      // What a delivery carried is shown as it is read, when the text is found there; otherwise the stored text.
      const answer = row.source.endsWith(":assistant"), spoken = turn && !answer ? said(turn.role, row.text) : undefined;
      const text = spoken && spoken.text.toLowerCase().includes(needle) ? spoken.text : row.text, at = text.toLowerCase().indexOf(needle);
      const taken = piece(text, Math.max(0, at - EXCERPT_CHARACTERS / 3), EXCERPT_CHARACTERS);
      return { session: row.sessionId, ...(turn ? { turn: turn.turn, part: answer ? "answered" : "asked", by: answer ? "you" : spoken?.by ?? "owner" } : { part: "imported native history" }), at: row.createdAt,
        text: taken.text, ...(taken.more || taken.text.length < text.length ? { textOffset: Math.max(0, text.indexOf(taken.text)), of: text.length } : {}) };
    });
    return { places, ...(found.nextOffset !== null ? { nextOffset: found.nextOffset } : {}) };
  }
  /** The stored texts that say a text, the latest first. */
  private matches(owner: string, agent: string, query: z.infer<typeof historyQuery>) {
    const long = Array.from(query.query).length >= 3;
    const pattern = long ? `"${query.query.replaceAll('"', '""')}"` : `%${query.query.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = this.store.db.prepare(`SELECT h.rowid AS rowid,h.session AS sessionId,h.source,h.text,h.created AS createdAt
      FROM memory_history h ${long ? "JOIN memory_history_fts f ON f.rowid=h.rowid" : ""}
      WHERE h.owner=? AND h.agent=? ${query.sessionId ? "AND h.session=?" : ""}
      AND ${long ? "memory_history_fts MATCH ?" : "h.text LIKE ? ESCAPE '\\'"}
      ORDER BY h.rowid DESC LIMIT ? OFFSET ?`).all(owner, agent, ...(query.sessionId ? [query.sessionId] : []), pattern, query.limit + 1, query.offset) as
      Array<{ rowid: number; sessionId: string; source: string; text: string; createdAt: string }>;
    return { rows: rows.slice(0, query.limit), nextOffset: rows.length > query.limit ? query.offset + query.limit : null };
  }
  search(owner: string, agent: string, input: unknown) {
    this.assertOwned(owner, agent);
    const query = historyQuery.parse(input), found = this.matches(owner, agent, query);
    const data = found.rows.map(({ rowid: _rowid, ...row }) => {
      const raw = String(row.text), at = raw.toLowerCase().indexOf(query.query.toLowerCase());
      const start = raw.length <= 4000 ? 0 : Math.max(0, at - 1000);
      return { ...row, text: raw.slice(start, start + 4000), textOffset: start, truncated: raw.length > 4000 };
    });
    return { data, nextOffset: found.nextOffset,
      coverage: "completed_turns_observed_by_mau_and_explicitly_imported_native_history", format: "original_text" };
  }
}
