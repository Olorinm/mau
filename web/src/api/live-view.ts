/** Where Cloudflare Browser Run serves a live view. Only this origin is ever framed (see the console's `frame-src`). */
const liveViewOrigin = "https://live.browser.run";
/**
 * The private live-view link of a pending handoff card. It is read only from the card's structured `handoff` field,
 * which Mau fills from the browser connection; the card's text carries what the Agent wrote and is never searched.
 */
export function liveViewUrl(card: { native?: { params: unknown } } | undefined): string | undefined {
  const found = (card?.native?.params as { handoff?: { liveViewUrl?: unknown } } | null | undefined)?.handoff?.liveViewUrl;
  if (typeof found !== "string") return undefined;
  try { return new URL(found).origin === liveViewOrigin ? found : undefined; } catch { return undefined; }
}
