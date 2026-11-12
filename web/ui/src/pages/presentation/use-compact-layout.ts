// Extracted from web/src/runtime/use-compact-layout.ts at 8b365ed. See source-manifest.json for boundary changes.
import { useSyncExternalStore } from "react";
export const COMPACT_LAYOUT_QUERY = "(max-width: 900px)";
const subscribe = (notify: () => void) => {
  const query = window.matchMedia(COMPACT_LAYOUT_QUERY);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};
const snapshot = () => window.matchMedia(COMPACT_LAYOUT_QUERY).matches;

export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
