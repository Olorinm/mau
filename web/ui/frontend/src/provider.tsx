import { createContext, useContext, useMemo, type ReactNode } from "react";
import { FrontendScope, type FrontendTheme } from "./scope";
import {
  PresentationLocale,
  type PresentationLanguage,
} from "./presentation/i18n";

export const frontendLabels = {
  "filePreview.directoryActions": "Directory actions",
  "compact.workspace": "Workspace",
  "compact.chat": "Chat",
  "compact.files": "Files",
  navigation: "Navigation",
  connected: "Connected",
  unavailable: "Unavailable",
  fileMode: "File view",
  preview: "Preview",
  edit: "Edit",
  open: "Open",
  download: "Download",
  resizeNavigation: "Resize navigation",
  create: "Create",
  clearSearch: "Clear search",
  changeAvatar: "Change avatar",
  name: "Name",
  send: "Send",
  attachments: "Attachments",
  mention: "Mention",
  close: "Close",
  toggleNavigation: "Toggle navigation",
  back: "Back",
  search: "Search",
  loading: "Loading…",
  empty: "Nothing here yet",
  "filePreview.copyDiskChange": "Copy this change",
  "filePreview.conflictInstructions": "Review the changes before saving.",
  "filePreview.diskVersion": "Saved version",
  "filePreview.mergeResult": "Your changes",
  "filePreview.changedAgain":
    "The saved version changed again. Refresh before saving.",
  "filePreview.copyDiskVersion": "Use saved version",
  "filePreview.keepDraft": "Keep draft",
  "filePreview.saveResolution": "Save resolution",
} as const;
export type FrontendLabelKey = keyof typeof frontendLabels;
export type FrontendTranslate = (key: FrontendLabelKey) => string;
const defaultTranslate: FrontendTranslate = (key) => frontendLabels[key];
const Labels = createContext<FrontendTranslate>(defaultTranslate);
/** Instance-local presentation labels. Does not change document language or storage. */
export function FrontendProvider({
  translate = defaultTranslate,
  children,
  language = "en",
  presentationLabels,
  theme = "system",
}: {
  translate?: FrontendTranslate;
  children: ReactNode;
  language?: PresentationLanguage;
  presentationLabels?: Readonly<Record<string, string>>;
  theme?: FrontendTheme;
}) {
  const locale = useMemo(
    () => ({ language, labels: presentationLabels }),
    [language, presentationLabels],
  );
  return (
    <PresentationLocale.Provider value={locale}>
      <Labels.Provider value={translate}>
        <FrontendScope theme={theme}>{children}</FrontendScope>
      </Labels.Provider>
    </PresentationLocale.Provider>
  );
}
export function useFrontendLabels() {
  const t = useContext(Labels);
  return useMemo(() => ({ t }), [t]);
}
