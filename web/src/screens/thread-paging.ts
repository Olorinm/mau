/**
 * Threads of one partner the page opens at a time: this many of the ones that began last, this many more each time
 * the reader comes to the top, and beside them the ones something happened in last, however long ago they began.
 */
export const OPEN_THREADS = 60;

/**
 * Which threads of a partner the page has open, of all of them in the order they began. `open`: the `window` that
 * began last, the `OPEN_THREADS` something happened in last, and the one open beside the conversation, in the same
 * order. `earlier`: threads that began before the window are not open. `from`: when that is so, the moment the window
 * begins; before it a thread may be missing from the page, so the page shows nothing from before it.
 */
export function openThreads<T extends { id: string; createdAt: string; lastAt: string }>(all: readonly T[], window: number, beside?: string): { open: T[]; earlier: boolean; from: string } {
  const earlier = all.length > window, first = Math.max(0, all.length - window);
  const active = new Set([...all].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, OPEN_THREADS).map((item) => item.id));
  return { open: all.filter((item, index) => index >= first || active.has(item.id) || item.id === beside), earlier, from: earlier ? all[first]!.createdAt : "" };
}
