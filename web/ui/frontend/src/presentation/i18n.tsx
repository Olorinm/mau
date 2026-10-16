import { createContext, useContext, useCallback } from "react";
import { presentationLabels } from "./labels";
import { restoredLabels } from "./restored-labels";

export type PresentationLanguage = "en" | "zh-CN";
export type TranslationFn = (
  key: string,
  values?: Record<string, string | number>,
) => string;
export const PresentationLocale = createContext<{
  language: PresentationLanguage;
  labels?: Readonly<Record<string, string>>;
}>({ language: "en" });

/** Instance-local text only. The embedding product owns locale preference persistence. */
export function useI18n() {
  const { language, labels } = useContext(PresentationLocale);
  const t: TranslationFn = useCallback(
    (key, values) => {
      const template =
        labels?.[key] ??
        restoredLabels[language]?.[key] ??
        presentationLabels[language]?.[key] ??
        presentationLabels.en?.[key] ??
        key;
      return template.replace(/\{([^}]+)\}/g, (placeholder, name: string) =>
        String(values?.[name] ?? placeholder),
      );
    },
    [language, labels],
  );
  return { language, t };
}

export type TranslationKey = string;
export function rawDiagnosticText(value: string): string {
  return value;
}
