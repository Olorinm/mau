// Presentation extracted from OpenGrove 8b365ed; caller owns data and service operations.
import { ProductIcon } from "@olorinm/agent-ui/app";
import { useI18n, type TranslationFn } from "./i18n";
import { DesktopActionRow } from "./settings-desktop-panel";
const rawDiagnosticText = (value: string | undefined) => value ?? "";
export const settingsStorageCategoryIds = [
  "works-and-files",
  "apps-and-runtime",
  "rebuildable",
  "backups",
  "conversations-and-system",
] as const;

export type SettingsStorageCategoryId = (typeof settingsStorageCategoryIds)[number];
export type SettingsStorageBackupKind = "migration" | "app-layout";
export const APP_BACKUP_PROTECTION_REASONS = [
  "activation_unconfirmed",
  "workspace_unavailable",
  "active_reference",
  "unsafe_path",
  "missing_receipt",
  "reference_scan_failed",
  "app_not_mounted",
] as const;
export interface StorageAppLayoutBackup {
  kind: "app-layout";
  id: string;
  appId: string;
  bytes: number;
  createdAt: string;
  state: "verified" | "unverified" | "protected";
  appStatus?: "active" | "disabled" | "uninstalled";
  reason?: (typeof APP_BACKUP_PROTECTION_REASONS)[number];
  workspacePath?: string;
}
export type SettingsStorageBackup = StorageAppLayoutBackup | { kind: "migration"; bytes: number; createdAt: string };

export interface SettingsStorageOverview {
  totalBytes: number;
  scannedAt: string;
  categories: Array<{ id: SettingsStorageCategoryId; bytes: number }>;
  cleanupCandidates: { rebuildableBytes: number };
  backups: SettingsStorageBackup[];
}

export interface SettingsStorageCleanupEstimates { unreferencedFilesBytes: number; rebuildableBytes: number; safeCleanupBytes: number; migrationBackupBytes: number }
export function settingsStorageTotalBytes(overview?: SettingsStorageOverview): number {
  return overview?.totalBytes ?? 0;
}

export function settingsStorageCategoryBytes(
  overview: SettingsStorageOverview | undefined,
  id: SettingsStorageCategoryId,
): number {
  return overview?.categories.find((category) => category.id === id)?.bytes ?? 0;
}

export function StoragePanel(props: {
  overview?: SettingsStorageOverview;
  cleanupEstimates?: SettingsStorageCleanupEstimates;
  loading: boolean;
  busy: boolean;
  error: string;
  notice: string;
  onBack(): void;
  onRefresh(): Promise<void>;
  onCleanup(): Promise<void>;
  onClearHistory(scope: "migration-backups"): Promise<void>;
}) {
  const { t } = useI18n();
  const visibleStorageCategoryIds = settingsStorageCategoryIds.filter(
    (id) => id !== "backups" || (props.cleanupEstimates?.migrationBackupBytes ?? 0) > 0,
  );
  const storageSegments = visibleStorageCategoryIds.map((id) => ({
    label: storageOverviewCategoryLabel(id, t),
    bytes: settingsStorageCategoryBytes(props.overview, id),
  }));
  const totalBytes = settingsStorageTotalBytes(props.overview);
  return (
    <section className="settings-list-section settings-storage-detail">
      <div className="settings-list-section-heading settings-storage-detail-heading">
        <span className="settings-storage-detail-title">
          <button className="settings-storage-back" type="button" onClick={props.onBack} aria-label={t("common.back")}>
            <ProductIcon name="back" size={18} />
          </button>
          <h2>{t("settings.storageSpaceTitle")}</h2>
        </span>
        <button
          className="settings-section-action"
          type="button"
          disabled={props.busy || props.loading}
          onClick={() => void props.onRefresh()}
        >
          {t("settings.storageRefreshStats")}
        </button>
      </div>
      <p className="settings-help">{t("settings.localStorageCopy")}</p>
      {!props.overview ? (
        <div className="settings-storage-summary">
          <strong>{props.loading ? t("settings.storageLoading") : t("settings.storageUnavailable")}</strong>
          {!props.loading && props.error ? <p className="settings-help">{props.error}</p> : null}
        </div>
      ) : (
        <>
          <div className="settings-storage-summary">
            <div className="settings-storage-total">
              <strong>{t("settings.storageTotalUsed")}</strong>
              <span>{formatBytes(totalBytes)}</span>
            </div>
            <div className="settings-storage-bar" aria-hidden="true">
              {storageSegments.map((segment) => (
                <span
                  key={segment.label}
                  style={{ width: `${totalBytes ? (segment.bytes / totalBytes) * 100 : 0}%` }}
                />
              ))}
            </div>
            <div className="settings-storage-legend">
              {storageSegments.map((segment) => (
                <span key={segment.label}>
                  <i aria-hidden="true" />
                  {segment.label}
                </span>
              ))}
            </div>
          </div>
          <div className="settings-storage-grid">
            {visibleStorageCategoryIds.map((id) => (
              <StorageCard
                key={id}
                label={storageOverviewCategoryLabel(id, t)}
                description={storageOverviewCategoryDescription(id, t, props.overview)}
                value={formatBytes(settingsStorageCategoryBytes(props.overview, id))}
              />
            ))}
          </div>
          <div className="settings-storage-subheading">{t("settings.storageMaintenance")}</div>
          <div className="settings-list settings-storage-list">
            <DesktopActionRow
              label={t("settings.storageSafeCleanup")}
              description={`${t("settings.storageSafeCleanupCopy")} ${t("settings.storageCleanupEstimateMaximum", {
                size: formatBytes(props.cleanupEstimates?.safeCleanupBytes ?? 0),
              })}`}
              actionLabel={props.busy ? t("settings.storageCleaning") : t("settings.storageSafeCleanup")}
              disabled={props.busy || !(props.cleanupEstimates?.safeCleanupBytes ?? 0)}
              onAction={() => void props.onCleanup()}
            />
            {(props.cleanupEstimates?.migrationBackupBytes ?? 0) > 0 ? (
              <DesktopActionRow
                label={t("settings.storageMigrationBackups")}
                description={`${t("settings.storageMigrationBackupsCopy")} ${backupKindSummary(props.overview, t)}`}
                actionLabel={t("settings.storageDeleteMigrationBackups")}
                tone="danger"
                disabled={props.busy}
                onAction={() => void props.onClearHistory("migration-backups")}
              />
            ) : null}
            {props.overview.backups.map((backup) =>
              backup.kind === "app-layout" ? (
                <div className="settings-storage-backup-item" key={backup.id}>
                  <strong>{rawDiagnosticText(backup.appId)}</strong>
                  <span>{formatBytes(backup.bytes)}</span>
                  <p className="settings-help">
                    {backup.state === "verified"
                      ? backup.appStatus === "uninstalled"
                        ? t("settings.storageBackupUninstalledApp", { app: backup.appId })
                        : backup.appStatus === "disabled"
                          ? t("settings.storageBackupDisabledApp", {
                              app: backup.appId,
                              path: backup.workspacePath ?? "",
                            })
                          : t("settings.storageBackupVerified")
                      : backup.state === "unverified"
                        ? t("settings.storageBackupUnverified")
                        : t("settings.storageBackupProtected", { reason: backupProtectionReason(backup.reason, t) })}
                  </p>
                  {backup.workspacePath && backup.appStatus !== "disabled" ? (
                    <p className="settings-help">
                      {t("settings.storageBackupWorkspace", {
                        app: backup.appId,
                        path: backup.workspacePath,
                      })}
                    </p>
                  ) : null}
                </div>
              ) : null,
            )}
          </div>
        </>
      )}
      {props.overview && props.error ? <p className="settings-warning">{props.error}</p> : null}
      {props.notice ? <p className="settings-success">{props.notice}</p> : null}
    </section>
  );
}

