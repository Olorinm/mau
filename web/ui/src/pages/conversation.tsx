import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { ChatComposer } from "../index";
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
  /** Follows a message from the same sender: no avatar or author line, a tighter gap. */
  continued?: boolean;
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
  /** "all" is the room-wide mention (@all) offered in groups, as in OpenGrove rooms. */
  kind?: "member" | "all";
  avatar?: ReactNode;
  detail?: ReactNode;
  onSelect(): void;
}
/** A slash command offered when the draft is "/" followed by part of its name. */
export interface ComposerCommand {
  id: string;
  /** Typed after "/", for example "new". */
  name: string;
  description?: string;
  onSelect(): void;
}
export type ConversationComposer = ComponentProps<typeof ChatComposer> & {
  onAttachmentClick?(): void;
  onFiles?(files: File[]): void;
  attachments?: readonly ComposerAttachment[];
  mentions?: readonly ComposerMention[];
  onMentionClick?(): void;
  commands?: readonly ComposerCommand[];
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
  onReachStart,
}: {
  conversationId?: string;
  header?: ReactNode;
  messages: readonly MessageView[];
  composer: ConversationComposer;
  empty?: ReactNode;
  notice?: ReactNode;
  trailing?: ReactNode;
  /**
   * There is more before the first message: called when the reader comes near the top, and again once what it
   * loaded is shown. Left out when the conversation begins with its first message.
   */
  onReachStart?(): unknown;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stream = useRef<HTMLElement>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [activeMention, setActiveMention] = useState(0);
  const mentions: MentionOption[] = (composer.mentions ?? []).map((item) =>
    item.kind === "all"
      ? { id: "all", kind: "all", label: item.label, detail: typeof item.detail === "string" ? item.detail : "" }
      : { id: item.id, kind: "member", label: item.label, avatar: item.avatar },
  );
  // "/" plus part of a name lists the matching commands; Escape hides the list until the draft changes.
  const [hiddenFor, setHiddenFor] = useState<string>();
  const [activeCommand, setActiveCommand] = useState(0);
  const slash = /^\/(\S*)$/.exec(composer.value);
  const commands = slash
    ? (composer.commands ?? []).filter((item) => item.name.startsWith(slash[1]!.toLowerCase()))
    : [];
  const commandOpen = commands.length > 0 && hiddenFor !== composer.value;
  const selectCommand = (command: ComposerCommand) => {
    command.onSelect();
    input.current?.focus();
  };
  const selectMention = (option: MentionOption) => {
    composer.mentions?.find((item) => (option.kind === "all" ? item.kind === "all" : item.id === option.id))?.onSelect();
    setMentionOpen(false);
    input.current?.focus();
  };
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 130)}px`;
  }, [composer.value]);
  // Where the reader is in the stream: at its end, or at a message that stood at a known place. Another conversation
  // shows its end, and so does a message the reader has just sent. Anything else leaves a reader who is not at the end
  // at the message they were reading: messages put before the first one or between the others, and whatever takes its
  // height after it is shown.
  const first = messages[0]?.id, last = messages.at(-1);
  const held = useRef<{ conversationId?: string | undefined; last?: string | undefined; atEnd: boolean; anchor?: { id: string; offset: number } }>({ atEnd: true });
  const offsetOf = (element: HTMLElement, id: string) => {
    const node = element.querySelector(`[data-room-message-id="${CSS.escape(id)}"]`);
    return node ? node.getBoundingClientRect().top - element.getBoundingClientRect().top : undefined;
  };
  /** Remember the first message that reaches into view, and whether the reader is at the end. */
  const look = (element: HTMLElement) => {
    const top = element.getBoundingClientRect().top;
    const node = [...element.querySelectorAll<HTMLElement>("[data-room-message-id]")].find((item) => item.getBoundingClientRect().bottom > top);
    const id = node?.getAttribute("data-room-message-id");
    held.current = { ...held.current, atEnd: element.scrollHeight - element.scrollTop - element.clientHeight < 48,
      ...(node && id ? { anchor: { id, offset: node.getBoundingClientRect().top - top } } : {}) };
  };
  /** Put the reader back where they were: at the end, or at the message they were reading. */
  const keep = (element: HTMLElement) => {
    const { atEnd, anchor } = held.current, now = !atEnd && anchor ? offsetOf(element, anchor.id) : undefined;
    if (atEnd) element.scrollTop = element.scrollHeight;
    else if (now !== undefined) element.scrollTop += now - anchor!.offset;
  };
  const loading = useRef(false);
  const reach = useRef(onReachStart);
  reach.current = onReachStart;
  const nearStart = () => {
    const element = stream.current;
    if (!element || !reach.current || loading.current || element.scrollTop > 160) return;
    loading.current = true;
    // Once what was loaded is shown, the top may still be near: go on. A failure waits for the reader to come back.
    void Promise.resolve().then(() => reach.current?.()).then(() => { loading.current = false; requestAnimationFrame(nearStart); }, () => { loading.current = false; });
  };
  useLayoutEffect(() => {
    const element = stream.current;
    if (!element) return;
    const before = held.current, sent = last?.role === "user" && last.id !== before.last;
    held.current = { ...before, conversationId, last: last?.id, atEnd: before.atEnd || before.conversationId !== conversationId || sent };
    keep(element);
    look(element);
    nearStart();
  }, [messages.length, conversationId, first, last?.id]);
  useEffect(() => {
    const element = stream.current;
    if (!element) return;
    // Where the reader is has to be known before anything else moves the stream: a change of height in the same
    // frame would otherwise put them back where they were before they scrolled.
    const scrolled = () => { look(element); nearStart(); };
    // Messages take their height after they are shown (a rendered answer, an image): the reader stays where they were.
    const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => { keep(element); nearStart(); });
    for (const child of element.children) resized?.observe(child);
    element.addEventListener("scroll", scrolled, { passive: true });
    return () => { element.removeEventListener("scroll", scrolled); resized?.disconnect(); };
  }, [conversationId, messages.length === 0]);
  // More became loadable while the reader was already at the top.
  useEffect(() => { nearStart(); }, [!!onReachStart]);
  const keyboard = useRoomComposerKeyboard<MentionOption | ComposerCommand>({
    mentionMenu: commandOpen
      ? { open: true, activeIndex: Math.min(activeCommand, commands.length - 1) }
      : { open: mentionOpen, activeIndex: activeMention },
    mentionOptions: commandOpen ? commands : mentions,
    moveMentionSelection: (delta) => {
      const length = commandOpen ? commands.length : mentions.length;
      (commandOpen ? setActiveCommand : setActiveMention)((index) =>
        length ? (index + delta + length) % length : 0,
      );
    },
    applyMention: (value) =>
      commandOpen
        ? selectCommand(value as ComposerCommand)
        : selectMention(value as MentionOption),
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
          commandOpen,
          commandOptions: commands.map(({ id, name, description }) => ({ id, name, description })),
          activeCommandIndex: Math.min(activeCommand, commands.length - 1),
          onSelectCommand: (id) => {
            const command = commands.find((item) => item.id === id);
            if (command) selectCommand(command);
          },
          onHoverCommand: setActiveCommand,
          onCommandOpenChange: (open) => {
            if (!open) setHiddenFor(composer.value);
          },
          running: !!composer.running,
          onStop: composer.onStop,
          onDraftChange: (value, cursor) => {
            composer.onChange(value);
            setActiveCommand(0);
            // Typing "@" opens the member picker, as in OpenGrove rooms.
            if (composer.mentions?.length && value[cursor - 1] === "@") {
              setActiveMention(0);
              setMentionOpen(true);
            }
          },
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
            if (event.key === "Escape" && commandOpen) {
              event.preventDefault();
              setHiddenFor(composer.value);
              return;
            }
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
