import { expect, it } from "vitest";
import { OPEN_THREADS, newestPages, openThreads, withPage, type ThreadBook } from "../web/src/screens/thread-paging";

// What a partner's page does with its threads: the server pages them, and the console follows only some of them live,
// because a connection is allowed 200 subscriptions.
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString();
const threads = (count: number, from = 1) => Array.from({ length: count }, (_, index) => ({ id: `t${from + index}`, createdAt: at(from + index), lastAt: at(from + index) }));
const ids = (list: Array<{ id: string }>) => list.map(item => item.id);

it("follows every thread of a partner that has few, and shows the page from its beginning", () => {
  const all = threads(OPEN_THREADS), book = withPage(undefined, { data: all, earlier: null }, true);
  expect(openThreads(book, all)).toEqual({ live: all, read: [], from: "" });
  expect(openThreads(undefined, [])).toEqual({ live: [], read: [], from: "" });
});

it("keeps the threads it was given when the first page moves on, and puts earlier pages before them", () => {
  // The first answer: threads 141 to 200, and where the list goes on.
  let book: ThreadBook<{ id: string; createdAt: string; lastAt: string }> = withPage(undefined, { data: threads(60, 141), earlier: "t141" }, true);
  // Asked again after two more threads began: the first page is now 143 to 202. Nothing that was shown is lost, the
  // new ones follow, what is known of the others is replaced, and the list still goes on before 141.
  const again = threads(60, 143).map(item => item.id === "t150" ? { ...item, lastAt: at(999) } : item);
  book = withPage(book, { data: again, earlier: "t143" }, true);
  expect(ids(book.paged)).toEqual(ids(threads(62, 141))); expect(book.earlier).toBe("t141");
  expect(book.paged.find(item => item.id === "t150")!.lastAt).toBe(at(999));
  // An earlier page stands before them, and says where the next one begins; the last one says there is none.
  book = withPage(book, { data: threads(60, 81), earlier: "t81" }, false);
  expect(ids(book.paged)).toEqual(ids(threads(122, 81))); expect(book.earlier).toBe("t81");
  book = withPage(book, { data: threads(80, 1), earlier: null }, false);
  expect(ids(book.paged)).toEqual(ids(threads(202))); expect(book.earlier).toBeNull();
});

it("follows the threads that began last and the ones something happened in last, and only reads the rest: never more than a connection may follow", () => {
  let book = withPage(undefined, { data: threads(60, 442), earlier: "t442" }, true);
  // The first thread of 501 got an answer just now: the server lists it among the active ones, and the page follows it
  // although it began before everything the page has.
  const first = { id: "t1", createdAt: at(1), lastAt: at(9999) }, active = [first, ...threads(59, 443).reverse()];
  let opened = openThreads(book, active);
  expect(opened.live[0]).toBe(first); expect(opened.live).toHaveLength(61); expect(opened.read).toEqual([]);
  // The page is whole only from where its threads begin: the old one is reached by what is new in it.
  expect(opened.from).toBe(at(442));
  // The reader goes back through every page, with one thread open beside the conversation.
  for (let from = 382; from >= 22; from -= 60) book = withPage(book, { data: threads(60, from), earlier: `t${from}` }, false);
  book = withPage(book, { data: threads(21, 1), earlier: null }, false);
  opened = openThreads(book, active, "t7");
  expect(book.paged).toHaveLength(501);
  expect(ids(opened.live)).toEqual(["t1", "t7", ...ids(threads(60, 442))]);
  expect(opened.live.length).toBeLessThanOrEqual(2 * OPEN_THREADS + 1);
  expect(opened.live.length + opened.read.length).toBe(501); expect(opened.from).toBe("");
  // What the server says of an active thread is what the page shows of it.
  expect(opened.live[0]!.lastAt).toBe(at(9999));
  // However many are active, the server lists sixty, so with the last sixty and the open one it stays far below 200.
  expect(openThreads(book, threads(60, 100), "t7").live).toHaveLength(121);
});

it("reads the pages between what it has and the first page when more threads began than a page holds", async () => {
  // The server as it pages: the sixty that began last, or the sixty before a thread.
  let count = 100;
  const asked: Array<string | undefined> = [];
  const read = async (before?: string) => {
    asked.push(before);
    const end = before ? Number(before.slice(1)) - 1 : count, from = Math.max(1, end - 59);
    return { data: threads(end - from + 1, from), earlier: from > 1 ? `t${from}` : null, ...(before ? {} : { active: threads(1, count) }) };
  };
  // Nothing is known yet: one page, and where the list goes on.
  let book = withPage(undefined, await newestPages(undefined, read), true);
  expect(ids(book.paged)).toEqual(ids(threads(60, 41))); expect(asked).toEqual([undefined]);
  // Two more began: they are on the first page with threads the page has, and nothing else is read.
  count = 102;
  book = withPage(book, await newestPages(book, read), true);
  expect(ids(book.paged)).toEqual(ids(threads(62, 41))); expect(asked).toEqual([undefined, undefined]);
  // Sixty-five more began at once: the first page is 108 to 167, and 103 to 107 are on the page before it.
  count = 167;
  const page = await newestPages(book, read);
  expect(asked.slice(2)).toEqual([undefined, "t108"]); expect(page.active).toEqual(threads(1, 167));
  book = withPage(book, page, true);
  expect(ids(book.paged)).toEqual(ids(threads(127, 41)));
  // Earlier threads are still asked for where the first answer said.
  expect(book.earlier).toBe("t41");
  // Several pages may lie between: all of them are read before anything is shown.
  count = 400; asked.length = 0;
  book = withPage(book, await newestPages(book, read), true);
  expect(asked).toEqual([undefined, "t341", "t281", "t221"]); expect(ids(book.paged)).toEqual(ids(threads(360, 41)));
});

it("lets a reader page back after the first threads arrive in an empty conversation", async () => {
  type Thread = ReturnType<typeof threads>[number];
  const emptyBook = withPage<Thread>(undefined, { data: [], earlier: null }, true);
  const page = await newestPages(emptyBook, async () => ({ data: threads(60, 6), earlier: "t6" }));
  const latestBook = withPage(emptyBook, page, true);
  expect(latestBook.earlier).toBe("t6");
  const complete = withPage(latestBook, { data: threads(5), earlier: null }, false);
  expect(ids(complete.paged)).toEqual(ids(threads(65)));
  expect(complete.earlier).toBeNull();
});
