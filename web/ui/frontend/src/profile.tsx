// Extracted from web/src/components/rooms/employee-settings-surface.tsx at 8b365ed. See source-manifest.json for boundary changes.
import { useRef, useState, type ReactNode } from "react";
import {
  ProductIcon,
  Tooltip,
  type ProductIconName,
} from "@olorinm/agent-ui/app";
import { useI18n } from "./presentation/i18n";
export interface ProfilePage {
  id: string;
  label: string;
  icon?: ProductIconName;
  content: ReactNode;
}
export interface ProfileAction {
  id: string;
  label: string;
  icon: ProductIconName;
  disabled?: boolean;
  danger?: boolean;
  onSelect(): void;
}

export function ProfileSurface({
  name,
  avatar,
  actions = [],
  pages = [],
  overview,
  activity,
  notice,
  selectedPage,
  onSelectPage,
  onNameChange,
  onNameCommit,
  onNameCancel,
  onAvatarClick,
  avatarPicker,
  nameBadge,
  restoreAction,
  readOnly = true,
  saving = false,
}: {
  name: string;
  avatar: ReactNode;
  actions?: readonly ProfileAction[];
  pages?: readonly ProfilePage[];
  overview?: ReactNode;
  notice?: ReactNode;
  activity?: {
    title: string;
    active?: boolean;
    icon?: ProductIconName;
    metrics: readonly { label: string; value: ReactNode }[];
    onOpen?(): void;
  };
  selectedPage?: string;
  onSelectPage?(id: string): void;
  onNameChange?(name: string): void;
  onNameCommit?(): void;
  onNameCancel?(): void;
  onAvatarClick?(): void;
  avatarPicker?: ReactNode;
  nameBadge?: ReactNode;
  restoreAction?: ReactNode;
  readOnly?: boolean;
  saving?: boolean;
}) {
  const { t } = useI18n();
  const [localPage, setLocalPage] = useState("overview");
  const current = selectedPage ?? localPage;
  const page = pages.find((item) => item.id === current);
  const select = (id: string) => {
    setLocalPage(id);
    onSelectPage?.(id);
  };
  const canEditRuntime = !readOnly && !!onNameChange;
  const directSaving = saving;
  const cancelNameBlurRef = useRef(false);
  return (
    <section
      className="contacts-employee-settings-surface"
      aria-label={t("contacts.employeeProfile")}
    >
      <div className="contacts-employee-body">
        {!page ? (
          <section
            className="contacts-employee-summary"
            aria-label={t("contacts.employeeOverview")}
          >
            {restoreAction}
            <div className="contacts-employee-identity">
              <Tooltip content={t("employee.avatarTitle")}>
                <button
                  className="contacts-avatar-editor contacts-employee-avatar"
                  type="button"
                  disabled={!onAvatarClick}
                  onClick={onAvatarClick}
                  aria-label={t("employee.avatarTitle")}
                >
                  {avatar}
                  {onAvatarClick ? (
                    <span
                      className="contacts-avatar-editor-badge"
                      aria-hidden="true"
                    >
                      <ProductIcon name="camera" size={14} />
                    </span>
                  ) : null}
                </button>
              </Tooltip>
              <div
                className="contacts-employee-title"
                data-remote={nameBadge ? "true" : undefined}
              >
                {canEditRuntime ? (
                  <input
                    value={name}
                    size={Math.max(2, Array.from(name).length)}
                    disabled={directSaving}
                    data-dialog-escape-stays-open="true"
                    aria-label={t("employee.nameLabel")}
                    onChange={(event) => onNameChange?.(event.target.value)}
                    onBlur={() => {
                      if (cancelNameBlurRef.current) {
                        cancelNameBlurRef.current = false;
                        return;
                      }
                      onNameCommit?.();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        event.nativeEvent.stopImmediatePropagation();
                        cancelNameBlurRef.current = true;
                        onNameCancel?.();
                        event.currentTarget.blur();
                      }
                    }}
                  />
                ) : (
                  <h3>{name}</h3>
                )}
                {nameBadge}
              </div>
            </div>
            <div className="contacts-detail-actions contacts-summary-actions">
              {actions.map((action) => (
                <Tooltip key={action.id} content={action.label}>
                  <button
                    className={
                      action.danger
                        ? "contacts-message-button danger"
                        : "contacts-message-button"
                    }
                    type="button"
                    onClick={action.onSelect}
                    disabled={action.disabled}
                    aria-label={action.label}
                  >
                    <span
                      className="contacts-summary-action-icon"
                      aria-hidden="true"
                    >
                      <ProductIcon name={action.icon} size={17} />
                    </span>
                  </button>
                </Tooltip>
              ))}
            </div>
          </section>
        ) : (
          <header className="contacts-employee-subpage-header">
            <Tooltip
              content={t("contacts.backToEmployeeOverview")}
              side="right"
            >
              <button
                type="button"
                onClick={() => select("overview")}
                aria-label={t("contacts.backToEmployeeOverview")}
              >
                <ProductIcon name="back" size={20} />
              </button>
            </Tooltip>
            <h2>{page?.label}</h2>
          </header>
        )}

        <div className="contacts-employee-console">
          <div className="contacts-console-body">
            {notice}
            {page?.content}
            {!page ? (
              <section
                className="contacts-employee-overview-page"
                aria-label={t("contacts.employeeOverview")}
              >
                {activity ? (
                  <section
                    className="contacts-employee-activity-preview"
                    aria-label={t("contacts.tabActivity")}
                  >
                    <button
                      className="contacts-employee-activity-summary"
                      type="button"
                      onClick={activity.onOpen}
                      disabled={!activity.onOpen}
                    >
                      <span
                        className="contacts-employee-activity-card-action"
                        aria-hidden="true"
                      >
                        <ProductIcon name="next" size={18} />
                      </span>
                      <div
                        className="contacts-employee-activity-current"
                        data-active={activity.active ? "true" : "false"}
                      >
                        <span
                          className="contacts-employee-activity-current-status"
                          aria-hidden="true"
                        >
                          <ProductIcon
                            name={
                              activity.icon ??
                              (activity.active ? "loading" : "ops")
                            }
                            size={18}
                          />
                        </span>
                        <strong>{activity.title}</strong>
                      </div>
                      <div className="contacts-employee-activity-metrics">
                        {activity.metrics.map((metric) => (
                          <span key={metric.label}>
                            <strong>{metric.value}</strong>
                            <small>{metric.label}</small>
                          </span>
                        ))}
                      </div>
                    </button>
                  </section>
                ) : null}
                <>
                  {overview ? (
                    <section className="contacts-employee-runtime-card">
                      <div className="contacts-shared-employee-editor contacts-employee-overview-runtime-editor">
                        {overview}
                      </div>
                    </section>
                  ) : null}
                  <div className="contacts-employee-overview-group">
                    {pages.map((item) => (
                      <EmployeeOverviewRow
                        key={item.id}
                        icon={item.icon}
                        label={item.label}
                        onClick={() => select(item.id)}
                      />
                    ))}
                  </div>
                </>
              </section>
            ) : null}
          </div>
        </div>
      </div>
      {avatarPicker}
    </section>
  );
}
function EmployeeOverviewRow(props: {
  icon?: ProductIconName;
  label: string;
  disabled?: boolean;
  showNext?: boolean;
  onClick(): void;
}) {
  return (
    <button type="button" disabled={props.disabled} onClick={props.onClick}>
      <span className="contacts-employee-overview-icon" aria-hidden="true">
        {props.icon ? <ProductIcon name={props.icon} size={19} /> : null}
      </span>
      <span className="contacts-employee-overview-copy">
        <strong>{props.label}</strong>
      </span>
      {props.showNext === false ? null : <ProductIcon name="next" size={18} />}
    </button>
  );
}
