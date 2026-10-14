import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
} from "lucide-react";
import type {
  AgentEventRecord,
  ApprovalRecord,
  BridgeSettings,
  ExecutionRecord,
  RunRecord,
  SkillRecord,
} from "../../bridge";
import { formatDate } from "../../format";
import { EmptyState } from "../ui/empty-state";
import { translate, useI18n } from "../../i18n";
import type { TranslationFn } from "../../i18n";
import { compactIdentifier } from "./system-views";
import "./ops-center-view.css";

type OpsCenterProps = {
  runs: RunRecord[];
  executions: ExecutionRecord[];
  approvals: ApprovalRecord[];
  events: AgentEventRecord[];
  skills: SkillRecord[];
  tools: Record<string, unknown>[];
  settings?: BridgeSettings;
  contextRecords?: Record<string, unknown>[];
  onOpenApprovals?(): void;
};

type RunSourceId = "agent" | "rooms" | "system";


export function OpsCenterSettingsPanel(
  props: {
    selectedRunId: string;
    onSelectRun(runId: string): void;
  } & OpsCenterProps,
) {
  const { t } = useI18n();
  const pendingApprovals = props.approvals.filter((approval) => approval.status === "pending");
  const allRuns = sortRunsNewestFirst(props.runs);
  const fallbackRunId = allRuns[0] ? runRecordKey(allRuns[0]) : "";
  const activeRunId =
    props.selectedRunId && allRuns.some((run) => runRecordKey(run) === props.selectedRunId)
      ? props.selectedRunId
      : fallbackRunId;
  const failedRuns = allRuns.filter((run) => isFailedStatus(runTaskState(run))).length;
  const runningRuns = allRuns.filter((run) => isRunningStatus(runTaskState(run))).length;
  const latestRun = allRuns[0];

  return (
    <div className="ops-settings-page">
      <section className="ops-settings-hero" aria-label={t("ops.overview")}>
        <div className="ops-settings-metric-grid" aria-label={t("ops.metrics")}>
          <OpsMetricTile
            label={t("ops.runs")}
            value={String(allRuns.length)}
            meta={
              latestRun
                ? `${t("ops.latest")} ${formatDate(String(latestRun.finishedAt || latestRun.startedAt || latestRun.createdAt || ""))}`
                : t("ops.noRunShort")
            }
          />
          <OpsMetricTile
            label={t("ops.failures")}
            value={String(failedRuns)}
            meta={runningRuns ? t("ops.runningCount", { count: runningRuns }) : t("ops.noFailedRuns")}
            tone={failedRuns ? "danger" : "good"}
          />
          <OpsMetricTile
            label={t("ops.approvals")}
            value={String(pendingApprovals.length)}
            meta={pendingApprovals.length ? t("ops.awaitingAction") : t("ops.noPendingApproval")}
            tone={pendingApprovals.length ? "warning" : "good"}
            onClick={pendingApprovals.length ? props.onOpenApprovals : undefined}
          />
          <OpsMetricTile
            label={t("ops.events")}
            value={String(props.events.length)}
            meta={`${props.executions.length} ${t("ops.executions")}`}
          />
        </div>
      </section>

      <section className="ops-settings-run-log" aria-label={t("ops.recentRuns")}>
        <header className="ops-settings-log-head">
          <div>
            <h2>{t("ops.recentRuns")}</h2>
          </div>
          <span>{allRuns.length}</span>
        </header>

        <div className="ops-settings-run-list">
          {allRuns.length ? (
            allRuns.map((run, index) => {
              const runId = runRecordKey(run) || `run-${index}`;
              return (
                <OpsSettingsRunItem
                  t={t}
                  contextRecords={props.contextRecords ?? []}
                  events={props.events}
                  executions={props.executions}
                  index={index}
                  key={runId}
                  open={runId === activeRunId}
                  run={run}
                  runId={runId}
                  onOpen={props.onSelectRun}
                />
              );
            })
          ) : (
            <EmptyState illustration="grove" title={t("ops.noRunTitle")} description={t("ops.emptyDescription")} />
          )}
        </div>
      </section>
    </div>
  );
}

