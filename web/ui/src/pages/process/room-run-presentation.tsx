import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Check, ChevronRight, Square } from 'lucide-react';
import { ActivityRow, Disclosure, type ChatImagePayload } from '../../index';
import { PartnerLink } from './partner-link';
import { AgentStateIndicator, Tooltip, type AgentStatePresentation } from '../../app/index';
import { useI18n, type TranslationFn } from '../presentation/i18n';
import { TextShimmer } from '../ui/text-shimmer';
import { ThreadTextBlock } from './message-markdown';
import type { NotePart } from './parts';
import type { ActivityEntry, createActivityModel } from './activity-model';
import type { AssistantPartGroup, createRunModel } from './run-model';
import type { createActivityPresentation } from './activity-presentation';
import type { ChatResourceAction, ChatResourceContext, ChatResourceRef } from './resource-model';
export type MessageStatus = 'running' | 'done' | 'failed' | 'interrupted' | 'pending';
/**
 * What another partner sent that this reply answers: the first rows of the reply's steps. The caller words it
 * (`before` + `name` + `after` is the row, `summary` its part of the collapsed line) and gives what the row opens.
 */
export interface RunIncoming {
  key: string;
  /** The partner's figure, in the place of a step's icon. */
  icon: ReactNode;
  before: string;
  name: string;
  after: string;
  summary: string;
  /** The message as its partner wrote it, opened from the row; the label names what the chevron opens. */
  content?: ReactNode;
  contentLabel?: string;
  /** What is said of a result that is not a whole answer, and behind it a reason that has no words. */
  note?: string;
  noteTitle?: string;
}
type RoomPartGroup = AssistantPartGroup;
type RoomReplyPreview = { text: string; senderName?: string };
export function createRoomRunPresentation(model: ReturnType<typeof createActivityModel>, run: ReturnType<typeof createRunModel>, presentation: ReturnType<typeof createActivityPresentation>) {
const { choiceFormFromItem, summarizeActivityItems } = model;
const { processGroupsToActivityEntries, processGroupsHaveRunningActivity, isNativeAgentCommentaryNote, isConnectorProcessNote } = run;
const { AssistantProcessBlock, ApprovalInteractionCard, QuestionInteractionCard, renderActivitySummary } = presentation;
function RoomTextBubble(props: {
  text: string;
  isUser: boolean;
  replyPreview?: RoomReplyPreview;
  measureRef?: RefObject<HTMLDivElement | null>;
  onPreviewImage?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  const { t } = useI18n();
  if (!props.text.trim() && !props.replyPreview) return null;
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
      {props.text.trim() ? (
        <RoomTextContent
          text={props.text}
          isUser={props.isUser}
          onPreviewImage={props.onPreviewImage}
          onOpenResource={props.onOpenResource}
          resourceContext={props.resourceContext}
        />
      ) : null}
    </div>
  );
}

function RoomTextContent(props: {
  text: string;
  isUser: boolean;
  onPreviewImage?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  return props.isUser ? (
    <>{props.text}</>
  ) : (
    <ThreadTextBlock
      text={props.text}
      onPreviewImage={props.onPreviewImage}
      onOpenResource={props.onOpenResource}
      resourceContext={props.resourceContext}
    />
  );
}

type RoomRunCancel = { pending: boolean; onCancel(): void };

function RoomRunLeadingControl(props: { presentation?: AgentStatePresentation; cancel?: RoomRunCancel }) {
  const { t } = useI18n();
  const [touchArmed, setTouchArmed] = useState(false);
  const lastPointerTypeRef = useRef("");
  const presentation = props.presentation ?? {
    state: "working",
    label: t("rooms.statusRunning"),
  };
  const indicator = <AgentStateIndicator {...presentation} className="room-run-agent-orb" labelVisible={false} />;
  if (!props.cancel) {
    return <span className="room-run-leading-slot">{indicator}</span>;
  }
  return (
    <Tooltip content={t("rooms.stopRun")} side="right">
      <button
        type="button"
        className={`room-run-leading-slot room-run-leading-control${touchArmed ? " is-touch-armed" : ""}`}
        disabled={props.cancel.pending}
        onPointerDown={(event) => {
          lastPointerTypeRef.current = event.pointerType;
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (lastPointerTypeRef.current === "touch" && !touchArmed) {
            setTouchArmed(true);
            return;
          }
          setTouchArmed(false);
          props.cancel?.onCancel();
        }}
        onBlur={() => setTouchArmed(false)}
        aria-label={t("rooms.stopRun")}
      >
        <span className="room-run-leading-orb" aria-hidden="true">
          {indicator}
        </span>
        <span className="room-run-leading-stop" aria-hidden="true">
          <Square size={13} fill="currentColor" strokeWidth={0} />
        </span>
      </button>
    </Tooltip>
  );
}

/** One message of another partner, as a step of the reply it started: its figure, who it is, and the message on request. */
function RoomIncomingRow({ row }: { row: RunIncoming }) {
  const [open, setOpen] = useState(false);
  return (
    <ActivityRow
      status="complete"
      icon={row.icon}
      title={row.before + row.name + row.after}
      header={
        <>
          <div className="thread-activity-row-title-line">
            <span className="thread-activity-row-title">
              {row.before}
              <PartnerLink name={row.name} />
              {row.after}
            </span>
            {row.content ? (
              <button
                type="button"
                className="thread-activity-edit-diff-toggle"
                aria-expanded={open}
                aria-label={row.contentLabel}
                title={row.contentLabel}
                onClick={() => setOpen((current) => !current)}
              >
                <ChevronRight size={13} strokeWidth={2.1} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          {row.note ? <div className="thread-activity-row-detail" title={row.noteTitle}>{row.note}</div> : null}
          {open && row.content ? <div className="thread-activity-row-message is-rich">{row.content}</div> : null}
        </>
      }
    />
  );
}

type ProcessPlaceholder = {
  label: string;
  content?: ReactNode;
};

function RoomAgentMessageBody(props: {
  /** What another partner sent that this reply answers. */
  incoming?: RunIncoming[];
  placeholder?: ProcessPlaceholder;
  onProcessToggle?(open: boolean): void;
  answerGroups: RoomPartGroup[];
  processGroups: RoomPartGroup[];
  fallbackText: string;
  hasTextPart: boolean;
  status: MessageStatus;
  statusText?: string;
  retry?: { pending: boolean; onRetry(): Promise<void> };
  duration?: string;
  cancel?: RoomRunCancel;
  activeChoiceFormKey?: string;
  pendingQuestionIds?: ReadonlySet<string>;
  onResolveApproval(approvalId: string, action: "approve" | "reject" | "cancel", response?: unknown): void | Promise<unknown>;
  onResolveQuestion(questionId: string, action: "answer" | "decline" | "cancel", response?: unknown): void | Promise<unknown>;
  onInsertPrompt(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onPreviewImage?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
  agentPresentation?: AgentStatePresentation;
}) {
  const { t } = useI18n();
  const shouldRenderFallbackText = props.fallbackText.trim() && !props.hasTextPart;
  const processActivityEntries = processGroupsToActivityEntries(props.processGroups);
  const visibleProcessGroups = props.processGroups.filter((group) =>
    roomPartGroupHasDisplay(group, processActivityEntries),
  );
  const agentStackRef = useRef<HTMLDivElement | null>(null);
  const bubbleMeasureRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const stack = agentStackRef.current;
    const element = bubbleMeasureRef.current;
    if (!stack) return undefined;
    if (!element) {
      stack.style.removeProperty("--room-agent-bubble-width");
      return undefined;
    }

    let frame = 0;
    const updateWidth = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const width = Math.ceil(element.getBoundingClientRect().width);
        if (width > 0) {
          stack.style.setProperty("--room-agent-bubble-width", `${width}px`);
        } else {
          stack.style.removeProperty("--room-agent-bubble-width");
        }
      });
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [props.fallbackText, props.answerGroups, props.hasTextPart, props.status]);

  let measureRefUsed = false;
  const takeMeasureRef = () => {
    if (measureRefUsed) return undefined;
    measureRefUsed = true;
    return bubbleMeasureRef;
  };
  return (
    <div className="room-chat-agent-stack" ref={agentStackRef}>
      {visibleProcessGroups.length || props.incoming?.length || props.placeholder ? (
        <RoomRunDetailsBlock
          incoming={props.incoming}
          placeholder={props.placeholder}
          onProcessToggle={props.onProcessToggle}
          statusText={props.statusText}
          groups={visibleProcessGroups}
          status={props.status}
          duration={props.duration}
          activeChoiceFormKey={props.activeChoiceFormKey}
          pendingQuestionIds={props.pendingQuestionIds}
          onResolveApproval={props.onResolveApproval}
          onResolveQuestion={props.onResolveQuestion}
          onInsertPrompt={props.onInsertPrompt}
          onSubmitPrompt={props.onSubmitPrompt}
          onPreviewImage={props.onPreviewImage}
          onOpenResource={props.onOpenResource}
          resourceContext={props.resourceContext}
          agentPresentation={props.agentPresentation}
          live={false}
        />
      ) : null}
      {props.answerGroups.map((group) =>
        group.type === "text" ? (
          <RoomTextBubble
            key={group.part.id}
            text={group.part.text}
            isUser={false}
            measureRef={takeMeasureRef()}
            onPreviewImage={props.onPreviewImage}
            onOpenResource={props.onOpenResource}
            resourceContext={props.resourceContext}
          />
        ) : group.type === "note" ? (
          <RoomCommentaryBlock
            key={group.part.id}
            part={group.part}
            bubble
            measureRef={takeMeasureRef()}
            onPreviewImage={props.onPreviewImage}
            onOpenResource={props.onOpenResource}
            resourceContext={props.resourceContext}
          />
        ) : group.type === "question" ? (
          <QuestionInteractionCard
            key={group.key}
            part={group.part}
            pendingQuestionIds={props.pendingQuestionIds}
            onResolveQuestion={props.onResolveQuestion}
          />
        ) : group.type === "approval" ? (
          <ApprovalInteractionCard key={group.key} part={group.part} onResolveApproval={props.onResolveApproval} />
        ) : null,
      )}
      {shouldRenderFallbackText ? (
        <RoomTextBubble
          text={props.fallbackText}
          isUser={false}
          measureRef={takeMeasureRef()}
          onPreviewImage={props.onPreviewImage}
          onOpenResource={props.onOpenResource}
          resourceContext={props.resourceContext}
        />
      ) : null}
      {/* One place for "working": below everything the run has shown so far, process or text. */}
      {props.status === "running" ? (
        <div className="room-chat-thinking-row">
          <RoomRunLeadingControl presentation={props.agentPresentation} cancel={props.cancel} />
          <div
            className={props.agentPresentation ? "room-chat-thinking room-chat-agent-live" : "room-chat-thinking"}
            ref={takeMeasureRef()}
          >
            {props.agentPresentation?.label ?? <TextShimmer>{t("rooms.thinking")}</TextShimmer>}
          </div>
        </div>
      ) : null}
      {props.status !== "running" &&
      (props.statusText || props.retry || props.cancel) &&
      !visibleProcessGroups.length && (!props.incoming?.length || props.retry || props.cancel) ? (
        <div className="room-chat-status-row">
          <div className="room-chat-status" data-status={props.status}>
            {props.status === "done" ? <Check size={12} className="room-chat-status-check" aria-hidden="true" /> : null}
            {props.statusText}
          </div>
          {props.retry ? (
            <button
              type="button"
              className="ghost-button"
              disabled={props.retry.pending}
              onClick={() => void props.retry?.onRetry()}
            >
              {props.retry.pending ? t("remoteAgent.connecting") : t("common.retry")}
            </button>
          ) : null}
          {props.cancel ? (
            <button
              type="button"
              className="ghost-button"
              disabled={props.cancel.pending}
              onClick={props.cancel.onCancel}
            >
              {t("rooms.stopRun")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function roomPartGroupHasDisplay(group: RoomPartGroup, activityEntries: ActivityEntry[]): boolean {
  if (group.type === "note") {
    return shouldRenderRoomRunNote(group.part);
  }
  if (group.type === "activity") {
    return roomActivityEntriesForDisplay(group, activityEntries).length > 0;
  }
  return true;
}

function RoomActivityBlock(props: {
  entries: ActivityEntry[];
  activeChoiceFormKey?: string;
  pendingQuestionIds?: ReadonlySet<string>;
  onResolveApproval(approvalId: string, action: "approve" | "reject" | "cancel", response?: unknown): void | Promise<unknown>;
  onResolveQuestion(questionId: string, action: "answer" | "decline" | "cancel", response?: unknown): void | Promise<unknown>;
  onInsertPrompt(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  return (
    <div className="room-chat-tools">
      <AssistantProcessBlock
        entries={props.entries}
        activeChoiceFormKey={props.activeChoiceFormKey}
        renderMode="embedded"
        detailMode="full"
        includeReasoningInSummary={false}
        unwrapEmbeddedList={true}
        showArtifactCards={false}
        pendingQuestionIds={props.pendingQuestionIds}
        onResolveApproval={props.onResolveApproval}
        onResolveQuestion={props.onResolveQuestion}
        onInsertPrompt={props.onInsertPrompt}
        onSubmitPrompt={props.onSubmitPrompt}
        onOpenResource={props.onOpenResource}
        resourceContext={props.resourceContext}
      />
    </div>
  );
}

function RoomCommentaryBlock(props: {
  part: NotePart;
  bubble?: boolean;
  measureRef?: RefObject<HTMLDivElement | null>;
  onPreviewImage?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  return (
    <div
      className={props.bubble ? "room-chat-bubble room-run-commentary" : "room-run-commentary"}
      ref={props.measureRef}
    >
      <ThreadTextBlock
        text={props.part.text}
        onPreviewImage={props.onPreviewImage}
        onOpenResource={props.onOpenResource}
        resourceContext={props.resourceContext}
      />
    </div>
  );
}

function RoomRunDetailsBlock(props: {
  incoming?: RunIncoming[];
  placeholder?: ProcessPlaceholder;
  onProcessToggle?(open: boolean): void;
  groups: RoomPartGroup[];
  status: MessageStatus;
  statusText?: string;
  duration?: string;
  live?: boolean;
  cancel?: RoomRunCancel;
  activeChoiceFormKey?: string;
  pendingQuestionIds?: ReadonlySet<string>;
  onResolveApproval(approvalId: string, action: "approve" | "reject" | "cancel", response?: unknown): void | Promise<unknown>;
  onResolveQuestion(questionId: string, action: "answer" | "decline" | "cancel", response?: unknown): void | Promise<unknown>;
  onInsertPrompt(prompt: string): void;
  onSubmitPrompt?(prompt: string): void;
  onPreviewImage?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
  agentPresentation?: AgentStatePresentation;
}) {
  const { t } = useI18n();
  const activityEntries = processGroupsToActivityEntries(props.groups);
  const items = activityEntries.map((entry) => entry.item);
  const hasPendingApproval = items.some(
    (item) => item.type === "approval" && item.part.approvalStatus === "pending" && item.part.approvalId,
  );
  const hasPendingQuestion = items.some(
    (item) => item.type === "question" && item.part.questionStatus === "pending" && item.part.questionId,
  );
  const hasActiveChoiceForm = activityEntries.some(
    ({ groupKey, item }) => groupKey === props.activeChoiceFormKey && Boolean(choiceFormFromItem(item)),
  );
  const hasRunningActivity = processGroupsHaveRunningActivity(props.groups);
  const live = props.live ?? (props.status === "running" || hasRunningActivity);
  const shouldOpenByDefault = hasPendingQuestion || hasPendingApproval || hasActiveChoiceForm;
  const incoming = props.incoming ?? [];
  // The collapsed line says who wrote in first, then what the reply did, or how it stands when it did not finish.
  const settled = props.status !== "failed" && props.status !== "interrupted";
  const summaryText = [
    ...incoming.map((row) => row.summary),
    ...(live
      ? [t("rooms.statusRunning")]
      : (items.length || incoming.length) && settled
        ? [
            items.length
              ? summarizeActivityItems(items, {
                  pendingQuestion: hasPendingQuestion,
                  pendingApproval: hasPendingApproval,
                  activeChoiceForm: hasActiveChoiceForm,
                  includeReasoning: false,
                })
              : "",
            props.duration,
          ]
        : [props.status === "interrupted" && props.statusText
            ? props.statusText
            : props.placeholder && settled ? props.placeholder.label : roomRunSummaryText(props.status, props.duration, live, t)]),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Disclosure
      variant="room-run"
      active={live}
      defaultOpen={shouldOpenByDefault}
      onToggle={props.onProcessToggle}
      leading={
        live || props.cancel ? (
          <RoomRunLeadingControl presentation={props.agentPresentation} cancel={props.cancel} />
        ) : null
      }
      summary={
        <>
          {!live && incoming[0] ? <span className="room-run-incoming-figure" aria-hidden="true">{incoming[0].icon}</span> : null}
          <span>
            {live ? <TextShimmer>{summaryText}</TextShimmer> : renderActivitySummary(summaryText)}
          </span>
        </>
      }
    >
      {incoming.length ? (
        <div className="room-run-group room-run-group--activity room-run-group--incoming">
          <div className="room-chat-tools">
            <div className="thread-activity-list">
              {incoming.map((row) => (
                <div key={row.key}>
                  <RoomIncomingRow row={row} />
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      {props.placeholder?.content}
      {props.groups.map((group, index) => renderRoomRunGroup(group, props, index, activityEntries))}
    </Disclosure>
  );
}

function renderRoomRunGroup(
  group: RoomPartGroup,
  props: Pick<
    Parameters<typeof RoomRunDetailsBlock>[0],
    | "activeChoiceFormKey"
    | "pendingQuestionIds"
    | "onResolveApproval"
    | "onResolveQuestion"
    | "onInsertPrompt"
    | "onSubmitPrompt"
    | "onPreviewImage"
    | "onOpenResource"
    | "resourceContext"
  >,
  index: number,
  activityEntries: ActivityEntry[],
) {
  const staggerStyle = { "--i": index } as CSSProperties;
  if (group.type === "activity") {
    const entries = roomActivityEntriesForDisplay(group, activityEntries);
    if (!entries.length) return null;
    return (
      <div className="room-run-group room-run-group--activity" key={group.key} style={staggerStyle}>
        <RoomActivityBlock
          entries={entries}
          activeChoiceFormKey={props.activeChoiceFormKey}
          pendingQuestionIds={props.pendingQuestionIds}
          onResolveApproval={props.onResolveApproval}
          onResolveQuestion={props.onResolveQuestion}
          onInsertPrompt={props.onInsertPrompt}
          onSubmitPrompt={props.onSubmitPrompt}
          onOpenResource={props.onOpenResource}
          resourceContext={props.resourceContext}
        />
      </div>
    );
  }
  if (group.type === "note") {
    if (!shouldRenderRoomRunNote(group.part)) return null;
    if (isCompactionNoteTone(group.part.tone)) {
      const active = group.part.tone === "compaction-started";
      return (
        <div
          key={group.part.id}
          className={`room-run-group thread-compaction-divider${active ? " is-active" : ""}`}
          style={staggerStyle}
        >
          {active ? <TextShimmer>{group.part.text}</TextShimmer> : <span>{group.part.text}</span>}
        </div>
      );
    }
    return (
      <div className="room-run-group" key={group.part.id} style={staggerStyle}>
        <RoomRunNoteRow
          part={group.part}
          onPreviewImage={props.onPreviewImage}
          onOpenResource={props.onOpenResource}
          resourceContext={props.resourceContext}
        />
      </div>
    );
  }
  return null;
}

function roomActivityEntriesForDisplay(
  group: Extract<RoomPartGroup, { type: "activity" }>,
  activityEntries: ActivityEntry[],
): ActivityEntry[] {
  return activityEntries.filter(({ groupKey }) => groupKey === group.key);
}

function shouldRenderRoomRunNote(part: NotePart): boolean {
  return Boolean(roomRunNoteDisplayText(part));
}

function RoomRunNoteRow(props: {
  part: NotePart;
  onPreviewImage?(image: ChatImagePayload): void;
  onOpenResource?(resource: ChatResourceRef, action?: ChatResourceAction): void;
  resourceContext?: ChatResourceContext;
}) {
  const { t } = useI18n();
  const displayText = roomRunNoteDisplayText(props.part);
  if (!displayText) {
    return null;
  }
  if (isNativeAgentCommentaryNote(props.part)) {
    return (
      <RoomCommentaryBlock
        part={displayText === props.part.text ? props.part : { ...props.part, text: displayText }}
        onPreviewImage={props.onPreviewImage}
        onOpenResource={props.onOpenResource}
        resourceContext={props.resourceContext}
      />
    );
  }
  return (
    <div className={`room-run-detail-row tone-${props.part.tone || "muted"}`}>
      <span>{roomNoteToneLabel(props.part, t)}</span>
      <strong>{displayText}</strong>
    </div>
  );
}

function roomRunNoteDisplayText(part: NotePart): string {
  const text = part.text.trim();
  if (/^claude\.sdk\.hook_(?:started|progress|response)$/i.test(text)) {
    return "";
  }
  return text;
}

function isCompactionNoteTone(tone: string | undefined): boolean {
  return tone === "compaction-started" || tone === "compaction-finished";
}

function roomNoteToneLabel(part: NotePart, t: TranslationFn): string {
  const tone = part.tone;
  if (tone === "diagnostic" && isConnectorProcessNote(part.text)) return t("rooms.noteToneProcess");
  if (tone === "guidance") return t("composer.guide");
  if (tone === "status") return t("commands.statusTitle");
  if (tone === "diagnostic") return t("rooms.noteToneDiagnostic");
  if (tone === "error") return t("rooms.noteToneError");
  if (tone === "warn") return t("rooms.noteToneWarn");
  if (tone === "success") return t("ops.result");
  return t("rooms.noteToneLog");
}

function roomRunSummaryText(
  status: MessageStatus,
  duration: string | undefined,
  live: boolean,
  t: TranslationFn,
): string {
  if (live || status === "running") return t("chat.processing");
  const label =
    status === "failed"
      ? t("rooms.runFailed")
      : status === "interrupted"
        ? t("contacts.runStatusInterrupted")
        : t("rooms.runProcessed");
  return `${label}${duration ? ` ${duration}` : ""}`;
}


return { RoomAgentMessageBody, RoomRunDetailsBlock, RoomRunLeadingControl };
}
