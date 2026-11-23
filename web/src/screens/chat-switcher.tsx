import { useState, type ReactNode } from "react";
import { SearchField } from "@olorinm/agent-ui/pages";
import { ProductIcon, TextButton } from "@olorinm/agent-ui/app";

/** One conversation the owner can switch to: a partner (with or without a chat yet), a group, or another channel's session. */
export interface ChatEntry {
  /** Stable across the chat being opened: `agent:<id>` for a partner, `chat:<chatId>` otherwise. */
  key: string;
  title: string;
  /** What the partner is doing, shown under the name in the header, and in its row while it has no message. */
  status?: string | undefined;
  /** The last message, shown under the name in its row. */
  preview?: string | undefined;
  time?: string | undefined;
  /** What the partner waits for from the owner, shown in the row in place of the last message. */
  note?: string | undefined;
  unread: number;
  avatar(size: number): ReactNode;
}
export interface ChatSection {
  id: string;
  title: string;
  entries: ChatEntry[];
  action?: { label: string; onSelect(): void } | undefined;
  /** Entries put away from the section (dismissed partners): one row at its end opens them, each with its action. */
  archived?: { label: string; entries: ChatEntry[]; action: { label: string; pending?: boolean; onSelect(entry: ChatEntry): void } } | undefined;
}

/**
 * The conversations, one row each, with the last message and what is unread; or one partner's profile on top of
 * them, with the way back. It is the side of a wide window and the first page of a narrow one.
 */
export function ChatRoster({ sections, current, onPick, label, searchLabel, emptyLabel, lead, profile, onProfile, onBack }: {
  sections: readonly ChatSection[]; current: string | undefined; onPick(entry: ChatEntry): void;
  label: string; searchLabel: string; emptyLabel: string;
  /** What stands above the search of the list: the mark and the account on a narrow screen. */
  lead?: ReactNode;
  /** A partner's profile, shown in place of the list. */
  profile?: { label: string; backLabel: string; content: ReactNode } | undefined;
  /** Opens a partner's profile from its row. */
  onProfile?: { label: string; available(entry: ChatEntry): boolean; open(entry: ChatEntry): void } | undefined;
  onBack?(): void;
}) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const matches = (entry: ChatEntry) => entry.title.toLowerCase().includes(query);
  const shown = sections.map((section) => ({ ...section, entries: section.entries.filter(matches),
    archived: section.archived && { ...section.archived, entries: section.archived.entries.filter(matches) } }));
  // Sections whose put-away entries are listed; a search that finds one lists them too.
  const [opened, setOpened] = useState<readonly string[]>([]);
  const row = (entry: ChatEntry, trailing?: ReactNode) => (
    <div key={entry.key} className="mau-roster-item" data-trailing={trailing ? "" : undefined}>
      <button type="button" className="mau-roster-row" data-chat-key={entry.key} aria-current={entry.key === current ? "true" : undefined}
        title={entry.title} onClick={() => onPick(entry)}>
        {entry.avatar(40)}
        <span className="mau-roster-text">
          <span className="mau-roster-name">{entry.title}</span>
          <span className="mau-roster-preview">{entry.note ? <span className="mau-roster-note">{entry.note}</span> : entry.preview ?? entry.status}</span>
        </span>
        {trailing ? null : <span className="mau-roster-meta">{entry.time}{entry.unread ? <span className="mau-badge">{entry.unread}</span> : null}</span>}
      </button>
      {trailing ?? (onProfile?.available(entry) ? <button type="button" className="mau-roster-info" aria-label={`${onProfile.label} · ${entry.title}`}
        title={onProfile.label} onClick={() => onProfile.open(entry)}>i</button> : null)}
    </div>
  );
  if (profile) return (
    <aside className="mau-roster" data-view="profile" aria-label={profile.label}>
      <div className="mau-roster-top">
        <button type="button" className="mau-roster-back" onClick={onBack}><ProductIcon name="back" size={18} /><span>{profile.backLabel}</span></button>
      </div>
      {profile.content}
    </aside>
  );
  return (
    <aside className="mau-roster" data-view="list" aria-label={label}>
      {lead}
      <div className="mau-roster-top">
        <SearchField value={search} onChange={setSearch} placeholder={searchLabel} />
      </div>
      {shown.map((section) => section.entries.length || section.archived?.entries.length || (section.action && !query) ? (
        <section key={section.id} aria-label={section.title}>
          <h3>
            <span>{section.title} · {section.entries.length}</span>
            {section.action ? <button type="button" aria-label={section.action.label} title={section.action.label} onClick={section.action.onSelect}>+</button> : null}
          </h3>
          {section.entries.map((entry) => row(entry))}
          {section.archived?.entries.length ? (() => {
            const archived = section.archived, open = opened.includes(section.id) || !!query;
            return <>
              <button type="button" className="mau-roster-archive" aria-expanded={open}
                onClick={() => setOpened((ids) => ids.includes(section.id) ? ids.filter((id) => id !== section.id) : [...ids, section.id])}>
                <ProductIcon name="next" size={12} />
                <span>{archived.label} · {archived.entries.length}</span>
              </button>
              {open ? archived.entries.map((entry) => row(entry,
                <TextButton className="mau-roster-restore" disabled={archived.action.pending} aria-label={`${archived.action.label} · ${entry.title}`}
                  onClick={() => archived.action.onSelect(entry)}>{archived.action.label}</TextButton>)) : null}
            </>;
          })() : null}
        </section>
      ) : null)}
      {query && shown.every((section) => !section.entries.length && !section.archived?.entries.length) ? <p className="mau-muted mau-roster-empty">{emptyLabel}</p> : null}
    </aside>
  );
}

