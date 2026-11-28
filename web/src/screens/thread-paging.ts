/**
 * Threads of one partner the page follows live: this many of the ones that began last, and this many of the ones
 * something happened in last. Router admits 200 subscriptions on one connection; the threads of earlier pages are
 * read, not followed.
 */
export const OPEN_THREADS = 60;

/** The threads of one partner the page has been given so far, in the order they began, and the thread to ask before for the ones that began earlier. */
export interface ThreadBook<T> { paged: T[]; earlier: string | null }

/**
 * A page of a partner's threads added to what the page has. The first page is asked for again and again: its threads
 * replace what was known of them, and new ones follow the others; where the list goes on is what the first answer
 * said, because threads that have since left the first page are still here. An earlier page stands before the others.
 */
export function withPage<T extends { id: string }>(book: ThreadBook<T> | undefined, page: { data: readonly T[]; earlier: string | null }, first: boolean): ThreadBook<T> {
  const given = new Map(page.data.map((item) => [item.id, item])), known = new Set(book?.paged.map((item) => item.id));
  const kept = (book?.paged ?? []).map((item) => given.get(item.id) ?? item), added = page.data.filter((item) => !known.has(item.id));
  return first ? { paged: [...kept, ...added], earlier: book?.paged.length ? book.earlier : page.earlier } : { paged: [...added, ...kept], earlier: page.earlier };
}

/**
 * The first page of a partner's threads, asked for again: the ones that began last, and with them the pages between
 * them and what the page has. More threads than one page holds may have begun since the last answer, and the ones
 * before the first page would otherwise be in no page the reader comes to.
 */
export async function newestPages<T extends { id: string }, P extends { data: T[]; earlier: string | null }>(book: ThreadBook<T> | undefined, read: (before?: string) => Promise<P>): Promise<P> {
  const first = await read(), known = new Set(book?.paged.map((item) => item.id));
  let data = first.data, earlier = first.earlier;
  while (known.size && earlier && !data.some((item) => known.has(item.id))) {
    const page = await read(earlier);
    data = [...page.data, ...data]; earlier = page.earlier;
  }
  return { ...first, data, earlier };
}

/**
 * What the page does with a partner's threads. `live`: followed as they change, which takes a subscription each: the
 * `OPEN_THREADS` that began last, the ones something happened in last (`active`, as the server lists them), and the
 * one open beside the conversation. `read`: the rest of what was paged, read once. `from`: while threads began before
 * the ones paged, the moment the paged ones begin; before it a thread may be missing, so the page shows nothing from
 * before it. An active thread that began before that is reached by what is new in it, not where it began.
 */
export function openThreads<T extends { id: string; createdAt: string }>(book: ThreadBook<T> | undefined, active: readonly T[], beside?: string): { live: T[]; read: T[]; from: string } {
  const paged = book?.paged ?? [], recent = new Set(paged.slice(-OPEN_THREADS).map((item) => item.id)), current = new Map(active.map((item) => [item.id, item]));
  const followed = (item: T) => recent.has(item.id) || current.has(item.id) || item.id === beside;
  const shown = new Set(paged.map((item) => item.id));
  return { live: [...active.filter((item) => !shown.has(item.id)), ...paged.filter(followed).map((item) => current.get(item.id) ?? item)],
    read: paged.filter((item) => !followed(item)), from: book?.earlier && paged.length ? paged[0]!.createdAt : "" };
}
