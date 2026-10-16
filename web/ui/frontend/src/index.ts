import "./style.css";
export { FrontendScope, type FrontendTheme } from "./scope";
export {
  FrontendProvider,
  frontendLabels,
  useFrontendLabels,
  type FrontendLabelKey,
  type FrontendTranslate,
} from "./provider";
export {
  AppShell,
  Navigation,
  type NavigationItem,
  type NavigationGroup,
  type MenuAction,
} from "./shell";
export {
  ItemList,
  ListDetailLayout,
  PageHeader,
  DetailPanel,
  type ListItem,
  CollectionEmptyState,
  CollaborationTabs,
  SidebarHeader,
  SearchField,
  LoadingSurface,
  InlineNotice,
} from "./layout";
export {
  AuthLayout,
  AuthField,
  AuthSubmit,
  AuthHeading,
  AuthLanguageButton,
} from "./auth";
export {
  Conversation,
  type MessageView,
  type ConversationComposer,
  type ComposerAttachment,
  type ComposerMention,
} from "./conversation";
export { Catalog, type CatalogItem } from "./catalog";
export {
  SettingsLayout,
  PreferenceGroup,
  PreferenceRow,
  type SettingsSection,
} from "./settings";
export {
  FileEditor,
  type FileEditorProps,
  type FileEditorHandle,
} from "./files/editor";
export {
  FilePreview,
  type FilePreviewProps,
  type FilePreviewKind,
} from "./files/preview";
export { FileConflictEditor } from "./files/conflict-editor";
export { type MarkdownEditorSelection } from "./files/code-editor";
export { SaplingPlaceholder } from "./artwork/sapling";
export { ConstellationPlaceholder } from "./artwork/constellation";

export {
  ProfileSurface,
  type ProfilePage,
  type ProfileAction,
} from "./profile";
export {
  ExtensionsPage,
  type ExtensionTab,
  type ExtensionRow,
} from "./extensions";
export { FilePanel } from "./files/panel";
export { MotionMenu, MotionMenuItem } from "./ui/menu";

export {
  DirectoryTree,
  type DirectoryTreeNode,
  type DirectoryTreeProps,
} from "./files/directory-tree";
export { DirectoryPanel } from "./files/directory-panel";
export {
  AdaptiveSplitLayout,
  usePaneVisible,
  useSplitCompact,
  type WorkspacePane,
} from "./layouts/adaptive-split-layout";
export { WorkspaceWorkbenchLayout } from "./layouts/workspace-workbench-layout";
export { InlineSelect, type InlineSelectOption } from "./ui/inline-select";
export {
  ProfileDialog,
  AppCreateForm,
  AppIdentityEditor,
  AppSettingsDialog,
  type FormTab,
} from "./forms";
export {
  VersionSwitchBlocker,
  VersionHistory,
  type VersionRow,
} from "./versions";

export { RoomComposer, type MentionOption } from "./presentation/room-composer";
export { RoomChatSurface } from "./presentation/room-chat-surface";
export { RoomMessageStream } from "./presentation/room-message-stream";
export {
  AppCreateWizard,
  type AppBuilderRequest,
} from "./presentation/app-create-wizard";
export {
  AppIconPicker,
  AppIconPickerField,
} from "./presentation/app-icon-picker";
export {
  AppIdentityEditor as AppIdentityForm,
  type AppIdentityDraft,
} from "./presentation/app-identity-editor";
export { SettingsAppearancePanel } from "./presentation/settings-appearance-panel";
export { SettingsModePanel } from "./presentation/settings-mode-panel";
export { SettingsAppsPanel } from "./presentation/settings-apps-panel";
export { SettingsKernelPanel } from "./presentation/settings-kernel-panel";
export { SettingsNetworkPanel } from "./presentation/settings-connectivity-panels";
export { SettingsVoicePanel } from "./presentation/settings-voice-panel";
export {
  useI18n as usePresentationLabels,
  type TranslationFn as PresentationTranslate,
} from "./presentation/i18n";

export {
  SettingsDesktopPanel,
  DesktopInfoRow,
  DesktopActionRow,
} from "./presentation/settings-desktop-panel";
export { SettingsUpdatePanel } from "./presentation/settings-update-panel";

export { RoomHeaderActions } from "./presentation/room-header-actions";

export * from "./presentation/settings-providers-panel";
export * from "./presentation/settings-operations-panel";

export * from "./presentation/app-create-dialog";
export * from "./process";

export { StandardFilePreview, createFileCapabilities, FlowPreview, parseFlowPreviewMarkdown, MarkdownPreview, MarkdownProperties, useMarkdownPresentation } from "./files/preview";
export { StandardFileEditor, type StandardFileEditorProps, type StandardFileEditorHandle } from "./files/standard-file-editor";
export type { FilePreviewOperations, MarkdownPreviewProps, MarkdownProperty, MarkdownPropertyDefinition } from "./files/markdown-preview";
export type { FlowData, FlowStep, FlowActivity, FlowLiveTodo } from "./files/flow-types";

export * from "./people";
export * from "./apps/dashboard-primitives";
export * from "./apps/developer-layout";
export * from "./presentation/settings-storage-panel";
export * from "./presentation/settings-provider-picker-dialog";

export * from "./files/selection";
export * from "./files/draft-notices";
export * from "./process/resource-preview-panel";

export * from "./extension-workspaces";

export * from "./publishing";
export * from "./catalog-details";

export * from "./apps/dashboard";
export * from "./apps/mcp-app-frame";

export * from "./presentation/settings-native-desktop-panel";

export * from "./apps/flow-list";
export * from "./presentation/release-notes-markdown";
export * from "./presentation/slash-command-menu";

export * from "./apps/workbench";

export * from "./apps/chat-panel";

export * from "./auth-flows";
export * from "./presentation/titlebar-controls";

export * from "./startup-view";
