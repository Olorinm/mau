import { useEffect, useState, type ReactNode } from "react";
import { SearchField } from "@olorinm/agent-frontend";

/** One conversation the owner can switch to: an employee (with or without a chat yet), a group, or another channel's session. */
export interface ChatEntry {
  /** Stable across the chat being opened: `agent:<id>` for an employee, `chat:<chatId>` otherwise. */
  key: string;
  title: string;
  /** What the employee is doing, shown under the name in the header. */
  status?: string | undefined;
  /** The last message, shown as the row's tooltip in the full list. */
  preview?: string | undefined;
  time?: string | undefined;
  unread: number;
  avatar(size: number): ReactNode;
}
export interface ChatSection {
  id: string;
  title: string;
  entries: ChatEntry[];
  action?: { label: string; onSelect(): void } | undefined;
}

const stripKey = "mau.chatStrip";
export const stripSize = 5;
function stored(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(stripKey) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

/**
 * The few conversations kept in the header. Their order is the owner's own: it only changes when a conversation
 * that is not in the row is opened (it goes first and the last one leaves), never because a message arrived.
 */
export function useChatStrip(all: readonly ChatEntry[], current: string | undefined) {
  const [kept, setKept] = useState(stored);
  const known = new Set(all.map((entry) => entry.key));
  let keys = kept.filter((key) => known.has(key)).slice(0, stripSize);
  for (const entry of all) { if (keys.length >= stripSize) break; if (!keys.includes(entry.key)) keys.push(entry.key); }
  if (current && known.has(current) && !keys.includes(current)) keys = [current, ...keys].slice(0, stripSize);
  const signature = keys.join("\n");
  useEffect(() => {
    if (!all.length || signature === kept.join("\n")) return;
    setKept(keys);
    try { localStorage.setItem(stripKey, JSON.stringify(keys)); } catch { /* the order just is not remembered */ }
  }, [signature, all.length]);
  const byKey = new Map(all.map((entry) => [entry.key, entry]));
  return keys.flatMap((key) => byKey.get(key) ?? []);
}

/** The header row: the current conversation as a capsule with its name, the others as figures, then "+N" for the rest. */
export function ChatStrip({ entries, current, rest, expanded, onPick, onToggleAll, label, allLabel }: {
  entries: readonly ChatEntry[]; current: string | undefined; rest: number; expanded: boolean;
  onPick(entry: ChatEntry): void; onToggleAll(): void; label: string; allLabel: string;
}) {
  return (
    <div className="mau-strip" role="tablist" aria-label={label}>
      {/* While the full list is open, its rows stand in for the row of figures. */}
      {expanded ? null : entries.map((entry) => {
        const selected = entry.key === current;
        return (
          <button key={entry.key} type="button" role="tab" aria-selected={selected} className="mau-chip" data-chat-key={entry.key}
            title={entry.title} onClick={() => onPick(entry)}>
            <span className="mau-chip-avatar">
              {entry.avatar(32)}
              {entry.unread && !selected ? <span className="mau-badge">{entry.unread}</span> : null}
            </span>
            <span className="mau-chip-label">
              <strong>{entry.title}</strong>
              {entry.status ? <small>{entry.status}</small> : null}
            </span>
          </button>
        );
      })}
      {expanded ? null : (
        <button type="button" className="mau-chip mau-chip-more" aria-expanded={false} aria-label={allLabel} title={allLabel} onClick={onToggleAll}>
          <span className="mau-chip-rest" aria-hidden="true">{rest > 0 ? `+${rest}` : "···"}</span>
        </button>
      )}
    </div>
  );
}

/** The full list: a small card beside the conversation, one row per conversation. */
export function ChatRoster({ sections, current, onPick, onClose, label, searchLabel, closeLabel, emptyLabel }: {
  sections: readonly ChatSection[]; current: string | undefined; onPick(entry: ChatEntry): void; onClose(): void;
  label: string; searchLabel: string; closeLabel: string; emptyLabel: string;
}) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const shown = sections.map((section) => ({ ...section, entries: section.entries.filter((entry) => entry.title.toLowerCase().includes(query)) }));
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  return (
    <aside className="mau-roster" aria-label={label}>
      <div className="mau-roster-top">
        <SearchField value={search} onChange={setSearch} placeholder={searchLabel} />
        <button type="button" className="mau-roster-close" aria-label={closeLabel} title={closeLabel} onClick={onClose}>×</button>
      </div>
      {shown.map((section) => section.entries.length || (section.action && !query) ? (
        <section key={section.id} aria-label={section.title}>
          <h3>
            <span>{section.title} · {section.entries.length}</span>
            {section.action ? <button type="button" aria-label={section.action.label} title={section.action.label} onClick={section.action.onSelect}>+</button> : null}
          </h3>
          {section.entries.map((entry) => (
            <button key={entry.key} type="button" className="mau-roster-row" data-chat-key={entry.key} aria-current={entry.key === current ? "true" : undefined}
              title={entry.preview} onClick={() => onPick(entry)}>
              {entry.avatar(30)}
              <span className="mau-roster-name">{entry.title}</span>
              <span className="mau-roster-meta">{entry.unread ? <span className="mau-badge">{entry.unread}</span> : entry.time}</span>
            </button>
          ))}
        </section>
      ) : null)}
      {query && shown.every((section) => !section.entries.length) ? <p className="mau-muted mau-roster-empty">{emptyLabel}</p> : null}
    </aside>
  );
}

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const figure = (root: ParentNode, key: string) =>
  root.querySelector<HTMLElement>(`[data-chat-key="${CSS.escape(key)}"] :is(.agent-pixel-avatar-group, .agent-pixel-avatar, .agent-ui-avatar-root)`);

/** Where the figure of `key` is drawn now, in the header row or in the full list. */
export function figureRect(key: string | undefined) {
  return key ? figure(document, key)?.getBoundingClientRect() : undefined;
}
/** After the list opened or closed: the current conversation's figure slides from where it was to where it is now. */
export function slideFigure(key: string | undefined, from: DOMRect | undefined) {
  const element = key ? figure(document, key) : undefined;
  if (!element || !from || reduced()) return;
  const to = element.getBoundingClientRect();
  if (!to.width) return;
  element.animate([
    { transformOrigin: "0 0", transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})` },
    { transformOrigin: "0 0", transform: "none" },
  ], { duration: 280, easing: "cubic-bezier(.3, .7, .2, 1)" });
}
