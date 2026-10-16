import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { ChatComposer } from "@olorinm/agent-ui";
import { useRoomComposerKeyboard } from "./presentation/use-room-composer-keyboard";
import { RoomChatSurface } from "./presentation/room-chat-surface";
import { RoomMessageStream } from "./presentation/room-message-stream";
import type { MentionOption } from "./presentation/room-composer";
import type { MenuAction } from "./shell";

/** Display values, with no account, transport or kernel event schema. */
export interface MessageView {
  id: string;
  role: string;
  title?: ReactNode;
  avatar?: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  state?: string;
  content?: ReactNode;
  /** Complete assistant body with its own bubbles (for example RunMessage). */
  body?: ReactNode;
  activity?: ReactNode;
  attachments?: ReactNode;
  actions?: ReactNode;
  menuActions?: readonly MenuAction[];
  dateLabel?: ReactNode;
  dateKey?: string;
  copyText?: string;
  reply?: { senderName?: string; text: string };
  onAuthorClick?(): void;
  onMention?(): void;
  onReply?(): void;
  onDelete?(): void;
  onDownload?(): void;
  downloadPending?: boolean;
}
export interface ComposerAttachment {
  id: string;
  name: string;
  kind?: "image" | "text" | "file";
  previewUrl?: string;
  detail?: string;
  onRemove(): void;
}
export interface ComposerMention {
  id: string;
  label: string;
  avatar?: ReactNode;
  detail?: ReactNode;
  onSelect(): void;
}
export type ConversationComposer = ComponentProps<typeof ChatComposer> & {
  onAttachmentClick?(): void;
  onFiles?(files: File[]): void;
  attachments?: readonly ComposerAttachment[];
  mentions?: readonly ComposerMention[];
  onMentionClick?(): void;
  reply?: { title: string; text: string; onCancel(): void };
};

/** State adapter for the extracted room components. It contains no alternative page markup. */
export function Conversation({
  header,
  messages,
  composer,
  empty,
  notice,
  trailing,
  conversationId,
}: {
  conversationId?: string;
  header?: ReactNode;
  messages: readonly MessageView[];
  composer: ConversationComposer;
  empty?: ReactNode;
  notice?: ReactNode;
  trailing?: ReactNode;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stream = useRef<HTMLElement>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [activeMention, setActiveMention] = useState(0);
  const mentions: MentionOption[] = (composer.mentions ?? []).map((item) => ({
    id: item.id,
    kind: "member",
    label: item.label,
    avatar: item.avatar,
  }));
  const selectMention = (option: MentionOption) => {
    composer.mentions?.find((item) => item.id === option.id)?.onSelect();
    setMentionOpen(false);
    input.current?.focus();
  };
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 130)}px`;
  }, [composer.value]);
  useLayoutEffect(() => {
    if (stream.current) stream.current.scrollTop = stream.current.scrollHeight;
  }, [messages.length, conversationId]);
  const keyboard = useRoomComposerKeyboard({
    mentionMenu: { open: mentionOpen, activeIndex: activeMention },
    mentionOptions: mentions,
    moveMentionSelection: (delta) =>
      setActiveMention((index) =>
        mentions.length
          ? (index + delta + mentions.length) % mentions.length
          : 0,
      ),
    applyMention: selectMention,
    sendDraft: () => {
      if (
        !composer.disabled &&
        (composer.value.trim() || composer.attachments?.length)
      )
        composer.onSend();
    },
  });
  return (
    <>
      {header}
      <RoomChatSurface
        streamRef={stream}
        composer={{
          inputRef: input,
          fileInputRef: fileInput,
          roomTitle: "",
          placeholder: composer.placeholder,
          draft: composer.value,
          disabled: composer.disabled,
          canSend:
            !composer.disabled &&
            !!(composer.value.trim() || composer.attachments?.length),
          attachments: (composer.attachments ?? []).map((item) => ({
            id: item.id,
            name: item.name,
            kind: item.kind ?? "file",
            previewUrl: item.previewUrl,
            description: item.detail,
          })),
          replyPreview: composer.reply
            ? { senderName: composer.reply.title, text: composer.reply.text }
            : undefined,
          mentionsEnabled:
            !!composer.mentions?.length || !!composer.onMentionClick,
          attachmentsEnabled:
            !!composer.onAttachmentClick || !!composer.onFiles,
          mentionOpen,
          mentionOptions: mentions,
          activeMentionIndex: activeMention,
          onDraftChange: (value) => composer.onChange(value),
          onOpenAttachmentPicker: () =>
            composer.onAttachmentClick
              ? composer.onAttachmentClick()
              : fileInput.current?.click(),
          onAttachmentInputChange: (event) => {
            composer.onFiles?.(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = "";
          },
          onRemoveAttachment: (id) =>
            composer.attachments?.find((item) => item.id === id)?.onRemove(),
          onCancelReply: () => composer.reply?.onCancel(),
          onPaste: (event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length && composer.onFiles && !composer.disabled) {
              event.preventDefault();
              composer.onFiles(files);
            }
          },
          onCompositionStart: keyboard.onCompositionStart,
          onCompositionEnd: keyboard.onCompositionEnd,
          onOpenMention: () => {
            if (composer.mentions?.length) {
              setActiveMention(0);
              setMentionOpen((open) => !open);
            } else composer.onMentionClick?.();
          },
          onMentionOpenChange: setMentionOpen,
          onHoverMention: setActiveMention,
          onSelectMention: selectMention,
          onKeyDown: (event) => {
            if (event.key === "Escape" && mentionOpen) {
              event.preventDefault();
              setMentionOpen(false);
              return;
            }
            keyboard.onKeyDown(event);
          },
          onSend: composer.onSend,
        }}
      >
        {notice}
        <RoomMessageStream
          messages={messages}
          empty={empty}
          trailing={trailing}
        />
      </RoomChatSurface>
    </>
  );
}
