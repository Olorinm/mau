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
  Conversation,
  type MessageView,
  type ConversationComposer,
  type ComposerAttachment,
  type ComposerMention,
  type ComposerCommand,
} from "./conversation";
export { Catalog, type CatalogItem } from "./catalog";
export {
  FileEditor,
  type FileEditorProps,
  type FileEditorHandle,
} from "./files/editor";
export { type MarkdownEditorSelection } from "./files/code-editor";
export { SaplingPlaceholder } from "./artwork/sapling";
export { MotionMenu, MotionMenuItem } from "./ui/menu";
export {
  ProfileDialog,
  AppCreateForm,
  AppIdentityEditor,
  AppSettingsDialog,
  type FormTab,
} from "./forms";

export { RoomComposer, type MentionOption } from "./presentation/room-composer";
export { RoomChatSurface } from "./presentation/room-chat-surface";
export { RoomMessageStream } from "./presentation/room-message-stream";
export { MessageFileCard } from "./presentation/message-file-card";
export {
  AppCreateWizard,
  type AppBuilderRequest,
} from "./presentation/app-create-wizard";
export {
  AppIconPicker,
  AppIconPickerField,
} from "./presentation/app-icon-picker";
export {
  useI18n as usePresentationLabels,
  type TranslationFn as PresentationTranslate,
} from "./presentation/i18n";

export { RoomHeaderActions } from "./presentation/room-header-actions";

export * from "./presentation/app-create-dialog";
export * from "./process";
export { StandardFileEditor, type StandardFileEditorProps, type StandardFileEditorHandle } from "./files/standard-file-editor";

export * from "./people";

// The shared page styles load after the components' own CSS modules, so they keep precedence over them.
import "./style.css";
