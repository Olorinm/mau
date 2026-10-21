// Original extension table, deployment controls and dialogs. Operations are emitted as UI intents.
import {useState, type ReactNode} from "react";
import clsx from "clsx";
import {CircleSlash, Search, RefreshCw, Plus} from "lucide-react";
import {Button, Dialog, DialogContent, DialogTitle} from "@olorinm/agent-ui/app";
import {useI18n, type TranslationFn} from "./presentation/i18n";
import styles from "./styles/extensions.module.css";
export interface KernelTarget {id: string; label: string; icon?: ReactNode}
export interface ExtensionDeploymentView {id: string; kernelId?: string; icon?: ReactNode; enabled: boolean; readonly?: boolean; system?: boolean; managed?: boolean; scope?: string; published?: boolean; outdated?: boolean; location?: string}
export interface ExtensionItemView {
 id: string; name: string; title?: string; description?: string; kind: string; kindLabel: string; icon?: ReactNode;
 readonly?: boolean; system?: boolean; source?: {path?: string}; sourceCategory: {kind: string; label: string};
 openPath?: string; policy?: string; managementDescription?: string; localTargetLabel?: string;
 deployments: ExtensionDeploymentView[];
}
export type ExtensionViewAction = {type: "publish"; itemId: string; targetId: string} | {type: "republish" | "unpublish" | "enable" | "disable"; deploymentIds: string[]};
const MAX_VISIBLE_TARGET_ICONS = 5;
const uniqueStrings = (values: string[]) => [...new Set(values)];
const titleFromId = (value: string) => value;
const sourceHoverTitle = (source: {label: string}, path: string) => path ? `${source.label} · ${path}` : source.label;
export function ExtensionsLoadingState() {
  const { t } = useI18n();
  return (
    <div
      className={clsx(styles.table, styles.skillTable, styles.loadingTable)}
      role="status"
      aria-label={t("mountedApp.loading")}
    >
      <div className={styles.tableHeader} aria-hidden="true">
        <span>{t("settings.extensionTableExtension")}</span>
        <span>{t("settings.extensionTableTargets")}</span>
      </div>
      {[0, 1, 2, 3, 4].map((index) => (
        <div className={styles.tableRow} aria-hidden="true" key={index}>
          <div className="og-skeleton-stack">
            <span className="og-skeleton og-skeleton-line" style={{ width: index % 2 ? "58%" : "72%" }} />
            <span className="og-skeleton og-skeleton-line" style={{ width: "88%" }} />
          </div>
          <span className="og-skeleton og-skeleton-line" style={{ width: index % 2 ? "46%" : "62%" }} />
        </div>
      ))}
    </div>
  );
}

export function SkillLibraryWorkspace(props: {
  items: ExtensionItemView[];
  kernelTargets: KernelTarget[];
  disabled: boolean;
  t: TranslationFn;
  onEditSkill?(item: ExtensionItemView): void;
  onAction(action: ExtensionViewAction): void;
}) {
  const [targetPickerItemId, setTargetPickerItemId] = useState("");

  if (!props.items.length) {
    return <ExtensionEmptyState kind={props.t("settings.extensionWorkspaceSkills")} t={props.t} />;
  }

  return (
    <div className={clsx(styles.table, styles.skillTable)}>
      <div className={styles.tableHeader} aria-hidden="true">
        <span>{props.t("settings.extensionTableExtension")}</span>
        <span>{props.t("settings.extensionTableTargets")}</span>
      </div>
      {props.items.map((item) => {
        const deployments = item.deployments;
        const libraryDeployment = deployments.find(
          (deployment) => deployment.scope === "managed" && deployment.managed,
        );
        const primaryDeployment = libraryDeployment ?? deployments[0];
        const publishedDeployments = deployments.filter(deployment => deployment.published);
        const outdatedDeployments = publishedDeployments.filter(deployment => deployment.outdated);
        const publishedKernelIds = new Set(
          publishedDeployments.map((deployment) => deployment.kernelId).filter(Boolean),
        );
        const candidateTargets = props.kernelTargets.filter((kernel) => !publishedKernelIds.has(kernel.id));
        return (
          <article className={styles.tableRow} key={item.id}>
            <ExtensionIdentityCell
              item={item}
              modified={outdatedDeployments.length > 0}
              onEditSkill={props.onEditSkill}
              primaryDeployment={primaryDeployment}
              t={props.t}
            />
            <SkillPublishedTargets
              candidateTargets={candidateTargets}
              disabled={props.disabled}
              item={item}
              kernelTargets={props.kernelTargets}
              libraryDeployment={libraryDeployment}
              onClosePicker={() => setTargetPickerItemId("")}
              onTogglePicker={() => setTargetPickerItemId((current) => (current === item.id ? "" : item.id))}
              outdatedDeployments={outdatedDeployments}
              primaryDeployment={primaryDeployment}
              publishedDeployments={publishedDeployments}
              pickerOpen={targetPickerItemId === item.id}
              onAction={props.onAction}
              t={props.t}
            />
          </article>
        );
      })}
    </div>
  );
}

