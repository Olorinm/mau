import { useSyncExternalStore } from "react";
import type { EmployeeAvatarAppearance } from "@olorinm/agent-ui/app";

/** How employees are drawn: pixel animals by default, or the illustrated faces. Remembered in this browser. */
const storageKey = "mau.avatar";
let current: EmployeeAvatarAppearance = "pixel";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
try {
  if (localStorage.getItem(storageKey) === "illustrated") current = "illustrated";
} catch {
  // The choice still applies to this page when storage is unavailable.
}

export function useAvatarAppearance() {
  const appearance = useSyncExternalStore(subscribe, () => current, () => "pixel" as EmployeeAvatarAppearance);
  const set = (next: EmployeeAvatarAppearance) => {
    current = next;
    try { localStorage.setItem(storageKey, next); } catch { /* not remembered */ }
    for (const listener of listeners) listener();
  };
  return [appearance, set] as const;
}
