import type { MemoryOperation } from "./client";

/**
 * A memory file shown as one Markdown document. The file separates its entries with a `§` line, which a Markdown
 * editor would fold into the text around it, so the document separates them with a divider (a thematic break).
 */
export const memoryDocument = (entries: readonly string[]) => entries.join("\n\n---\n\n");

const divider = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const fence = /^ {0,3}(`{3,}|~{3,})/;
// The editor writes an empty paragraph as a line break of its own.
const blank = /^(?:<br\s*\/?>)?\s*$/;

/** The entries of a memory document: the text between its dividers. A divider inside a code block is text. */
export function memoryEntries(document: string): string[] {
  const entries: string[] = [];
  let lines: string[] = [], open: string | undefined;
  const close = () => {
    while (lines.length && blank.test(lines[0]!)) lines.shift();
    while (lines.length && blank.test(lines.at(-1)!)) lines.pop();
    const entry = lines.join("\n").trim();
    if (entry && !entries.includes(entry)) entries.push(entry);
    lines = [];
  };
  for (const line of document.replace(/\r\n?/g, "\n").split("\n")) {
    const mark = fence.exec(line)?.[1];
    if (mark && !open) open = mark;
    else if (mark && mark[0] === open![0] && mark.length >= open!.length && !line.slice(line.indexOf(mark) + mark.length).trim()) open = undefined;
    else if (!open && divider.test(line)) { close(); continue; }
    lines.push(line);
  }
  close();
  return entries;
}

/**
 * The changes that turn the saved entries into the edited ones, in the edited order. The server applies them one
 * after another: it replaces in place, appends what is added, and refuses an entry that is already there.
 */
export function memoryOperations(saved: readonly string[], edited: readonly string[]): MemoryOperation[] {
  let head = 0;
  while (head < saved.length && head < edited.length && saved[head] === edited[head]) head++;
  let tail = 0;
  while (tail < saved.length - head && tail < edited.length - head && saved[saved.length - 1 - tail] === edited[edited.length - 1 - tail]) tail++;
  const before = saved.slice(head, saved.length - tail), after = edited.slice(head, edited.length - tail), rest = saved.slice(saved.length - tail);
  // An entry that only moved cannot be written over another one while it still exists elsewhere.
  const paired = after.some((entry) => before.includes(entry)) ? 0 : Math.min(before.length, after.length);
  const added = after.slice(paired);
  // Additions land at the end, so the entries that follow them are taken out and put back after them.
  const moved = added.length ? rest : [];
  return [
    ...before.slice(0, paired).map((entry, index) => ({ action: "replace" as const, old_text: entry, content: after[index]! })),
    ...[...before.slice(paired), ...moved].map((entry) => ({ action: "remove" as const, old_text: entry })),
    ...[...added, ...moved].map((entry) => ({ action: "add" as const, content: entry })),
  ];
}
