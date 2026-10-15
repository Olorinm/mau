import { useState } from "react";

type ThemePreference = "system" | "light" | "dark";
const storageKey = "mau.theme";
let current: ThemePreference = "system";

try {
  const saved = localStorage.getItem(storageKey);
  if (saved === "light" || saved === "dark") current = saved;
} catch {
  // Preferences can still be changed for this page when storage is unavailable.
}

export function applyTheme() {
  document.documentElement.dataset.theme =
    current === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : current;
}

export function watchSystemTheme() {
  const media = matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", applyTheme);
  return () => media.removeEventListener("change", applyTheme);
}

export function useThemePreference() {
  const [preference, setPreference] = useState(current);
  return [
    preference,
    (value: string) => {
      if (value !== "system" && value !== "light" && value !== "dark") return;
      current = value;
      setPreference(value);
      try {
        localStorage.setItem(storageKey, value);
      } catch {
        /* Keep the page preference. */
      }
      applyTheme();
    },
  ] as const;
}