export function StorageEntry(props: { loading: boolean; overview?: SettingsStorageOverview; onOpen(): void }) {
  const { t } = useI18n();
  const totalBytes = settingsStorageTotalBytes(props.overview);
  return (
    <section className="settings-list-section settings-storage-entry-section">
      <button className="settings-storage-entry" type="button" onClick={props.onOpen}>
        <strong>{t("settings.storageSpaceTitle")}</strong>
        <span className="settings-storage-entry-meta">
          <span>
            {props.overview
              ? formatBytes(totalBytes)
              : props.loading
                ? t("settings.storageLoading")
                : t("settings.storageOpenToCalculate")}
          </span>
          <ProductIcon name="next" size={17} />
        </span>
      </button>
    </section>
  );
}

export function StorageCard(props: { label: string; description?: string; value: string }) {
  return (
    <div className="settings-storage-card">
      <span className="settings-storage-card-copy">
        <strong>{props.label}</strong>
        <span>{props.value}</span>
        {props.description ? <small>{props.description}</small> : null}
      </span>
    </div>
  );
}

function storageOverviewCategoryLabel(id: SettingsStorageCategoryId, t: TranslationFn): string {
  if (id === "works-and-files") return t("settings.storageCategoryWorksAndFiles");
  if (id === "apps-and-runtime") return t("settings.storageCategoryAppsAndRuntime");
  if (id === "rebuildable") return t("settings.storageCategoryRebuildable");
  if (id === "backups") return t("settings.storageCategoryBackups");
  return t("settings.storageCategoryConversationsAndSystem");
}

function storageOverviewCategoryDescription(
  id: SettingsStorageCategoryId,
  t: TranslationFn,
  overview?: SettingsStorageOverview,
): string {
  if (id === "works-and-files") return t("settings.storageCategoryWorksAndFilesCopy");
  if (id === "apps-and-runtime") return t("settings.storageCategoryAppsAndRuntimeCopy");
  if (id === "rebuildable") return t("settings.storageCategoryRebuildableCopy");
  if (id === "backups") {
    const migrationBackups = overview?.backups ?? [];
    const latest = migrationBackups[0];
    if (!latest) return t("settings.storageCategoryBackupsCopy");
    return `${t("settings.storageCategoryBackupsCopy")} ${t("settings.storageBackupSummary", {
      count: migrationBackups.length,
      time: formatDateTime(latest.createdAt),
    })}`;
  }
  return t("settings.storageCategoryConversationsAndSystemCopy");
}

function backupKindSummary(overview: SettingsStorageOverview | undefined, t: TranslationFn): string {
  const backups = overview?.backups ?? [];
  const latest = backups[0];
  if (!latest) return t("settings.storageBackupNone");
  return t("settings.storageBackupSummary", {
    count: backups.length,
    time: formatDateTime(latest.createdAt),
  });
}

function backupProtectionReason(reason: string | undefined, t: TranslationFn): string {
  if (reason === "activation_unconfirmed") return t("settings.storageBackupActivationUnconfirmed");
  if (reason === "workspace_unavailable") return t("settings.storageBackupWorkspaceUnavailable");
  if (reason === "active_reference") return t("settings.storageBackupActiveReference");
  if (reason === "reference_scan_failed") return t("settings.storageBackupReferenceScanFailed");
  if (reason === "app_not_mounted") return t("settings.storageBackupAppNotMounted");
  if (reason === "missing_receipt") return t("settings.storageBackupUnverified");
  return t("settings.storageBackupUnsafePath");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

function formatDateTime(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
