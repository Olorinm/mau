import { useSyncExternalStore } from "react";

/** Pages of the settings modal. The URL hash `#/settings/<section>/<item>` deep-links into them. */
export const settingsSections = ["general", "connectors", "channels", "identity", "extensions", "data", "help"] as const;
export type SettingsSection = (typeof settingsSections)[number];
export interface SettingsRoute { section: SettingsSection | null; item?: string }

const prefix = "#/settings";
const returnKey = "mau.settingsReturn";

/** `null` when the settings modal is closed. A bare `#/settings` has no section (the navigation on mobile). */
export function parseSettingsHash(hash: string): SettingsRoute | null {
  if (hash !== prefix && !hash.startsWith(prefix + "/")) return null;
  const [section, item] = hash.slice(prefix.length + 1).split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return ""; }
  });
  if (!section) return { section: null };
  if (!(settingsSections as readonly string[]).includes(section)) return { section: "general" };
  return { section: section as SettingsSection, ...(item ? { item } : {}) };
}

export function settingsHash(route: SettingsRoute): string {
  if (!route.section) return prefix;
  return `${prefix}/${route.section}${route.item ? "/" + encodeURIComponent(route.item) : ""}`;
}

const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) { addEventListener("hashchange", notify); addEventListener("popstate", notify); }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { removeEventListener("hashchange", notify); removeEventListener("popstate", notify); }
  };
};

/** The open settings page, from the URL. */
export function useSettingsRoute(): SettingsRoute | null {
  const hash = useSyncExternalStore(subscribe, () => location.hash, () => "");
  return parseSettingsHash(hash);
}

/** Open (or move inside) the settings modal. Opening and sub-pages add a history entry; switching sections replaces it. */
export function openSettings(route: SettingsRoute, options: { replace?: boolean } = {}) {
  const url = location.pathname + location.search + settingsHash(route);
  if (options.replace) history.replaceState(history.state, "", url);
  else history.pushState(history.state, "", url);
  notify();
}

export function closeSettings() {
  history.replaceState(history.state, "", location.pathname + location.search);
  notify();
}

/** Remember the page an OAuth redirect should come back to (the callback lands on `/?view=connectors&oauth=…`). */
export function rememberSettingsReturn(route: SettingsRoute, storage: Storage = sessionStorage) {
  try { storage.setItem(returnKey, settingsHash(route)); } catch { /* The connectors page is the fallback. */ }
}

/** The remembered page (once), or the connectors page. */
export function takeSettingsReturn(storage: Storage = sessionStorage): SettingsRoute {
  let saved: string | null = null;
  try { saved = storage.getItem(returnKey); storage.removeItem(returnKey); } catch { /* fall through */ }
  return (saved && parseSettingsHash(saved)) || { section: "connectors" };
}
