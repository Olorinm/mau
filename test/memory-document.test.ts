import { expect, it } from "vitest";
import { memoryDocument, memoryEntries, memoryOperations } from "../web/src/api/memory-document";
import type { MemoryOperation } from "../web/src/api/client";

// The server's rules: replace in place, append what is added, refuse an entry that is already there.
function apply(saved: string[], operations: MemoryOperation[]) {
  const entries = [...saved];
  for (const operation of operations) {
    if (operation.action !== "remove" && entries.includes(operation.content)) throw new Error("memory_duplicate");
    if (operation.action === "add") { entries.push(operation.content); continue; }
    const index = entries.indexOf(operation.old_text);
    if (index < 0) throw new Error("memory_no_match");
    if (operation.action === "remove") entries.splice(index, 1); else entries[index] = operation.content;
  }
  return entries;
}

it("a memory document is its entries between dividers, however the editor writes a divider", () => {
  const entries = ["First.", "Steps:\n- one\n- two", "Deploy:\n```bash\necho a\n---\necho b\n```"];
  expect(memoryEntries(memoryDocument(entries))).toEqual(entries);
  expect(memoryEntries("First.\n\n***\n\nSecond.\n\n___\n\n- - -\n\n<br />\n\nThird.\n\n<br />\n\n***\n\nFirst.\n")).toEqual(["First.", "Second.", "Third."]);
  expect(memoryEntries("~~~\n***\n~~~\n")).toEqual(["~~~\n***\n~~~"]);
  expect(memoryEntries("\n<br />\n")).toEqual([]);
});

it("saving a memory document changes the entries in place and keeps their order", () => {
  const saved = ["a", "b", "c", "d"];
  const cases: string[][] = [
    saved, ["a", "B", "c", "d"], ["a", "c", "d"], ["a", "b", "c", "d", "e"], ["a", "x", "b", "c", "d"], ["x", "a", "b", "c", "d"],
    ["d", "c", "b", "a"], ["a", "c", "b", "d"], ["A", "B", "C", "D"], ["a", "B", "x", "y", "d"], ["b", "x"], [],
  ];
  for (const edited of cases) expect(apply(saved, memoryOperations(saved, edited))).toEqual(edited);
  expect(memoryOperations(saved, saved)).toEqual([]);
  expect(memoryOperations(saved, ["a", "B", "c", "d"])).toEqual([{ action: "replace", old_text: "b", content: "B" }]);
  expect(memoryOperations(saved, ["a", "b", "c", "d", "e"])).toEqual([{ action: "add", content: "e" }]);
  expect(memoryOperations([], ["a"])).toEqual([{ action: "add", content: "a" }]);
});
