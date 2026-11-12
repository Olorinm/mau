// Original release editor and progress UI. Checks, release lifecycle, employee settings and persistence are caller-owned.
import {useEffect, useState, type ReactNode} from "react";
import {AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, Globe2, HardDrive, History, LoaderCircle, Package, Save, ShieldCheck, Upload, XCircle} from "lucide-react";
import {useI18n} from "./presentation/i18n";
import {RoomMemberAvatar} from "./people/member-avatar";
import type {MemberIdentity} from "./people/identity";
import {AppIdentityEditor, type AppIdentityDraft} from "./presentation/app-identity-editor";
export interface PublishEmployeeView extends Omit<MemberIdentity,"id"> {memberId: string; kernel: string; kernelLabel?: string; model: string}
export interface PublishCheckView {id: string; label: string; detail: string; severity: "blocking" | "warning"; status: "passed" | "blocked" | "warning"; repairable?: boolean}
export interface PublishDraftView {
 app: AppIdentityDraft; version: string; latestPublishedVersion?: string; releaseNotes: string; visibility: "public" | "restricted";
 employees: PublishEmployeeView[]; checks: PublishCheckView[];
 identity: {appId: string; packageKey?: string; source: "registry" | "mounted"; appRoot: string; workspaceRoot: string};
}
export interface PublishLocalDraftView {savedAt: string; publishBase?: {version: string}}
export interface PublishBuildFailureView {stage: string; code: string; workflowRunId: string | number}
export interface PublishProgressView {
 state: "publishing" | "blocked" | "needs-retry" | "registry-ready" | "closed" | "published";
 phase: string; visibleStage: "source-upload" | "candidate" | "trusted-build" | "registry" | "local-finalization";
 inProgress: boolean; remoteStatus?: string; version: string; requestId?: string; allowedActions: string[];
 buildFailure?: PublishBuildFailureView;
 blockedRelease?: {id: string; version: string; status: string; requestId?: string; allowedActions: string[]; matchesCurrentRequest?: boolean; buildFailure?: PublishBuildFailureView};
}
export interface PublishFailureDiagnostic {
  candidateStage?: string;
  requestId?: string;
  localBuild?: {
    commandIndex: number;
    argv: string[];
    argvTruncated: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
}

export function AppStorePublishReleaseEditor(props: {
  release: PublishDraftView;
  publishBaseVersion?: string;
  publishBasePending?: boolean;
  publishFormalBasisPending?: boolean;
  renderEmployee(employee: PublishEmployeeView): ReactNode;
  applyToCurrentApp?: boolean;
  pending?: boolean;
  submitError?: string;
  submitDiagnostic?: PublishFailureDiagnostic;
  publishProgress?: PublishProgressView;
  publishRecoveryPending?: boolean;
  publishRecoveryPaused?: boolean;
  publishAbandonPending?: boolean;
  publishResolutionPending?: boolean;
  publishRecoveryBlocked?: boolean;
  localDraft?: PublishLocalDraftView;
  draftPending?: boolean;
  buildContractRepairPending?: boolean;
  draftError?: string;
  canPublish?: boolean;
  publishEnabled?: boolean;
  onBack(): void;
  onChange(release: PublishDraftView, scope?: "draft" | "formal"): void;
  onApplyToCurrentAppChange?(value: boolean): void;
  onSaveDraft(release: PublishDraftView): void;
  onRepairBuildContract?(): void;
  onPublish(release: PublishDraftView, options: { applyToCurrentApp: boolean }): void;
  onRetryPublishBuild?(): void;
  onContinuePublish?(): void;
  onAbandonPublish?(): void;
  onKeepLocalChanges?(): void;
}) {
  const { t } = useI18n();
  const release = props.release;
  const canPublish = props.canPublish !== false;
  const publishEnabled = canPublish && props.publishEnabled !== false;
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const selectedEmployeeIndex = selectedEmployeeId
    ? release.employees.findIndex((employee) => employee.memberId === selectedEmployeeId)
    : -1;
  const selectedEmployee = selectedEmployeeIndex >= 0 ? release.employees[selectedEmployeeIndex] : undefined;
  const checks = release.checks;
  const hasBlockingCheck = checks.some((check) => check.status === "blocked" && check.severity === "blocking");
  const hasUnfinishedPublish = Boolean(props.publishProgress?.inProgress);
  useEffect(() => {
    if (!selectedEmployeeId) return;
    if (release.employees.some((employee) => employee.memberId === selectedEmployeeId)) return;
    setSelectedEmployeeId(null);
  }, [release.employees, selectedEmployeeId]);

  function updateRelease(update: (current: PublishDraftView) => void, scope: "draft" | "formal" = "draft") {
    const next = {...release, app: {...release.app}, identity: {...release.identity}, employees: release.employees.map(employee => ({...employee})), checks: [...release.checks]};
    update(next);
    props.onChange(next, scope);
  }

  return (
    <section
      className="app-store-publish-page"
      aria-label={t(canPublish ? "appStore.release.publishAria" : "appStore.release.manageAria", {
        name: release.app.title,
      })}
    >
      <PublishHeader
        title={release.app.title}
        pending={props.pending}
        publishDisabled={!publishEnabled || hasBlockingCheck || hasUnfinishedPublish}
        onBack={props.onBack}
        onPublish={
          canPublish
            ? () => props.onPublish(release, { applyToCurrentApp: props.applyToCurrentApp === true })
            : undefined
        }
      />

      {props.publishProgress && props.publishProgress.state !== "published" ? (
        <PublishProgressNotice
          progress={props.publishProgress}
          canPublish={canPublish}
          pending={props.publishRecoveryPending === true}
          recoveryPaused={props.publishRecoveryPaused === true}
          abandonPending={props.publishAbandonPending === true}
          resolutionPending={props.publishResolutionPending === true}
          recoveryBlocked={props.publishRecoveryBlocked === true}
          onRetryBuild={props.onRetryPublishBuild}
          onContinue={props.onContinuePublish}
          onAbandon={props.onAbandonPublish}
          onKeepLocalChanges={props.onKeepLocalChanges}
        />
      ) : null}

      {props.submitError ? (
        <div className="app-store-publish-submit-error" role="alert">
          <AlertTriangle size={17} />
          <div>
            <span>{props.submitError}</span>
            {props.submitDiagnostic?.requestId && !props.submitDiagnostic.candidateStage ? (
              <div>
                {t("appStore.release.failureRequestId", {
                  requestId: props.submitDiagnostic.requestId,
                })}
              </div>
            ) : props.submitDiagnostic ? (
              <details>
                <summary>{t("appStore.registryError.details")}</summary>
                {props.submitDiagnostic.candidateStage ? (
                  <div>
                    {t("appStore.release.failureStage", {
                      stage: props.submitDiagnostic.candidateStage,
                    })}
                  </div>
                ) : null}
                {props.submitDiagnostic.requestId ? (
                  <div>
                    {t("appStore.release.failureRequestId", {
                      requestId: props.submitDiagnostic.requestId,
                    })}
                  </div>
                ) : null}
                {props.submitDiagnostic.localBuild ? (
                  <div className="app-store-publish-local-build-diagnostic">
                    <div>
                      {t("appStore.release.localBuildCommand", {
                        index: props.submitDiagnostic.localBuild.commandIndex,
                        command: `${props.submitDiagnostic.localBuild.argv.join(" ")}${
                          props.submitDiagnostic.localBuild.argvTruncated
                            ? t("appStore.release.localBuildArgvTruncated")
                            : ""
                        }`,
                      })}
                    </div>
                    <div>
                      {t("appStore.release.localBuildExitCode", {
                        code: props.submitDiagnostic.localBuild.exitCode,
                      })}
                    </div>
                    {props.submitDiagnostic.localBuild.stdout ? (
                      <section>
                        <strong>
                          {t("appStore.release.localBuildStdout", {
                            truncated: props.submitDiagnostic.localBuild.stdoutTruncated
                              ? t("appStore.release.localBuildTruncated")
                              : "",
                          })}
                        </strong>
                        <pre>{props.submitDiagnostic.localBuild.stdout}</pre>
                      </section>
                    ) : null}
                    {props.submitDiagnostic.localBuild.stderr ? (
                      <section>
                        <strong>
                          {t("appStore.release.localBuildStderr", {
                            truncated: props.submitDiagnostic.localBuild.stderrTruncated
                              ? t("appStore.release.localBuildTruncated")
                              : "",
                          })}
                        </strong>
                        <pre>{props.submitDiagnostic.localBuild.stderr}</pre>
                      </section>
                    ) : null}
                  </div>
                ) : null}
              </details>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="app-store-publish-content">
        <main className="app-store-publish-main">
          {canPublish ? (
            <PublishSection
              title={t("appStore.release.versionInfo")}
              description={t("appStore.release.versionInfoDesc")}
            >
              <div className="app-store-publish-field-group">
                <PublishField
                  label={t("appStore.release.versionLabel")}
                  required
                  hint={
                    props.publishFormalBasisPending
                      ? t("appStore.release.formalBasisPendingHint")
                      : release.latestPublishedVersion
                        ? t("appStore.release.latestVersion", { version: release.latestPublishedVersion })
                        : t("appStore.release.firstVersionHint")
                  }
                >
                  <input
                    value={release.version}
                    onChange={(event) =>
                      updateRelease((current) => {
                        current.version = event.target.value;
                      }, "formal")
                    }
                    placeholder="0.1.0"
                  />
                </PublishField>
                <PublishField
                  label={t("appStore.release.notesLabel")}
                  hint={`${release.releaseNotes.length}/800`}
                  stacked
                >
                  <textarea
                    value={release.releaseNotes}
                    maxLength={800}
                    rows={3}
                    onChange={(event) =>
                      updateRelease((current) => {
                        current.releaseNotes = event.target.value;
                      }, "formal")
                    }
                    placeholder={t("appStore.release.notesPlaceholder")}
                  />
                </PublishField>
              </div>
              <dl className="app-store-publish-identity">
                <ReadOnlyValue
                  label={t("appStore.release.publishBaseLabel")}
                  value={
                    props.publishBasePending
                      ? t("appStore.release.publishBaseLoading")
                      : props.publishBaseVersion
                        ? `v${props.publishBaseVersion}`
                        : t("appStore.release.firstPublishBase")
                  }
                />
                <ReadOnlyValue
                  label={t("appStore.release.registryLatestLabel")}
                  value={
                    props.publishFormalBasisPending
                      ? t("appStore.release.formalBasisPendingValue")
                      : release.latestPublishedVersion
                        ? `v${release.latestPublishedVersion}`
                        : t("appStore.release.registryLatestEmpty")
                  }
                />
              </dl>
            </PublishSection>
          ) : null}

          <PublishSection
            title={t("appStore.release.appInfo")}
            description={t(canPublish ? "appStore.release.appInfoDesc" : "appStore.release.appDraftInfoDesc")}
          >
            <AppIdentityEditor
              value={release.app}
              onChange={(app) =>
                updateRelease((current) => {
                  current.app = app;
                })
              }
            />
          </PublishSection>

          <PublishSection
            title={
              canPublish
                ? t("appStore.release.employeeDefaultsTitle", { count: release.employees.length })
                : t("appStore.release.employeeDraftTitle", { count: release.employees.length })
            }
            description={
              canPublish ? t("appStore.release.employeeDefaultsDesc") : t("appStore.release.employeeDraftDesc")
            }
          >
            {selectedEmployee ? (
              <div className="app-store-publish-employee-settings">
                <button
                  className="app-store-publish-employee-settings-back"
                  type="button"
                  onClick={() => setSelectedEmployeeId(null)}
                >
                  <ArrowLeft size={17} />
                  <span>
                    {canPublish
                      ? t("appStore.release.employeeDefaultsTitle", { count: release.employees.length })
                      : t("appStore.release.employeeDraftTitle", { count: release.employees.length })}
                  </span>
                </button>
                <div className="app-store-publish-employee-settings-surface">
                  {props.renderEmployee(selectedEmployee)}
                </div>
              </div>
            ) : (
              <div className="app-store-publish-employee-list">
                {release.employees.map((employee) => (
                  <button
                    className="app-store-publish-employee-row"
                    key={employee.memberId}
                    type="button"
                    onClick={() => setSelectedEmployeeId(employee.memberId)}
                  >
                    <RoomMemberAvatar
                      member={{...employee, id: employee.memberId}}
                      showStatus={false}
                    />
                    <span>
                      <strong>{employee.name}</strong>
                      <small>
                        {employee.kernelLabel ?? employee.kernel} · {employee.model}
                      </small>
                    </span>
                    <ChevronRight size={17} />
                  </button>
                ))}
              </div>
            )}
          </PublishSection>

          {canPublish ? (
            <PublishSection
              title={t("appStore.release.identityTitle")}
              description={t("appStore.release.identityDesc")}
            >
              <dl className="app-store-publish-identity">
                <ReadOnlyValue label={t("appStore.release.appIdLabel")} value={release.identity.appId} />
                <ReadOnlyValue
                  label={t("appStore.release.packageIdentityLabel")}
                  value={release.identity.packageKey || t("appStore.release.packageIdentityPending")}
                />
                <ReadOnlyValue
                  label={t("appStore.release.sourceLabel")}
                  value={
                    release.identity.source === "registry"
                      ? t("appStore.release.sourceRegistry")
                      : t("appStore.release.sourceMounted")
                  }
                />
                <ReadOnlyValue label={t("appStore.release.appRootLabel")} value={release.identity.appRoot} />
                <ReadOnlyValue label={t("appStore.release.workspaceLabel")} value={release.identity.workspaceRoot} />
              </dl>
            </PublishSection>
          ) : null}
        </main>

        <aside className="app-store-publish-side">
          <PublishSection
            title={t("appStore.release.localDraftTitle")}
            description={t("appStore.release.localDraftDesc")}
            compact
          >
            <div className="app-store-local-draft-card" data-state={props.localDraft ? "saved" : "empty"}>
              <HardDrive size={18} />
              <div>
                <strong>
                  {props.localDraft ? t("appStore.release.localDraftSaved") : t("appStore.release.localDraftEmpty")}
                </strong>
                <small>
                  {props.localDraft
                    ? t("appStore.release.localDraftSavedAt", {
                        time: formatDraftSavedAt(props.localDraft.savedAt),
                      })
                    : t("appStore.release.localDraftEmptyHint")}
                </small>
                {props.localDraft ? (
                  <small>
                    {props.localDraft.publishBase?.version
                      ? t("appStore.release.localDraftPublishBase", {
                          version: props.localDraft.publishBase.version,
                        })
                      : t("appStore.release.localDraftFirstPublishBase")}
                  </small>
                ) : null}
              </div>
            </div>
            {props.draftError ? (
              <p className="app-store-local-draft-error" role="alert">
                {props.draftError}
              </p>
            ) : null}
            <div className="app-store-local-draft-actions">
              <button
                className="og-button app-store-local-draft-save"
                type="button"
                disabled={props.draftPending}
                onClick={() => props.onSaveDraft(release)}
              >
                {props.draftPending ? (
                  <LoaderCircle className="app-store-publish-spinner" size={15} />
                ) : (
                  <Save size={15} />
                )}
                <span>
                  {props.draftPending ? t("appStore.release.localDraftSaving") : t("appStore.release.localDraftSave")}
                </span>
              </button>
            </div>
          </PublishSection>

          {canPublish ? (
            <PublishSection title={t("appStore.release.scopeTitle")} compact>
              <div
                className="app-store-publish-visibility"
                role="radiogroup"
                aria-label={t("appStore.publishVisibilityAriaLabel")}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={release.visibility === "restricted"}
                  data-active={release.visibility === "restricted" ? "true" : "false"}
                  onClick={() =>
                    updateRelease((current) => {
                      current.visibility = "restricted";
                    }, "formal")
                  }
                >
                  <ShieldCheck size={14} />
                  <span>{t("appStore.visibilityRestricted")}</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={release.visibility === "public"}
                  data-active={release.visibility === "public" ? "true" : "false"}
                  onClick={() =>
                    updateRelease((current) => {
                      current.visibility = "public";
                    }, "formal")
                  }
                >
                  <Globe2 size={14} />
                  <span>{t("appStore.release.visibilityPublic")}</span>
                </button>
              </div>
              <label className="app-store-publish-apply-local">
                <input
                  type="checkbox"
                  aria-label={t("appStore.release.applyToCurrentApp")}
                  checked={props.applyToCurrentApp === true}
                  onChange={(event) => props.onApplyToCurrentAppChange?.(event.target.checked)}
                />
                <span>
                  <strong>{t("appStore.release.applyToCurrentApp")}</strong>
                  <small>{t("appStore.release.applyToCurrentAppHint")}</small>
                </span>
              </label>
            </PublishSection>
          ) : null}

          {canPublish ? (
            <PublishSection
              title={t("appStore.release.checksTitle")}
              description={t("appStore.release.checksDesc")}
              compact
            >
              <div className="app-store-publish-checks">
                {checks.map((check) => (
                  <ReleaseCheck
                    key={check.id}
                    check={check}
                    repairPending={props.buildContractRepairPending === true}
                    onRepair={props.onRepairBuildContract}
                  />
                ))}
              </div>
            </PublishSection>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

// ===== Presentation components =====

export function PublishHeader(props: {
  title: string;
  pending?: boolean;
  publishDisabled?: boolean;
  onBack(): void;
  onPublish?(): void;
}) {
  const { t } = useI18n();
  return (
    <header className="app-store-publish-header">
      <div className="app-store-publish-header-title">
        <button
          type="button"
          className="app-store-publish-back"
          onClick={props.onBack}
          aria-label={t("appStore.release.backAria")}
        >
          <ArrowLeft size={19} />
        </button>
        <span className="app-store-package-icon" aria-hidden="true">
          <Package size={18} />
        </span>
        <div>
          <h1>{t("appStore.saveAndPublishApp")}</h1>
          <p>{props.title}</p>
        </div>
      </div>
      {props.onPublish ? (
        <button
          className="og-button og-button--primary app-store-publish-submit"
          type="button"
          disabled={props.pending || props.publishDisabled}
          onClick={props.onPublish}
        >
          {props.pending ? <LoaderCircle className="app-store-publish-spinner" size={15} /> : <Upload size={15} />}
          <span>{props.pending ? t("appStore.release.publishing") : t("appStore.publish")}</span>
        </button>
      ) : null}
    </header>
  );
}

export function PublishProgressNotice(props: {
  progress: PublishProgressView;
  canPublish: boolean;
  pending: boolean;
  recoveryPaused: boolean;
  abandonPending?: boolean;
  resolutionPending: boolean;
  recoveryBlocked: boolean;
  onRetryBuild?(): void;
  onContinue?(): void;
  onAbandon?(): void;
  onKeepLocalChanges?(): void;
}) {
  const { t } = useI18n();
  const progress = props.progress;
  const registryReady = progress.state === "registry-ready";
  const blocked = progress.state === "blocked";
  const opaqueConflict = progress.phase === "remote_conflict";
  const needsRetry = progress.state === "needs-retry";
  const closed = progress.state === "closed";
  const buildFailure = progress.buildFailure ?? progress.blockedRelease?.buildFailure;
  const allowedActions = progress.blockedRelease?.allowedActions ?? progress.allowedActions;
  const retryAllowed = allowedActions.includes("retry_candidate") || allowedActions.includes("retry_build");
  const abandonAllowed = allowedActions.includes("abandon");
  const blockedMatchesCurrentRequest = progress.blockedRelease?.matchesCurrentRequest === true;
  const blockedFailed = progress.blockedRelease?.status === "trusted_build_failed";
  const nonRetryableFailure =
    !blocked && progress.remoteStatus === "trusted_build_failed" && !allowedActions.includes("retry_build")
      ? buildFailure
      : undefined;
  const retryBuild = progress.remoteStatus === "trusted_build_failed" && allowedActions.includes("retry_build");
  const retryBlocked = blocked && blockedMatchesCurrentRequest && retryAllowed;
  const showRetryAction = (retryBuild || retryBlocked) && Boolean(props.onRetryBuild);
  const showAbandonAction = abandonAllowed && Boolean(props.onAbandon);
  const abandoning = props.abandonPending === true;
  const visibleStage = progress.visibleStage;
  const Icon = blocked || needsRetry || closed ? XCircle : registryReady ? CheckCircle2 : History;
  const ProgressIcon = (props.pending && !needsRetry) || abandoning ? LoaderCircle : Icon;
  const title = abandoning
    ? t("appStore.release.abandonPublishPendingTitle")
    : opaqueConflict
      ? t("appStore.release.progressOpaqueConflictTitle")
      : nonRetryableFailure
        ? t("appStore.release.progressNeedsFixTitle")
        : blocked
          ? t("appStore.release.progressBlockedTitle")
          : needsRetry
            ? t("appStore.release.progressNeedsRetryTitle")
            : closed
              ? t("appStore.release.progressClosedTitle")
              : registryReady
                ? t("appStore.release.progressStage.local-finalization.title")
                : t(`appStore.release.progressStage.${visibleStage}.title`);
  const detail = abandoning
    ? t("appStore.release.abandonPublishPendingDesc")
    : opaqueConflict
      ? t("appStore.release.progressOpaqueConflictDesc")
      : nonRetryableFailure
        ? t("appStore.release.progressNeedsFixDesc", {
            version: progress.blockedRelease?.version ?? progress.version,
            stage: nonRetryableFailure.stage,
            code: nonRetryableFailure.code,
          })
        : blocked
          ? t(
              !blockedMatchesCurrentRequest
                ? abandonAllowed
                  ? "appStore.release.progressBlockedDifferentEndableDesc"
                  : "appStore.release.progressBlockedDifferentDesc"
                : blockedFailed
                  ? "appStore.release.progressBlockedFailedDesc"
                  : abandonAllowed
                    ? "appStore.release.progressBlockedExpiredDesc"
                    : "appStore.release.progressBlockedDesc",
              {
                version: progress.blockedRelease?.version ?? progress.version,
              },
            )
          : needsRetry
            ? t("appStore.release.progressNeedsRetryDesc", { version: progress.version })
            : closed
              ? t("appStore.release.progressClosedDesc", { version: progress.version })
              : registryReady
                ? t("appStore.release.progressStage.local-finalization.desc", { version: progress.version })
                : t(`appStore.release.progressStage.${visibleStage}.desc`, { version: progress.version });
  return (
    <div className="app-store-publish-progress" data-state={progress.state} role="status">
      <ProgressIcon
        className={(props.pending && !needsRetry) || abandoning ? "app-store-publish-spinner" : undefined}
        size={18}
      />
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
        {blocked && progress.blockedRelease ? (
          <small>
            {t("appStore.release.progressBlockedReference", {
              id: progress.blockedRelease.id,
              status: progress.blockedRelease.status,
              requestId: progress.blockedRelease.requestId ?? "-",
            })}
          </small>
        ) : null}
        {opaqueConflict && progress.requestId ? (
          <small>{t("appStore.release.progressOpaqueConflictReference", { requestId: progress.requestId })}</small>
        ) : null}
        {buildFailure ? (
          <small>
            {t("appStore.release.progressBuildFailureReference", {
              runId: buildFailure.workflowRunId,
            })}
          </small>
        ) : null}
        {!props.canPublish ? <small>{t("appStore.release.progressAdminRecoveryHint")}</small> : null}
      </div>
      {props.canPublish && (showRetryAction || showAbandonAction) ? (
        <div className="app-store-publish-progress-actions">
          {showRetryAction && props.onRetryBuild ? (
            <button className="og-button" type="button" disabled={props.pending} onClick={props.onRetryBuild}>
              {props.pending ? <LoaderCircle className="app-store-publish-spinner" size={14} /> : null}
              <span>{t(blocked ? "appStore.release.retryBlockedRelease" : "appStore.release.retryBuild")}</span>
            </button>
          ) : null}
          {showAbandonAction && props.onAbandon ? (
            <button
              className="og-button og-button--danger"
              type="button"
              disabled={props.pending}
              onClick={props.onAbandon}
            >
              {abandoning ? <LoaderCircle className="app-store-publish-spinner" size={14} /> : null}
              <span>
                {abandoning
                  ? t("appStore.release.abandonPublishPendingTitle")
                  : t(blocked ? "appStore.release.abandonBlockedRelease" : "appStore.release.abandonPublish")}
              </span>
            </button>
          ) : null}
        </div>
      ) : props.canPublish && opaqueConflict && props.onContinue ? (
        <button className="og-button" type="button" disabled={props.pending} onClick={props.onContinue}>
          {props.pending ? <LoaderCircle className="app-store-publish-spinner" size={14} /> : null}
          <span>{t("appStore.release.recheckAndContinueOpaqueConflict")}</span>
        </button>
      ) : props.canPublish && props.recoveryPaused && props.onContinue ? (
        <button className="og-button" type="button" disabled={props.pending} onClick={props.onContinue}>
          {props.pending ? <LoaderCircle className="app-store-publish-spinner" size={14} /> : null}
          <span>{t("appStore.release.resumePublish")}</span>
        </button>
      ) : props.canPublish && registryReady && props.recoveryBlocked && props.onKeepLocalChanges ? (
        <button
          className="og-button"
          type="button"
          disabled={props.resolutionPending}
          onClick={props.onKeepLocalChanges}
        >
          {props.resolutionPending ? <LoaderCircle className="app-store-publish-spinner" size={14} /> : null}
          <span>{t("appStore.release.keepLocalChanges")}</span>
        </button>
      ) : null}
    </div>
  );
}

export function PublishSection(props: { title: string; description?: string; compact?: boolean; children: ReactNode }) {
  return (
    <section className="app-store-publish-section" data-compact={props.compact ? "true" : "false"}>
      <div className="app-store-publish-section-heading">
        <h2>{props.title}</h2>
        {props.description ? <p>{props.description}</p> : null}
      </div>
      {props.children}
    </section>
  );
}

export function PublishField(props: {
  label: string;
  hint?: string;
  required?: boolean;
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="app-store-publish-field" data-layout={props.stacked ? "stacked" : "default"}>
      <span className="app-store-publish-field-label">
        <span>
          {props.label}
          {props.required ? <em> *</em> : null}
        </span>
        {props.hint ? <small>{props.hint}</small> : null}
      </span>
      <span className="app-store-publish-field-control">{props.children}</span>
    </label>
  );
}

export function ReadOnlyValue(props: { label: string; value: string }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd title={props.value}>{props.value}</dd>
    </div>
  );
}

export function ReleaseCheck(props: { check: PublishCheckView; repairPending?: boolean; onRepair?(): void }) {
  const { t } = useI18n();
  const { check } = props;
  const translated = check;
  const Icon = check.status === "passed" ? CheckCircle2 : check.status === "blocked" ? XCircle : AlertTriangle;
  return (
    <div className="app-store-publish-check" data-status={check.status}>
      <Icon size={16} />
      <div>
        <strong>{translated.label}</strong>
        <p>{translated.detail}</p>
        {check.repairable && props.onRepair ? (
          <button className="og-button" type="button" disabled={props.repairPending} onClick={props.onRepair}>
            {props.repairPending
              ? t("appStore.release.buildContractRepairing")
              : t("appStore.release.buildContractRepair")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
export function formatDraftSavedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
