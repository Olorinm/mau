// Extracted from web/src/components/rooms/room-message-stream.tsx at 8b365ed. See source-manifest.json for boundary changes.
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { ProductIcon, Tooltip } from "@olorinm/agent-ui/app";
import {
  MotionMenu,
  MotionContextMenu,
  MotionMenuItem,
  MotionMenuSeparator,
} from "../ui/menu";
import type { MessageView } from "../conversation";
import { useI18n } from "./i18n";
const MESSAGE_TOOLBAR_GAP = 8;
type RoomMessageToolbarPlacement = "right" | "top";
export function RoomMessageStream({
  messages,
  empty,
  trailing,
}: {
  messages: readonly MessageView[];
  empty?: ReactNode;
  trailing?: ReactNode;
}) {
  let previousDayKey = "";
  return (
    <div className="room-chat-stream">
      {messages.map((message) => {
        const dayKey =
          message.dateKey ??
          (typeof message.dateLabel === "string"
            ? message.dateLabel
            : message.id);
        const showDaySeparator = Boolean(
          message.dateLabel && dayKey !== previousDayKey,
        );
        if (dayKey) previousDayKey = dayKey;
        return (
          <Fragment key={message.id}>
            {showDaySeparator ? (
              <div className="room-chat-date-separator" data-day={dayKey}>
                {message.dateLabel}
              </div>
            ) : null}
            <RoomMessageItem message={message} />
          </Fragment>
        );
      })}
      {trailing}
      {messages.length ? null : empty}
    </div>
  );
}
export function RoomMessageItem({ message }: { message: MessageView }) {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();
  const senderDisplayName =
    typeof message.title === "string" ? message.title : "";
  const isUser = message.role === "user";
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [actionSurfaceActive, setActionSurfaceActive] = useState(false);
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarPlacement, setToolbarPlacement] =
    useState<RoomMessageToolbarPlacement>("right");
  const [toolbarStyle, setToolbarStyle] = useState<CSSProperties>();
  const statusText = message.status;
  const isTimeOnlyStatus = !message.state;
  const canMentionAuthor = !!message.onMention;
  const canReply = !!message.onReply;
  const canDelete = !!message.onDelete;
  const canCopy = !!message.copyText;
  const copyText = message.copyText ?? "";
  const canDownload = !!message.onDownload;
  const downloadPending = !!message.downloadPending;
  const hasMessageActions = canReply || canDelete || canCopy || canDownload;
  const shouldMeasureMessageActions =
    hasMessageActions &&
    (actionSurfaceActive || contextMenuOpen || overflowMenuOpen);

  useLayoutEffect(() => {
    if (!shouldMeasureMessageActions) return;
    const content = contentRef.current;
    const toolbar = toolbarRef.current;
    if (!content || !toolbar) return;
    const stream = content.closest<HTMLElement>(".room-chat-stream");
    const updatePlacement = () => {
      if (content.querySelector('.og-disclosure-panel[data-animating="true"]'))
        return;
      const contentRect = content.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      const anchor =
        content.querySelector<HTMLElement>(".room-chat-bubble") ??
        content.querySelector<HTMLElement>(".room-message-attachments") ??
        content.querySelector<HTMLElement>(".room-chat-agent-stack");
      const anchorRect = anchor?.getBoundingClientRect() ?? contentRect;
      const boundaryRight =
        stream?.getBoundingClientRect().right ?? window.innerWidth;
      const availableRight = boundaryRight - anchorRect.right;
      const nextPlacement: RoomMessageToolbarPlacement =
        availableRight >= toolbarRect.width + MESSAGE_TOOLBAR_GAP
          ? "right"
          : "top";
      setToolbarPlacement((current) =>
        current === nextPlacement ? current : nextPlacement,
      );
      const nextStyle: CSSProperties =
        nextPlacement === "right"
          ? {
              left: anchorRect.right - contentRect.left + MESSAGE_TOOLBAR_GAP,
              top: anchorRect.top - contentRect.top,
            }
          : {
              right: Math.max(0, contentRect.right - anchorRect.right),
              top: anchorRect.top - contentRect.top - 6,
            };
      setToolbarStyle((current) =>
        current?.left === nextStyle.left &&
        current?.right === nextStyle.right &&
        current?.top === nextStyle.top
          ? current
          : nextStyle,
      );
    };
    updatePlacement();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updatePlacement);
    observer?.observe(content);
    observer?.observe(toolbar);
    if (stream) observer?.observe(stream);
    content.addEventListener(
      "agent-ui:disclosure-motion-settled",
      updatePlacement,
    );
    window.addEventListener("resize", updatePlacement);
    return () => {
      observer?.disconnect();
      content.removeEventListener(
        "agent-ui:disclosure-motion-settled",
        updatePlacement,
      );
      window.removeEventListener("resize", updatePlacement);
    };
  }, [shouldMeasureMessageActions]);

  if (message.role === "system")
    return (
      <div className="room-chat-system" data-room-message-id={message.id}>
        {message.content}
      </div>
    );
  const handleMessageContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (!hasMessageActions) return;
    if (shouldIgnoreMessageContextMenu(event.target)) {
      (
        event as MouseEvent<HTMLElement> & { preventBaseUIHandler?(): void }
      ).preventBaseUIHandler?.();
      return;
    }
    event.stopPropagation();
  };

  const messageArticle = (
    <article
      className={
        isUser ? "room-chat-message from-user" : "room-chat-message from-agent"
      }
      data-context-menu-open={contextMenuOpen ? "true" : undefined}
      data-overflow-menu-open={overflowMenuOpen ? "true" : undefined}
      data-action-surface-active={actionSurfaceActive ? "true" : "false"}
      data-room-message-id={message.id}
      data-status={message.state}
      tabIndex={hasMessageActions ? 0 : undefined}
      onContextMenu={handleMessageContextMenu}
      onPointerEnter={() => setActionSurfaceActive(true)}
      onPointerLeave={() => setActionSurfaceActive(false)}
      onFocusCapture={() => setActionSurfaceActive(true)}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (
          !(nextTarget instanceof Node) ||
          !event.currentTarget.contains(nextTarget)
        ) {
          setActionSurfaceActive(false);
        }
      }}
    >
      {!isUser ? (
        message.onAuthorClick ? (
          <Tooltip content={t("employee.profileSettingsTitle")} side="right">
            <button
              className="room-chat-avatar-button"
              type="button"
              onClick={() => message.onAuthorClick?.()}
              aria-label={t("employee.openSettingsFor", {
                name: senderDisplayName,
              })}
            >
              <>{message.avatar}</>
            </button>
          </Tooltip>
        ) : (
          <>{message.avatar}</>
        )
      ) : null}
      <div ref={contentRef} className="room-chat-content">
        {!isUser ? (
          <div className="room-chat-author">
            {canMentionAuthor ? (
              <motion.button
                className="room-chat-author-name"
                type="button"
                aria-label={t("rooms.mentionNamed", {
                  name: senderDisplayName,
                })}
                initial="rest"
                animate="rest"
                whileHover="active"
                whileFocus="active"
                onClick={(event) => {
                  event.stopPropagation();
                  message.onMention?.();
                }}
              >
                <motion.span
                  className="room-chat-author-mention-mark"
                  aria-hidden="true"
                  variants={{
                    rest: { width: 0, opacity: 0, x: 4 },
                    active: { width: "1.125em", opacity: 1, x: 0 },
                  }}
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : { duration: 0.18, ease: "easeOut" }
                  }
                >
                  @
                </motion.span>
                <>{message.title}</>
              </motion.button>
            ) : (
              <strong>
                <>{message.title}</>
              </strong>
            )}
            <span className="room-chat-time">{message.subtitle}</span>
          </div>
        ) : null}
        {!isUser ? (
          message.body ?? (
          <div className="room-chat-agent-stack">
            {message.activity}
            <RoomTextBubble isUser={false}>{message.content}</RoomTextBubble>
            {message.status ? (
              <div className="room-chat-status-row">
                <div className="room-chat-status">{message.status}</div>
              </div>
            ) : null}
          </div>
          )
        ) : (
          <RoomTextBubble isUser={isUser} replyPreview={message.reply}>
            {message.content}
          </RoomTextBubble>
        )}
        {message.attachments}
        {message.actions}
        {isUser && statusText ? (
          <div
            className="room-chat-status"
            data-kind={isTimeOnlyStatus ? "time" : "status"}
            data-status={message.state}
          >
            {statusText}
          </div>
        ) : null}
        {hasMessageActions ? (
          <RoomMessageToolbar
            toolbarRef={toolbarRef}
            placement={toolbarPlacement}
            style={toolbarStyle}
            canReply={canReply}
            canCopy={canCopy}
            canDelete={canDelete}
            canDownload={canDownload}
            downloadPending={downloadPending}
            copyText={copyText}
            onReply={() => message.onReply?.()}
            onDelete={() => message.onDelete?.()}
            onDownload={message.onDownload ?? (() => undefined)}
            onMenuOpenChange={setOverflowMenuOpen}
          />
        ) : null}
      </div>
    </article>
  );
  if (!hasMessageActions && !message.menuActions?.length) return messageArticle;
  return (
    <MotionContextMenu
      open={contextMenuOpen}
      onOpenChange={setContextMenuOpen}
      trigger={messageArticle}
    >
      {canReply ? (
        <MotionMenuItem onClick={message.onReply}>
          <ProductIcon name="reply" size={15} />
          <span>{t("rooms.reply")}</span>
        </MotionMenuItem>
      ) : null}
      {canCopy ? (
        <MotionMenuItem
          onClick={() => void navigator.clipboard.writeText(copyText)}
        >
          <ProductIcon name="copy" size={15} />
          <span>{t("common.copy")}</span>
        </MotionMenuItem>
      ) : null}
      {canDownload ? (
        <MotionMenuItem disabled={downloadPending} onClick={message.onDownload}>
          <ProductIcon name="download" size={15} />
          <span>{t("common.download")}</span>
        </MotionMenuItem>
      ) : null}
      {canDelete ? (
        <MotionMenuItem danger onClick={message.onDelete}>
          <ProductIcon name="delete" size={15} />
          <span>{t("common.delete")}</span>
        </MotionMenuItem>
      ) : null}
      {message.menuActions?.map((action) => (
        <MotionMenuItem
          key={action.id}
          disabled={action.disabled}
          onClick={action.onSelect}
        >
          {action.icon}
          <span>{action.label}</span>
        </MotionMenuItem>
      ))}
    </MotionContextMenu>
  );
}
function RoomTextBubble(props: {
  children: ReactNode;
  isUser: boolean;
  replyPreview?: { senderName?: string; text: string };
  measureRef?: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  if (!props.children && !props.replyPreview) return null;
  return (
    <div className="room-chat-bubble" ref={props.measureRef}>
      {props.isUser && props.replyPreview ? (
        <blockquote
          className="room-chat-reply-quote"
          title={props.replyPreview.text}
          aria-label={
            props.replyPreview.senderName
              ? t("rooms.replyingTo", { name: props.replyPreview.senderName })
              : props.replyPreview.text
          }
        >
          {props.replyPreview.text}
        </blockquote>
      ) : null}
      {props.children}
    </div>
  );
}
function RoomMessageToolbar(props: {
  toolbarRef: RefObject<HTMLDivElement | null>;
  placement: RoomMessageToolbarPlacement;
  style?: CSSProperties;
  canReply: boolean;
  canCopy: boolean;
  canDelete: boolean;
  canDownload: boolean;
  downloadPending: boolean;
  copyText: string;
  onReply(): void;
  onDelete(): void;
  onDownload(): void;
  onMenuOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null)
        window.clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(props.copyText);
      setCopied(true);
      if (copiedTimerRef.current !== null)
        window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // non-critical-fallback: Clipboard failure clears the transient copied indicator.
      setCopied(false);
    }
  };

  return (
    <div
      ref={props.toolbarRef}
      className="room-message-toolbar"
      data-placement={props.placement}
      style={props.style}
      role="toolbar"
      aria-label={t("rooms.messageActions")}
    >
      {props.canReply ? (
        <Tooltip content={t("rooms.reply")}>
          <button
            type="button"
            className="room-message-toolbar-button"
            aria-label={t("rooms.reply")}
            onClick={(event) => {
              event.stopPropagation();
              props.onReply();
            }}
          >
            <ProductIcon name="reply" size={15} />
          </button>
        </Tooltip>
      ) : null}
      {props.canCopy ? (
        <Tooltip content={copied ? t("common.copied") : t("common.copy")}>
          <button
            type="button"
            className="room-message-toolbar-button"
            aria-label={copied ? t("common.copied") : t("common.copy")}
            onClick={(event) => {
              event.stopPropagation();
              void handleCopy();
            }}
          >
            <ProductIcon name={copied ? "check" : "copy"} size={15} />
          </button>
        </Tooltip>
      ) : null}
      {props.canDelete || props.canDownload ? (
        <MotionMenu
          open={moreMenuOpen}
          onOpenChange={(open) => {
            setMoreMenuOpen(open);
            props.onMenuOpenChange(open);
          }}
          side="bottom"
          align="end"
          ariaLabel={t("rooms.messageActions")}
          size="compact"
          tooltipContent={t("rooms.moreActions")}
          trigger={
            <button
              type="button"
              className="room-message-toolbar-button"
              aria-label={t("rooms.moreActions")}
              onClick={(event) => event.stopPropagation()}
            >
              <ProductIcon name="more" size={15} />
            </button>
          }
        >
          {props.canDownload ? (
            <MotionMenuItem
              disabled={props.downloadPending}
              closeOnClick={!props.downloadPending}
              onClick={props.onDownload}
            >
              <ProductIcon
                name={props.downloadPending ? "loading" : "download"}
                size={15}
              />
              <span>
                {props.downloadPending
                  ? t("rooms.downloadPending")
                  : t("common.download")}
              </span>
            </MotionMenuItem>
          ) : null}
          {props.canDownload && props.canDelete ? (
            <MotionMenuSeparator />
          ) : null}
          {props.canDelete ? (
            <MotionMenuItem danger onClick={props.onDelete}>
              <ProductIcon name="delete" size={15} />
              <span>{t("common.delete")}</span>
            </MotionMenuItem>
          ) : null}
        </MotionMenu>
      ) : null}
    </div>
  );
}
function shouldIgnoreMessageContextMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      [
        "[data-resource-reference='true']",
        "a[href]",
        "button",
        "input",
        "textarea",
        "select",
        "summary",
        "[role='button']",
        "[role='menuitem']",
      ].join(","),
    ),
  );
}