function OpsSettingsRunItem(props: {
  t: TranslationFn;
  contextRecords: Record<string, unknown>[];
  events: AgentEventRecord[];
  executions: ExecutionRecord[];
  index: number;
  open: boolean;
  run: RunRecord;
  runId: string;
  onOpen(runId: string): void;
}) {
  const t = props.t;
  const runEvents = props.events.filter((event) => event.runId === props.runId);
  const readableEvents = runEvents.filter((event) => event.type !== "assistant.delta");
  const runExecutions = props.executions.filter(
    (execution) => execution.runId === props.runId || execution.id === props.runId,
  );
  const toolEvents = runEvents.filter((event) => event.type === "tool.started" || event.type === "tool.finished");
  const contextRecords = props.contextRecords.filter((record) => String(record.runId || "") === props.runId);
  const finalAnswer = finalModelResponseText(props.run, runEvents);
  const sourceId = runSourceId(props.run);
  const status = localizedStatus(runTaskState(props.run), t);
  const activity = runActivitySignal(props.run, t);
  const date = formatDate(
    String(props.run.finishedAt || props.run.endedAt || props.run.startedAt || props.run.createdAt || ""),
  );
  const storedEventCount = Number(props.run.eventCount || 0);
  const eventCount = runEvents.length || (Number.isFinite(storedEventCount) ? storedEventCount : 0);
  const toolCount = toolEvents.length || (Array.isArray(props.run.toolIds) ? props.run.toolIds.length : 0);
  const stateTone = isFailedStatus(runTaskState(props.run))
    ? "danger"
    : isRunningStatus(runTaskState(props.run))
      ? "live"
      : "good";
  const input = runInput(props.run);

  return (
    <details
      className="ops-settings-run-entry"
      data-state={stateTone}
      open={props.open}
      onToggle={(event) => {
        if (event.currentTarget.open) {
          props.onOpen(props.runId);
        }
      }}
    >
      <summary className="ops-settings-run-summary" title={runMeta(props.run)}>
        <RunStateIcon status={runTaskState(props.run)} />
        <span className="ops-settings-run-summary-main">
          <strong>{runTitle(props.run)}</strong>
          <small>
            {[localizedSourceLabel(sourceId, t), activity?.statusLabel || status, date || t("ops.timeUnknown")]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </span>
        <span className="ops-settings-run-summary-stats">
          <span>{props.run.modelId ? String(props.run.modelId) : t("ops.modelUnknown")}</span>
          <span>
            {String(eventCount)} {t("ops.events")}
          </span>
        </span>
        <ChevronRight className="ops-settings-run-chevron" size={17} />
      </summary>

      <div className="ops-settings-run-detail">
        <div className="ops-settings-detail-facts" aria-label={t("ops.selectedRunMeta")}>
          <span>
            <strong>{t("settings.extensionTableSource")}</strong>
            {localizedSourceLabel(sourceId, t)}
          </span>
          <span>
            <strong>{t("ops.duration")}</strong>
            {runDuration(props.run)}
          </span>
          <span>
            <strong>{t("ops.lastActivity")}</strong>
            {activity?.lastActivityLabel || t("ops.timeUnknown")}
          </span>
          <span>
            <strong>{t("ops.tools")}</strong>
            {String(toolCount)}
          </span>
          <span>
            <strong>Run</strong>
            {compactIdentifier(props.runId)}
          </span>
        </div>

        <section className="ops-settings-detail-section">
          <OpsSettingsTitle title={t("ops.result")} meta={finalAnswer ? t("ops.modelResponse") : t("ops.empty")} />
          <div className="ops-readable-block ops-settings-readable">{finalAnswer || t("ops.noResult")}</div>
        </section>

        <details className="ops-settings-inline-foldout">
          <summary>
            <span>
              <strong>{t("ops.context")}</strong>
            </span>
            <ChevronRight className="ops-settings-foldout-chevron" size={16} />
          </summary>
          <div className="ops-readable-block ops-settings-readable">{input || t("ops.noContext")}</div>
          {contextRecords.length ? (
            <div className="ops-settings-context-records">
              {contextRecords.map((record, index) => (
                <ContextRecordRow key={String(record.runId || record.id || index)} record={record} />
              ))}
            </div>
          ) : null}
        </details>

        <div className="ops-settings-foldout-grid">
          <details className="ops-settings-inline-foldout">
            <summary>
              <span>
                <strong>{t("ops.toolCalls")}</strong>
              </span>
              <small className="ops-settings-foldout-meta">{toolEvents.length}</small>
              <ChevronRight className="ops-settings-foldout-chevron" size={16} />
            </summary>
            <div className="ops-record-list">
              {toolEvents.length ? (
                toolEvents.map((event, index) => (
                  <EventRecordItem key={`${event.type || "tool"}-${event.at || index}`} event={event} index={index} />
                ))
              ) : (
                <EmptyRow label={t("ops.noToolCalls")} />
              )}
            </div>
          </details>

          <details className="ops-settings-inline-foldout">
            <summary>
              <span>
                <strong>{t("ops.executions")}</strong>
              </span>
              <small className="ops-settings-foldout-meta">{runExecutions.length}</small>
              <ChevronRight className="ops-settings-foldout-chevron" size={16} />
            </summary>
            <div className="ops-record-list">
              {runExecutions.length ? (
                runExecutions.map((execution, index) => (
                  <ExecutionRecordItem
                    key={execution.id || execution.runId || index}
                    execution={execution}
                    index={index}
                  />
                ))
              ) : (
                <EmptyRow label={t("ops.noExecutions")} />
              )}
            </div>
          </details>

          <details className="ops-settings-inline-foldout">
            <summary>
              <span>
                <strong>{t("ops.eventStream")}</strong>
              </span>
              <small className="ops-settings-foldout-meta">
                {readableEvents.length}/{runEvents.length}
              </small>
              <ChevronRight className="ops-settings-foldout-chevron" size={16} />
            </summary>
            <div className="ops-record-list">
              {readableEvents.length ? (
                readableEvents.map((event, index) => (
                  <EventRecordItem key={`${event.type || "event"}-${event.at || index}`} event={event} index={index} />
                ))
              ) : (
                <EmptyRow label={t("ops.noReadableEvents")} />
              )}
            </div>
          </details>
        </div>
      </div>
    </details>
  );
}

function RunStateIcon(props: { status?: string }) {
  const state = String(props.status || "unknown").toLowerCase();
  if (state === "task_state_failed" || state === "task_state_canceled" || state === "task_state_rejected") {
    return <AlertCircle className="ops-run-state-icon" data-state={state} size={15} />;
  }
  if (state === "task_state_completed") {
    return <CheckCircle2 className="ops-run-state-icon" data-state="succeeded" size={15} />;
  }
  if (state === "task_state_working") {
    return <CircleDot className="ops-run-state-icon" data-state="running" size={15} />;
  }
  return <Clock3 className="ops-run-state-icon" data-state={state} size={15} />;
}

function EventRecordItem(props: { event: AgentEventRecord; index: number }) {
  return (
    <details className="ops-record-item">
      <summary>
        <RunStateIcon status={eventStatus(props.event)} />
        <span>
          <strong>{eventTitle(props.event)}</strong>
          <small>{eventSummary(props.event) || `event ${props.index + 1}`}</small>
        </span>
        <time>{formatDate(String(props.event.at || ""))}</time>
      </summary>
      <pre className="ops-json-block">{safeJson(props.event)}</pre>
    </details>
  );
}

function ExecutionRecordItem(props: { execution: ExecutionRecord; index: number }) {
  return (
    <details className="ops-record-item">
      <summary>
        <RunStateIcon status={props.execution.status} />
        <span>
          <strong>
            {props.execution.title ||
              props.execution.kind ||
              props.execution.eventType ||
              `Execution ${props.index + 1}`}
          </strong>
          <small>{readableExecutionSummary(props.execution)}</small>
        </span>
        <time>{formatDate(String(props.execution.at || ""))}</time>
      </summary>
      <pre className="ops-json-block">{safeJson(props.execution)}</pre>
    </details>
  );
}

function InfoRow(props: { title: string; meta: string }) {
  return (
    <div className="paper-row small">
      <span>
        <strong>{props.title}</strong>
        <small>{props.meta || "ready"}</small>
      </span>
    </div>
  );
}

function OpsSettingsTitle(props: { title: string; meta: string }) {
  return (
    <header className="ops-settings-section-title">
      <h3>{props.title}</h3>
      <span>{props.meta}</span>
    </header>
  );
}

function OpsMetricTile(props: {
  label: string;
  value: string;
  meta: string;
  tone?: "good" | "warning" | "danger" | "muted";
  onClick?(): void;
}) {
  if (props.onClick) {
    return (
      <button
        className="ops-settings-metric ops-settings-metric-button"
        data-tone={props.tone || "neutral"}
        type="button"
        onClick={props.onClick}
      >
        <span>{props.label}</span>
        <strong>{props.value}</strong>
        <small>{props.meta}</small>
      </button>
    );
  }
  return (
    <div className="ops-settings-metric" data-tone={props.tone || "neutral"}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <small>{props.meta}</small>
    </div>
  );
}

function ContextRecordRow(props: { record: Record<string, unknown> }) {
  const record = props.record;
  const context =
    record.context && typeof record.context === "object" && !Array.isArray(record.context)
      ? (record.context as Record<string, unknown>)
      : {};
  const title = String(record.title || context.summary || record.userInput || "Context snapshot");
  const meta = [
    record.runId ? `run ${compactIdentifier(record.runId)}` : "",
    record.modelId,
    formatDate(String(record.updatedAt || record.finishedAt || record.startedAt || "")),
  ]
    .filter(Boolean)
    .join(" · ");

  return <InfoRow title={summarizeText(title, 96) || "Context snapshot"} meta={meta || "stored"} />;
}

function EmptyRow(props: { label: string }) {
  return <div className="paper-empty-row">{props.label}</div>;
}

function sortRunsNewestFirst(runs: RunRecord[]): RunRecord[] {
  return [...runs].sort((left, right) => recordTimestamp(right) - recordTimestamp(left));
}

function recordTimestamp(record: Record<string, unknown>): number {
  const value = String(
    record.updatedAt || record.finishedAt || record.endedAt || record.at || record.startedAt || record.createdAt || "",
  );
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function runTitle(run: RunRecord): string {
  return summarizeText(runInput(run) || run.summary || run.runId || run.id || "Agent run", 72);
}

function runInput(run: RunRecord): string {
  return String(run.input || "").trim();
}

function runDuration(run: RunRecord): string {
  const startedAt = Date.parse(String(run.startedAt || run.createdAt || ""));
  const finishedAt = Date.parse(String(run.finishedAt || run.endedAt || run.updatedAt || ""));
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return "unknown";
  const seconds = Math.round((finishedAt - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function runMeta(run: RunRecord): string {
  const runId = run.runId || run.id || "";
  const time = run.finishedAt || run.endedAt || run.startedAt || run.createdAt || "";
  return [runTaskState(run) || "unknown", runId ? `run ${compactIdentifier(runId)}` : "", formatDate(time)]
    .filter(Boolean)
    .join(" · ");
}

function runActivitySignal(
  run: RunRecord,
  t: TranslationFn = translate,
): { statusLabel: string; lastActivityLabel: string } | undefined {
  const lastActivityAt = String(run.updatedAt || run.finishedAt || run.endedAt || run.startedAt || run.createdAt || "");
  const timestamp = Date.parse(lastActivityAt);
  if (!Number.isFinite(timestamp)) return undefined;
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const lastActivityLabel = relativeActivityLabel(elapsedMs, t);
  const error = String(run.error || "");
  if (isFailedStatus(runTaskState(run)) && /timed out|timeout/i.test(error)) {
    return { statusLabel: t("ops.statusTimedOut"), lastActivityLabel };
  }
  if (isRunningStatus(runTaskState(run)) && elapsedMs >= 5 * 60_000) {
    return {
      statusLabel: `${t("ops.statusPossiblyStalled")} · ${lastActivityLabel}`,
      lastActivityLabel,
    };
  }
  return { statusLabel: localizedStatus(runTaskState(run), t), lastActivityLabel };
}

function relativeActivityLabel(elapsedMs: number, t: TranslationFn = translate): string {
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 60) return t("ops.justNow");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("ops.minutesAgo", { minutes });
  const hours = Math.floor(minutes / 60);
  return t("ops.hoursAgo", { hours });
}

function runRecordKey(run: RunRecord): string {
  return run.runId || run.id || run.sessionId || String(run.startedAt || run.createdAt || "");
}

function runSourceId(run: RunRecord): RunSourceId {
  const text =
    `${run.runId || ""} ${run.id || ""} ${run.sessionId || ""} ${run.input || ""} ${run.activity || ""}`.toLowerCase();
  if (text.includes("room_run") || text.includes("room member") || text.includes("rooms")) return "rooms";
  if (text.includes("settings") || text.includes("install") || text.includes("capture") || text.includes("diagnostic"))
    return "system";
  return "agent";
}

function localizedSourceLabel(sourceId: RunSourceId, t: TranslationFn = translate): string {
  if (sourceId === "rooms") return t("ops.sourceRooms");
  if (sourceId === "system") return t("source.scope.system");
  return t("ops.sourceAgent");
}

function localizedStatus(status: unknown, t: TranslationFn = translate): string {
  const state = String(status || "unknown").toLowerCase();
  if (state === "task_state_completed") return t("ops.statusSucceeded");
  if (state === "task_state_failed") return t("mountedApp.flowFailed");
  if (state === "task_state_canceled") return t("ops.statusCanceled");
  if (state === "task_state_rejected") return t("ops.statusRejected");
  if (state === "task_state_working") return t("settings.running");
  if (state === "task_state_submitted") return t("ops.statusPending");
  if (state === "task_state_input_required") return t("ops.statusInputRequired");
  if (state === "task_state_auth_required") return t("ops.statusAuthRequired");
  return state === "unknown" ? t("common.unknown") : state;
}

function isFailedStatus(status: unknown): boolean {
  const state = String(status || "").toLowerCase();
  return state === "task_state_failed" || state === "task_state_canceled" || state === "task_state_rejected";
}

function isRunningStatus(status: unknown): boolean {
  const state = String(status || "").toLowerCase();
  return state === "task_state_working" || state === "task_state_submitted";
}

function runTaskState(run: RunRecord): string {
  return String(run.lifecycle?.taskState || "");
}

function finalModelResponseText(run: RunRecord, events: AgentEventRecord[]): string {
  const summary = typeof run.summary === "string" ? run.summary.trim() : "";
  if (summary) return summary;
  for (const event of [...events].reverse()) {
    const text =
      event.type === "assistant.final"
        ? event.text
        : event.type === "model.response" && event.response
          ? event.response.text
          : "";
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  }
  const assistantText = events
    .filter((event) => event.type === "assistant.delta" && typeof event.text === "string")
    .map((event) => event.text)
    .join("");
  return assistantText.trim();
}

function eventTitle(event: AgentEventRecord): string {
  const type = String(event.type || "");
  if (type === "turn.finished") return "Run finished";
  if (type === "turn.started") return "Run started";
  if (type === "model.requested") return "Model request";
  if (type === "model.response") return "Model response";
  if (type === "assistant.final") return "Assistant final";
  if (type === "assistant.status") return "Assistant status";
  if (type === "context.assembled") return "Context assembled";
  if (type === "tool.started") return `Tool started · ${stringField(event, "toolId") || "tool"}`;
  if (type === "tool.finished") return `Tool finished · ${stringField(event, "toolId") || "tool"}`;
  if (type === "skill.discovered") return "Skills discovered";
  if (type === "runtime.diagnostic") return stringField(event, "name") || "Runtime diagnostic";
  if (type === "error") return "Run error";
  return type || "Event";
}

function eventSummary(event: AgentEventRecord): string {
  const type = String(event.type || "");
  if (type === "model.response") return summarizeText(String(event.response?.text || ""), 240) || "response saved";
  if (type === "assistant.final") return summarizeText(String(event.text || ""), 240) || "final answer saved";
  if (type === "assistant.status") return summarizeText(String(event.text || ""), 240) || "status update";
  if (type === "model.requested")
    return (
      summarizeText(stringFromPath(event, ["request", "userInput"]), 240) ||
      stringFromPath(event, ["request", "modelId"]) ||
      "request sent"
    );
  if (type === "context.assembled") return stringFromPath(event, ["context", "summary"]) || "context assembled";
  if (type === "tool.started") return summarizeJson(event.input, 240) || "tool call started";
  if (type === "tool.finished")
    return (
      summarizeJson((event.result as Record<string, unknown> | undefined)?.value, 240) ||
      stringFromPath(event, ["result", "error"]) ||
      "tool call finished"
    );
  if (type === "runtime.diagnostic") return summarizeJson(event.data, 240) || "diagnostic event";
  if (type === "skill.discovered") {
    const skills = Array.isArray(event.skills) ? event.skills : [];
    return (
      skills
        .map((skill) =>
          typeof skill === "object" && skill
            ? String((skill as Record<string, unknown>).name || (skill as Record<string, unknown>).id || "")
            : "",
        )
        .filter(Boolean)
        .slice(0, 6)
        .join(" · ") || `${skills.length} skills`
    );
  }
  if (type === "error") return stringField(event, "message") || "failed";
  return formatDate(String(event.at || "")) || type || "event";
}

function eventStatus(event: AgentEventRecord): string {
  const type = String(event.type || "");
  if (type === "error") return "failed";
  if (type === "tool.finished") {
    const result = event.result && typeof event.result === "object" ? (event.result as Record<string, unknown>) : {};
    return result.ok === false ? "failed" : "succeeded";
  }
  if (type === "tool.started" || type === "model.requested" || type === "assistant.status") return "running";
  return "succeeded";
}

function readableExecutionSummary(execution: ExecutionRecord): string {
  return (
    [execution.status, execution.kind || execution.eventType, summarizeJson(execution.data, 220)]
      .filter(Boolean)
      .join(" · ") || "queued"
  );
}

function summarizeText(value: unknown, maxLength: number): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

function summarizeJson(value: unknown, maxLength: number): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return summarizeText(value, maxLength);
  try {
    return summarizeText(JSON.stringify(value), maxLength);
  } catch {
    return "";
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function stringFromPath(record: Record<string, unknown>, path: string[]): string {
  let value: unknown = record;
  for (const key of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" ? value : "";
}
