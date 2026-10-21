import {ResourceOperationsProvider,type ResourceOperations} from "./resource-operations";
import { useMemo, type ComponentProps } from "react";
import { useI18n } from "../presentation/i18n";
import { createActivityModel } from "./activity-model";
import { createRunModel } from "./run-model";
import { createActivityPresentation } from "./activity-presentation";
import { createRoomRunPresentation } from "./room-run-presentation";
import { SharedChatProvider } from "./shared-chat-provider";
import type { MessagePart } from "./parts";

/** Locale-bound functions and component identities remain stable across streaming updates.
 * The original presentation operates on display records, with no service or storage access.
 */
export function useRunPresentation(resolveArtifactUrl?: ResourceOperations["resolveArtifactUrl"]) {
  const { t } = useI18n();
  return useMemo(() => {
    const activity = createActivityModel(t, {resolveArtifactUrl});
    const run = createRunModel(t, activity);
    const cards = createActivityPresentation(t, activity);
    const room = createRoomRunPresentation(activity, run, cards);
    return { ...activity, ...run, ...cards, ...room };
  }, [t, resolveArtifactUrl]);
}

type BodyProps = ComponentProps<ReturnType<typeof useRunPresentation>["RoomAgentMessageBody"]>;
export type RunMessageProps = Omit<BodyProps, "answerGroups" | "processGroups" | "hasTextPart" | "fallbackText"> & {
  id: string;
  parts: MessagePart[];
  fallbackText?: string;
  resourceOperations?: ResourceOperations;
};

/** Original room presentation, including its own answer bubbles; place in MessageView.body. */
export function RunMessage({ id, parts, fallbackText = "", resourceOperations = {}, ...props }: RunMessageProps) {
  const { splitAssistantPartsForSurface, RoomAgentMessageBody } = useRunPresentation(resourceOperations.resolveArtifactUrl);
  const groups = useMemo(() => splitAssistantPartsForSurface(parts, id), [parts, id, splitAssistantPartsForSurface]);
  return <ResourceOperationsProvider value={resourceOperations}><SharedChatProvider><RoomAgentMessageBody {...props} {...groups}
    fallbackText={fallbackText} hasTextPart={groups.answerGroups.some(group => group.type === "text" && !!group.part.text.trim())} />
  </SharedChatProvider></ResourceOperationsProvider>;
}

export { createActivityModel } from "./activity-model";
export { createRunModel } from "./run-model";
export { ThreadTextBlock } from "./message-markdown";
export { ChatMarkdownRenderer } from "./chat-markdown-renderer";
export { ResourceLink } from "./resource-link";
export { ResourceCardFrame } from "./resource-card";
export { ResourceContextMenu } from "./resource-context-menu";
export type * from "./parts";
export type * from "./resource-model";
export type { ActivityItem, ActivityEntry, ActivityArtifactCard } from "./activity-model";

export * from "./resource-preview-panel";

export type {ResourceOperations} from "./resource-operations";
