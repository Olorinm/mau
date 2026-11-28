import { expect, it } from "vitest";
import { OPEN_THREADS, openThreads } from "../web/src/screens/thread-paging";

// Which of a partner's threads its page has open: the console cannot keep a chat open for every thread a partner ever had.
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString();
const threads = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `t${index + 1}`, createdAt: at(index), lastAt: at(index) }));

it("opens every thread of a partner that has few, and shows the page from its beginning", () => {
  const all = threads(OPEN_THREADS);
  expect(openThreads(all, OPEN_THREADS)).toEqual({ open: all, earlier: false, from: "" });
  expect(openThreads([], OPEN_THREADS)).toEqual({ open: [], earlier: false, from: "" });
});

it("opens the threads that began last, more of them as the reader goes back, and says from when the page is whole", () => {
  const all = threads(150), first = openThreads(all, OPEN_THREADS);
  expect(first.open.map(item => item.id)).toEqual(all.slice(-OPEN_THREADS).map(item => item.id));
  expect(first).toMatchObject({ earlier: true, from: all[150 - OPEN_THREADS]!.createdAt });
  const second = openThreads(all, 2 * OPEN_THREADS);
  expect(second.open).toHaveLength(2 * OPEN_THREADS); expect(second).toMatchObject({ earlier: true, from: all[30]!.createdAt });
  expect(openThreads(all, 3 * OPEN_THREADS)).toEqual({ open: all, earlier: false, from: "" });
});

it("keeps a thread open that began long ago when something happened in it lately, and the one open beside the conversation", () => {
  const all = threads(150);
  // The fifth thread got an answer after every other thread; the ninth is the one the owner has open.
  all[4] = { ...all[4]!, lastAt: at(1000) };
  const { open, from } = openThreads(all, OPEN_THREADS, "t9");
  expect(open.map(item => item.id)).toEqual(["t5", "t9", ...all.slice(-OPEN_THREADS).map(item => item.id)]);
  // The page is still whole only from where the window begins: the old thread is shown by what is new in it, not in its place.
  expect(from).toBe(all[90]!.createdAt);
  // Many threads active at once: the ones something happened in last, counted like the window.
  const busy = threads(200).map((item, index) => index < 100 ? { ...item, lastAt: at(2000 + index) } : item);
  expect(openThreads(busy, OPEN_THREADS).open.map(item => item.id)).toEqual([...busy.slice(40, 100), ...busy.slice(-OPEN_THREADS)].map(item => item.id));
});
