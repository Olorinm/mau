import { createContext, useContext, useMemo, type ReactNode } from 'react';

export const frontendLabels = {
  navigation: 'Navigation', toggleNavigation: 'Toggle navigation', back: 'Back',
  search: 'Search', loading: 'Loading…', empty: 'Nothing here yet',
  'filePreview.copyDiskChange': 'Copy this change',
  'filePreview.conflictInstructions': 'Review the changes before saving.',
  'filePreview.diskVersion': 'Saved version', 'filePreview.mergeResult': 'Your changes',
  'filePreview.changedAgain': 'The saved version changed again. Refresh before saving.',
  'filePreview.copyDiskVersion': 'Use saved version', 'filePreview.keepDraft': 'Keep draft',
  'filePreview.saveResolution': 'Save resolution',
} as const;
export type FrontendLabelKey = keyof typeof frontendLabels;
export type FrontendTranslate = (key: FrontendLabelKey) => string;
const defaultTranslate: FrontendTranslate = key => frontendLabels[key];
const Labels = createContext<FrontendTranslate>(defaultTranslate);
/** Instance-local presentation labels. Does not change document language or storage. */
export function FrontendProvider({ translate = defaultTranslate, children }: {
  translate?: FrontendTranslate; children: ReactNode;
}) {
  return <Labels.Provider value={translate}>{children}</Labels.Provider>;
}
export function useFrontendLabels() {
  const t = useContext(Labels);
  return useMemo(() => ({ t }), [t]);
}
