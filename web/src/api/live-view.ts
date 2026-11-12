/** Where Cloudflare Browser Run serves a live view. Only this origin is ever framed (see the console's `frame-src`). */
const liveViewOrigin = "https://live.browser.run";
/** The private live-view link in a pending handoff card's text, if it points at the live-view origin. */
export function liveViewUrl(text: string | undefined): string | undefined {
  const found = /https:\/\/live\.browser\.run\/[^\s<>"')\]]+/.exec(text ?? "")?.[0];
  if (!found) return undefined;
  try { return new URL(found).origin === liveViewOrigin ? found : undefined; } catch { return undefined; }
}