export function SkillPublishedTargets(props: {
  item: ExtensionItemView;
  kernelTargets: KernelTarget[];
  candidateTargets: KernelTarget[];
  publishedDeployments: ExtensionDeploymentView[];
  outdatedDeployments: ExtensionDeploymentView[];
  libraryDeployment?: ExtensionDeploymentView;
  primaryDeployment?: ExtensionDeploymentView;
  pickerOpen: boolean;
  disabled: boolean;
  onTogglePicker(): void;
  onClosePicker(): void;
  t: TranslationFn;
  onAction(action: ExtensionViewAction): void;
}) {
  const [unpublishTarget, setUnpublishTarget] = useState<{
    deployment: ExtensionDeploymentView;
    label: string;
  } | null>(null);
  const [republishDialogOpen, setRepublishDialogOpen] = useState(false);
  const outdatedKernelIds = uniqueStrings(
    props.outdatedDeployments.map((deployment) => deployment.kernelId ?? "").filter(Boolean),
  );
  const outdatedDeploymentIds = props.outdatedDeployments.map((deployment) => deployment.id).filter(Boolean);
  const outdatedKernelLabels = props.outdatedDeployments
    .map(
      (deployment) =>
        props.kernelTargets.find((kernel) => kernel.id === deployment.kernelId)?.label ??
        titleFromId(deployment.kernelId ?? ""),
    )
    .filter(Boolean);
  const itemTitle = props.item.title || props.item.name;
  return (
    <div className={styles.publishedTargets}>
      {props.publishedDeployments.length ? (
        props.publishedDeployments.slice(0, MAX_VISIBLE_TARGET_ICONS).map((deployment) => {
          const label =
            props.kernelTargets.find((kernel) => kernel.id === deployment.kernelId)?.label ??
            titleFromId(deployment.kernelId ?? "");
          return (
            <PublishedKernelBadge
              disabled={props.disabled}
              deployment={deployment}
              key={deployment.id}
              label={label}
              onRequestUnpublish={() => setUnpublishTarget({ deployment, label })}
              t={props.t}
            />
          );
        })
      ) : (
        <span className={styles.targetEmpty}>{props.t("settings.extensionNotPublished")}</span>
      )}
      {props.publishedDeployments.length > MAX_VISIBLE_TARGET_ICONS ? (
        <span
          className={styles.targetOverflow}
          title={props.publishedDeployments
            .slice(MAX_VISIBLE_TARGET_ICONS)
            .map(
              (deployment) =>
                props.kernelTargets.find((kernel) => kernel.id === deployment.kernelId)?.label ??
                titleFromId(deployment.kernelId ?? ""),
            )
            .join(", ")}
        >
          +{props.publishedDeployments.length - MAX_VISIBLE_TARGET_ICONS}
        </span>
      ) : null}
      {outdatedKernelIds.length ? (
        <button
          aria-label={props.t("settings.extensionRepublishModified")}
          className={styles.targetSync}
          title={props.t("settings.extensionRepublishModifiedTooltip")}
          type="button"
          disabled={props.disabled}
          onClick={() => setRepublishDialogOpen(true)}
        >
          <RefreshCw size={13} aria-hidden="true" />
          <span className={clsx(styles.targetTooltip, styles.syncTooltip)}>
            {props.t("settings.extensionRepublishModifiedTooltip")}
          </span>
        </button>
      ) : null}
      {props.kernelTargets.length ? (
        <button
          aria-label={props.t("settings.extensionPublishToKernel")}
          className={styles.targetAdd}
          title={props.t("settings.extensionPublishToKernel")}
          type="button"
          disabled={props.disabled || props.candidateTargets.length === 0}
          onClick={props.onTogglePicker}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      ) : null}
      <Dialog
        open={props.pickerOpen}
        onOpenChange={(open) => {
          if (!open) props.onClosePicker();
        }}
      >
        <DialogContent className={styles.targetDialog} aria-label={props.t("settings.extensionPublishDialogTitle")}>
          <DialogTitle>{props.t("settings.extensionPublishDialogTitle")}</DialogTitle>
          <div className={styles.targetDialogSkill}>
            <strong>{itemTitle}</strong>
            <small>{props.item.description || props.item.name}</small>
          </div>
          <div className={styles.targetDialogList} role="listbox">
            {props.candidateTargets.length ? (
              props.candidateTargets.map((kernel) => (
                <button
                  className={styles.targetDialogOption}
                  key={kernel.id}
                  type="button"
                  disabled={props.disabled}
                  onClick={() => {
                    props.onAction({type: "publish", itemId: props.item.id, targetId: kernel.id});
                    props.onClosePicker();
                  }}
                >
                  {kernel.icon}
                  <span>{kernel.label}</span>
                </button>
              ))
            ) : (
              <span className={styles.targetDialogEmpty}>{props.t("settings.extensionNoTargets")}</span>
            )}
          </div>
          <div className="modal-actions">
            <Button type="button" onClick={props.onClosePicker}>
              {props.t("common.cancel")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={republishDialogOpen} onOpenChange={setRepublishDialogOpen}>
        <DialogContent
          className={clsx("settings-confirm-dialog", styles.republishDialog)}
          aria-label={props.t("settings.extensionRepublishDialogTitle")}
        >
          <DialogTitle>{props.t("settings.extensionRepublishDialogTitle")}</DialogTitle>
          <p className="settings-confirm-copy">
            {props.t("settings.extensionRepublishDialogCopy", {
              kernels: outdatedKernelLabels.join("、"),
              name: itemTitle,
            })}
          </p>
          <div className="modal-actions">
            <Button type="button" onClick={() => setRepublishDialogOpen(false)}>
              {props.t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={props.disabled || outdatedDeploymentIds.length === 0}
              onClick={() => {
                props.onAction({type: "republish", deploymentIds: outdatedDeploymentIds});
                setRepublishDialogOpen(false);
              }}
            >
              {props.t("settings.extensionRepublishConfirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(unpublishTarget)}
        onOpenChange={(open) => {
          if (!open) setUnpublishTarget(null);
        }}
      >
        <DialogContent
          className={clsx("settings-confirm-dialog", styles.unpublishDialog)}
          aria-label={props.t("settings.extensionUnpublishDialogTitle")}
        >
          <DialogTitle>{props.t("settings.extensionUnpublishDialogTitle")}</DialogTitle>
          <p className="settings-confirm-copy">
            {props.t(
              unpublishTarget?.deployment.managed
                ? "settings.extensionUnpublishDialogCopy"
                : "settings.extensionUnpublishNativeDialogCopy",
              { kernel: unpublishTarget?.label ?? "", name: itemTitle },
            )}
          </p>
          <div className="modal-actions">
            <Button type="button" onClick={() => setUnpublishTarget(null)}>
              {props.t("common.cancel")}
            </Button>
            <button
              className="danger-button"
              type="button"
              disabled={props.disabled}
              onClick={() => {
                if (!unpublishTarget) return;
                props.onAction({type: "unpublish", deploymentIds: [unpublishTarget.deployment.id]});
                setUnpublishTarget(null);
              }}
            >
              {props.t("common.delete")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function PublishedKernelBadge(props: {
  deployment: ExtensionDeploymentView;
  disabled: boolean;
  label: string;
  t: TranslationFn;
  onRequestUnpublish(): void;
}) {
  const canUnpublish = !props.deployment.readonly && !props.deployment.system;
  const statusLabel = props.deployment.enabled ? props.t("common.enabled") : props.t("common.disabled");
  const actionLabel = canUnpublish
    ? `${props.t("settings.extensionUnpublishFromKernel")} · ${props.label}`
    : `${props.label} · ${statusLabel}`;
  return (
    <button
      aria-label={
        canUnpublish
          ? `${props.t("settings.extensionUnpublishFromKernel")} ${props.label} ${statusLabel}`
          : `${props.label} ${statusLabel}`
      }
      className={styles.targetIcon}
      data-enabled={props.deployment.enabled ? "true" : "false"}
      data-selected="true"
      disabled={props.disabled || !canUnpublish}
      title={actionLabel}
      type="button"
      onClick={canUnpublish ? props.onRequestUnpublish : undefined}
    >
      {props.deployment.icon}
      <span className={styles.targetTooltip}>{actionLabel}</span>
    </button>
  );
}

export function ExtensionManagementWorkspace(props: {
  items: ExtensionItemView[];
  kernelTargets: KernelTarget[];
  disabled: boolean;
  emptyKind: string;
  mode: "mcp" | "plugin" | "hook" | "tool" | "cli";
  t: TranslationFn;
  onOpenLocalPath?(path: string): void;
  onAction(action: ExtensionViewAction): void;
}) {
  if (!props.items.length) {
    return <ExtensionEmptyState kind={props.emptyKind} t={props.t} />;
  }

  return (
    <div className={styles.managerList} data-mode={props.mode}>
      {props.items.map((item) => {
        const deployments = item.deployments;
        const primaryDeployment = deployments[0];
        const targetDeployments = deployments.filter((deployment) => deployment.kernelId);
        const source = item.sourceCategory;
        const sourcePath = String(item.source?.path || primaryDeployment?.location || "");
        const titleHover = sourceHoverTitle(source, sourcePath);
        const openPath = item.openPath;
        const policy = item.policy;
        return (
          <article className={styles.managerRow} key={item.id}>
            <div className={styles.managerMain}>
              <span className={styles.kindIcon}>{item.icon}</span>
              <div className={styles.managerCopy}>
                <div className={styles.managerTitleLine}>
                  {openPath && props.onOpenLocalPath ? (
                    <span className={styles.titleTooltip} data-local-path={sourcePath || openPath}>
                      <button
                        className={styles.titleButton}
                        type="button"
                        onClick={() => props.onOpenLocalPath?.(openPath)}
                      >
                        {item.title || item.name}
                      </button>
                    </span>
                  ) : sourcePath ? (
                    <span className={styles.titleTooltip} data-local-path={sourcePath}>
                      <strong>{item.title || item.name}</strong>
                    </span>
                  ) : (
                    <strong title={titleHover}>{item.title || item.name}</strong>
                  )}
                  <span className={styles.miniBadge}>{item.kindLabel}</span>
                  <span className={styles.sourceTag} data-source={source.kind} title={titleHover}>
                    {source.label}
                  </span>
                  {item.readonly ? (
                    <span className={clsx(styles.miniBadge, styles.muted)}>
                      {props.t("settings.extensionReadonly")}
                    </span>
                  ) : null}
                </div>
                <small>{item.managementDescription ?? item.description}</small>
                {policy ? (
                  <div className={styles.managerMeta}>
                    <span title={policy}>
                      {props.t("settings.extensionTablePolicy")}
                      <strong>{policy}</strong>
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
            <div className={styles.managerTargets}>
              {targetDeployments.length ? (
                targetDeployments.map((deployment) => (
                  <ManagementDeploymentTarget
                    deployment={deployment}
                    disabled={props.disabled}
                    key={deployment.id}
                    kernelLabel={
                      props.kernelTargets.find((kernel) => kernel.id === deployment.kernelId)?.label ??
                      titleFromId(deployment.kernelId ?? "")
                    }
                    onAction={props.onAction}
                    t={props.t}
                  />
                ))
              ) : (
                <span className={styles.managerLocalTarget}>
                  {item.localTargetLabel || props.t("settings.extensionNoTargets")}
                </span>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function ManagementDeploymentTarget(props: {
  deployment: ExtensionDeploymentView;
  kernelLabel: string;
  disabled: boolean;
  t: TranslationFn;
  onAction(action: ExtensionViewAction): void;
}) {
  const deployment = props.deployment;
  if (deployment.readonly || deployment.system) {
    return (
      <span
        className={clsx(styles.targetIcon, styles.managerTargetIcon)}
        data-enabled={deployment.enabled ? "true" : "false"}
        data-selected="true"
        title={`${props.kernelLabel} · ${deployment.enabled ? props.t("common.enabled") : props.t("common.disabled")}`}
      >
        {deployment.icon}
        <span className={styles.targetTooltip}>{props.kernelLabel}</span>
      </span>
    );
  }
  const actionLabel = `${deployment.enabled ? props.t("settings.extensionDisable") : props.t("settings.extensionEnable")} · ${props.kernelLabel}`;
  return (
    <button
      aria-label={actionLabel}
      className={clsx(styles.targetIcon, styles.managerTargetIcon)}
      data-enabled={deployment.enabled ? "true" : "false"}
      data-selected="true"
      type="button"
      title={actionLabel}
      disabled={props.disabled}
      onClick={() =>
        props.onAction({type: deployment.enabled ? "disable" : "enable", deploymentIds: [deployment.id]})
      }
    >
      {deployment.icon}
      <span className={styles.targetTooltip}>{actionLabel}</span>
    </button>
  );
}

export function ExtensionIdentityCell(props: {
  item: ExtensionItemView;
  modified?: boolean;
  primaryDeployment?: ExtensionDeploymentView;
  onEditSkill?(item: ExtensionItemView): void;
  t: TranslationFn;
}) {
  const item = props.item;
  const showBadges = item.kind !== "skill" || item.readonly || item.system;
  const source = item.sourceCategory;
  const sourcePath = String(item.source?.path || props.primaryDeployment?.location || "");
  const titleHover = sourceHoverTitle(source, sourcePath);
  return (
    <div className={styles.identity} data-kind={item.kind}>
      {item.kind !== "skill" ? <span className={styles.kindIcon}>{item.icon}</span> : null}
      <span className={styles.title}>
        <span className={styles.titleMain}>
          {item.kind === "skill" && props.onEditSkill ? (
            <span className={styles.titleTooltip} data-local-path={sourcePath || titleHover}>
              <button
                className={styles.titleButton}
                type="button"
                onClick={() => props.onEditSkill?.(item)}
                aria-label={`${props.t("common.edit")} ${item.title || item.name}`}
              >
                {item.title || item.name}
              </button>
            </span>
          ) : sourcePath ? (
            <span className={styles.titleTooltip} data-local-path={sourcePath}>
              <strong>{item.title || item.name}</strong>
            </span>
          ) : (
            <strong title={titleHover}>{item.title || item.name}</strong>
          )}
          <span className={styles.sourceTag} data-source={source.kind} title={titleHover}>
            {source.label}
          </span>
          {props.modified ? (
            <span className={styles.modifiedTag} title={props.t("settings.extensionRepublishModifiedTooltip")}>
              {props.t("settings.extensionModified")}
            </span>
          ) : null}
          {showBadges ? (
            <span className={styles.badges}>
              {item.kind !== "skill" ? (
                <span className={styles.badge}>{item.kindLabel}</span>
              ) : null}
              {item.readonly ? (
                <span className={clsx(styles.badge, styles.readonly)}>{props.t("settings.extensionReadonly")}</span>
              ) : null}
              {item.system ? (
                <span className={clsx(styles.badge, styles.system)}>{props.t("settings.extensionOriginSystem")}</span>
              ) : null}
            </span>
          ) : null}
        </span>
        <small>{item.description || props.primaryDeployment?.location || item.name}</small>
      </span>
    </div>
  );
}

export function ExtensionEmptyState(props: { kind: string; t: TranslationFn }) {
  return (
    <div className={styles.emptyState}>
      <CircleSlash size={18} aria-hidden="true" />
      <span>
        <strong>{props.t("settings.extensionNoEntries", { kind: props.kind })}</strong>
        <small>{props.t("settings.extensionNoEntriesCopy")}</small>
      </span>
    </div>
  );
}

export function ExtensionNoResults(props: { t: TranslationFn; onClear(): void }) {
  return (
    <div className={styles.emptyState}>
      <Search size={18} aria-hidden="true" />
      <span>
        <strong>{props.t("settings.extensionNoResults")}</strong>
        <small>{props.t("settings.extensionNoResultsCopy")}</small>
      </span>
      <Button type="button" onClick={props.onClear}>
        {props.t("settings.extensionClearFilters")}
      </Button>
    </div>
  );
}
