// Original EmployeeDialog presentation. Kernel/provider resolution and persistence are caller-owned.
import { useId, useState, type ReactNode, type SetStateAction, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Dialog, DialogContent, DialogTitle, Tooltip } from "@olorinm/agent-ui/app";
import { useI18n } from "../presentation/i18n";
import { IdentityImageTrigger } from "../presentation/identity-image-trigger";
import {RoomInlineSelect, type RoomInlineSelectOption as InlineSelectOption} from "./room-inline-select";
import { EmployeeAvatarPicker } from "./employee-avatar-picker";
import { RoomMemberAvatar } from "./member-avatar";
import type { MemberIdentity } from "./identity";
export interface EmployeeDraft {
 id: string; name: string; avatarMode: "generated" | "initials" | "upload"; avatarSeed: string; avatarDataUrl: string;
 kernel: string; model: string; providerId: string; reasoningEffort: string; accessMode: string; role: string;
 visibility: "private" | "public"; publicDescription: string; publicSkillsText: string;
 inputSpec: string; outputSpec: string; contextTokenBudget: string;
}
export type EmployeeEditorTab = "profile" | "runtime" | "collaboration";
export interface EmployeeKernelChoice { id: string; label: string; icon?: ReactNode; description?: string; disabled?: boolean }
export interface EmployeeEditorProps {
 open: boolean; onOpenChange(open: boolean): void;
 draft: EmployeeDraft; onDraftChange(draft: EmployeeDraft, options?: {fields?: string[]; immediate?: boolean}): void;
 onKernelChange(id: string): void; onSubmit(): void; canSubmit: boolean;
 kernels: EmployeeKernelChoice[]; models: InlineSelectOption[]; modelManaged?: boolean;
 providers?: InlineSelectOption[]; defaultProviderId?: string;
 reasoning?: {status: "unsupported" | "loading" | "ready"; value: string; label?: string}; reasoningOptions?: InlineSelectOption[];
 accessOptions: InlineSelectOption[]; accessValueLabel?: string; accessModeNotice?: boolean; accessUnavailable?: boolean;
 contextBudgetInvalid?: boolean; pending?: boolean; error?: string; editing?: boolean;
 previewMember?: MemberIdentity; previewSubtitle?: ReactNode;
 embedded?: boolean; activeTab?: EmployeeEditorTab; onActiveTabChange?(tab: EmployeeEditorTab): void;
 showTabs?: boolean; showPreview?: boolean; showCancel?: boolean; showRuntimeNote?: boolean; showSubmitActions?: boolean;
}
export function EmployeeEditor(props: EmployeeEditorProps) {
 const {t} = useI18n(); const instanceId = useId().replace(/:/g, "");
 const [localTab, setLocalTab] = useState<EmployeeEditorTab>("profile");
 const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
 const activeTab = props.activeTab ?? localTab;
 const selectTab = (tab: EmployeeEditorTab) => {setLocalTab(tab); props.onActiveTabChange?.(tab)};
 const {draft, canSubmit, editing, contextBudgetInvalid, accessModeNotice, pending: submitPending, error: submitError} = props;
 const previewMember = {...props.previewMember, ...draft};
 const availableKernels = props.kernels, modelOptions = props.models, providerOptions = props.providers ?? [];
 const selectedKernel = availableKernels.find(k => k.id === draft.kernel);
 const selectedKernelReady = !!selectedKernel && !selectedKernel.disabled;
 const selectedModel = modelOptions.find(m => m.id === draft.model);
 const providerRoutingEnabled = !!props.providers;
 const providerSelection = {defaultProviderId: props.defaultProviderId ?? ""};
 const reasoningControl = props.reasoning ?? {status: "unsupported", value: ""};
 const reasoningOptions = props.reasoningOptions ?? [];
 const showPreview = props.showPreview !== false;
 const updateKernel = props.onKernelChange;
 const updateDraft = (action: SetStateAction<EmployeeDraft>, options?: {fields?: string[]; immediate?: boolean}) => props.onDraftChange(typeof action === "function" ? action(draft) : action, options);
 const updateContextTokenBudget = (value: string) => updateDraft({...draft, contextTokenBudget: value}, {fields: ["contextTokenBudget"]});
  const editorContent = (
    <>
      {props.embedded ? null : (
        <DialogTitle>{editing ? t("employee.profileSettingsTitle") : t("employee.addEmployee")}</DialogTitle>
      )}
      {showPreview ? (
        <div className="employee-dialog-preview">
          <RoomMemberAvatar
            member={previewMember}
            className="rooms-avatar"
            showStatus={false}
          />
          <div>
            <strong>{draft.name.trim() || t("employee.newEmployeeName")}</strong>
            <small>{props.previewSubtitle}</small>
          </div>
        </div>
      ) : null}
      {props.showTabs === false ? null : (
        <div className="employee-dialog-tabs" role="tablist" aria-label={t("employee.settingsSectionsLabel")}>
          {(
            [
              ["profile", t("employee.profileTab")],
              ["runtime", t("employee.runtimeSettingsTitle")],
              ["collaboration", t("employee.responsibilityTitle")],
            ] as Array<[EmployeeEditorTab, string]>
          ).map(([tab, label]) => (
            <button
              key={tab}
              id={`${instanceId}-${tab}-tab`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls={`${instanceId}-${tab}-panel`}
              data-active={activeTab === tab ? "true" : "false"}
              onClick={() => selectTab(tab)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {activeTab === "profile" ? (
        <section
          id={`${instanceId}-profile-panel`}
          className="employee-dialog-card employee-dialog-tab-panel employee-dialog-identity-card"
          role="tabpanel"
          aria-labelledby={props.showTabs === false ? undefined : `${instanceId}-profile-tab`}
          aria-label={props.showTabs === false ? t("employee.profileTab") : undefined}
        >
          <div className="employee-dialog-profile-hero">
            <IdentityImageTrigger
              label={t("employee.avatarTitle")}
              title={draft.name.trim() || t("employee.newEmployeeName")}
              onClick={() => setAvatarPickerOpen(true)}
            >
              <RoomMemberAvatar
                member={previewMember}
                className="employee-dialog-profile-hero-avatar"
                showStatus={false}
              />
            </IdentityImageTrigger>
          </div>
          <label className="employee-dialog-field employee-dialog-profile-name-row">
            <span>{t("employee.nameLabel")}</span>
            <input
              value={draft.name}
              onChange={(event) =>
                updateDraft((current) => ({ ...current, name: event.target.value }), { fields: ["name"] })
              }
              placeholder={t("employee.namePlaceholder")}
            />
          </label>
        </section>
      ) : null}
      {activeTab === "runtime" ? (
        <section
          id={`${instanceId}-runtime-panel`}
          className="employee-dialog-card employee-dialog-tab-panel employee-dialog-runtime-card"
          role="tabpanel"
          aria-labelledby={props.showTabs === false ? undefined : `${instanceId}-runtime-tab`}
          aria-label={props.showTabs === false ? t("employee.runtimeSettingsTitle") : undefined}
        >
          <section className="employee-dialog-runtime" aria-label={t("employee.runtimeGroupLabel")}>
            <h3 className="employee-dialog-runtime-title">Kernel</h3>
            <div className="employee-dialog-kernel-list">
              {availableKernels.map((kernel) => (
                <Tooltip
                  key={kernel.id}
                  content={
                    kernel.description || kernel.label || kernel.id
                  }
                >
                  <button
                    className="employee-dialog-kernel-option"
                    data-active={kernel.id === draft.kernel ? "true" : "false"}
                    data-ready={!kernel.disabled ? "true" : "false"}
                    type="button"
                    disabled={!!kernel.disabled}
                    onClick={() => updateKernel(kernel.id)}
                  >
                    <span className="employee-dialog-kernel-icon">{kernel.icon}</span>
                    <span>
                      <strong>{kernel.label || kernel.id}</strong>
                    </span>
                  </button>
                </Tooltip>
              ))}
              {!availableKernels.length ? (
                <div className="rooms-empty-row">{t("employee.noSelectableKernels")}</div>
              ) : null}
            </div>
          </section>
          <section
            className="employee-dialog-runtime-settings employee-dialog-runtime-settings-card"
            aria-label={t("employee.runtimeSettingsTitle")}
          >
            <header className="employee-dialog-runtime-settings-heading">
              <h3 className="employee-dialog-runtime-title">{t("employee.runtimeSettingsTitle")}</h3>
            </header>
            <div className="employee-dialog-runtime-fields">
              {!modelOptions.length ? (
                <div className="employee-dialog-field">
                  <span>{t("composer.model")}</span>
                  <span className="employee-dialog-model-note">{t("settings.noAvailableModelsHint")}</span>
                </div>
              ) : modelOptions.length === 1 &&
                props.modelManaged === true ? (
                <div className="employee-dialog-field">
                  <span>{t("composer.model")}</span>
                  <span className="employee-dialog-model-note">
                    {modelOptions[0]!.label}
                    {t("settings.modelDeterminedByKernelLogin")}
                  </span>
                </div>
              ) : (
                <div className="employee-dialog-field">
                  <span>{t("composer.model")}</span>
                  <RoomInlineSelect
                    value={selectedModel?.id ?? draft.model}
                    menuSize="content"
                    options={modelOptions.map((option) => ({ id: option.id, label: option.label }))}
                    onChange={(model) =>
                      updateDraft((current) => ({ ...current, model, providerId: "" }), {
                        fields: ["model", "providerId"],
                        immediate: true,
                      })
                    }
                  />
                </div>
              )}
              {providerRoutingEnabled && providerOptions.length ? (
                <div className="employee-dialog-field">
                  <span>{t("employee.providerLabel")}</span>
                  <RoomInlineSelect
                    value={draft.providerId || providerSelection.defaultProviderId}
                    options={providerOptions}
                    onChange={(providerId) =>
                      updateDraft(
                        (current) => ({
                          ...current,
                          providerId: providerId === providerSelection.defaultProviderId ? "" : providerId,
                        }),
                        { fields: ["providerId"], immediate: true },
                      )
                    }
                  />
                </div>
              ) : null}
              {reasoningControl.status !== "unsupported" ? (
                <div className="employee-dialog-field">
                  <span>{t("contacts.reasoningLevel")}</span>
                  {reasoningControl.status === "loading" ? (
                    <span aria-busy="true">{reasoningControl.label ?? reasoningControl.value}</span>
                  ) : (
                    <RoomInlineSelect
                      value={reasoningControl.value}
                      options={reasoningOptions}
                      onChange={(effort) => {
                        if (reasoningOptions.some((option) => option.id === effort)) {
                          updateDraft((current) => ({ ...current, reasoningEffort: effort }), {
                            fields: ["reasoningEffort"],
                            immediate: true,
                          });
                        }
                      }}
                    />
                  )}
                </div>
              ) : null}
              <div className="employee-dialog-field">
                <span>{t("contacts.accessTitle")}</span>
                <RoomInlineSelect
                  value={draft.accessMode}
                  valueLabel={props.accessValueLabel}
                  menuSize="wide"
                  options={props.accessOptions}
                  onChange={(accessMode) => {
                    updateDraft(
                      (current) => ({
                        ...current,
                        accessMode: accessMode,
                      }),
                      { fields: ["accessMode"], immediate: true },
                    );
                  }}
                />
              </div>
              {accessModeNotice ? (
                <div className="employee-dialog-warning" role="status">
                  {t("composer.accessModeResetToAsk")}
                </div>
              ) : null}
              {props.accessUnavailable ? (
                <div className="employee-dialog-warning" role="status">
                  {t("composer.selectedAccessUnavailable")}
                </div>
              ) : null}
              {!selectedKernelReady && selectedKernel ? (
                <div className="employee-dialog-warning">
                  {selectedKernel.description || t("employee.kernelNotInstalledWarning")}
                </div>
              ) : null}
              <label className="employee-dialog-field">
                <span>{t("contacts.contextBudgetLabel")}</span>
                <input
                  type="number"
                  min={1}
                  step={1000}
                  value={draft.contextTokenBudget}
                  placeholder={t("employee.contextBudgetPlaceholder")}
                  aria-invalid={contextBudgetInvalid}
                  onChange={(event) => updateContextTokenBudget(event.target.value)}
                />
              </label>
            </div>
            {props.showRuntimeNote === false ? null : (
              <p className="employee-dialog-runtime-note">{t("contacts.contextBudgetHint")}</p>
            )}
          </section>
        </section>
      ) : null}
      {activeTab === "collaboration" ? (
        <section
          id={`${instanceId}-collaboration-panel`}
          className="employee-dialog-card employee-dialog-tab-panel employee-dialog-responsibility-card"
          role="tabpanel"
          aria-labelledby={props.showTabs === false ? undefined : `${instanceId}-collaboration-tab`}
          aria-label={props.showTabs === false ? t("employee.responsibilityTitle") : undefined}
        >
          <section className="employee-dialog-collaboration-section">
            <h3>{t("employee.roleLabel")}</h3>
            <textarea
              className="employee-dialog-responsibility-textarea"
              aria-label={t("employee.roleLabel")}
              value={draft.role}
              onChange={(event) =>
                updateDraft((current) => ({ ...current, role: event.target.value }), { fields: ["role"] })
              }
              placeholder={t("employee.rolePlaceholder")}
              rows={4}
            />
          </section>
          <section className="employee-dialog-collaboration-section">
            <h3>{t("employee.publicContractTitle")}</h3>
            <p className="employee-dialog-section-note">{t("employee.publishNotice")}</p>
            <div className="employee-dialog-a2a-card" aria-label={t("employee.publicContractTitle")}>
              <div className="employee-dialog-a2a-visibility">
                <strong>{t("contacts.visibility")}</strong>
                <div
                  className="employee-dialog-contract-segmented"
                  role="radiogroup"
                  aria-label={t("employee.visibilityGroupLabel")}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={draft.visibility !== "public"}
                    tabIndex={draft.visibility !== "public" ? 0 : -1}
                    data-active={draft.visibility !== "public" ? "true" : "false"}
                    onKeyDown={handleRadioGroupKeyDown}
                    onClick={() =>
                      updateDraft((current) => ({ ...current, visibility: "private" }), {
                        fields: ["visibility"],
                        immediate: true,
                      })
                    }
                  >
                    {t("employee.visibilityPrivate")}
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={draft.visibility === "public"}
                    tabIndex={draft.visibility === "public" ? 0 : -1}
                    data-active={draft.visibility === "public" ? "true" : "false"}
                    onKeyDown={handleRadioGroupKeyDown}
                    onClick={() =>
                      updateDraft((current) => ({ ...current, visibility: "public" }), {
                        fields: ["visibility"],
                        immediate: true,
                      })
                    }
                  >
                    {t("employee.visibilityPublic")}
                  </button>
                </div>
              </div>
              <label className="employee-dialog-field">
                <span>{t("employee.publicDescriptionLabel")}</span>
                <textarea
                  value={draft.publicDescription}
                  onChange={(event) =>
                    updateDraft((current) => ({ ...current, publicDescription: event.target.value }), {
                      fields: ["publicDescription"],
                    })
                  }
                  placeholder={t("employee.publicDescriptionPlaceholder")}
                  rows={2}
                />
              </label>
              <label className="employee-dialog-field">
                <span>{t("employee.publicSkillsLabel")}</span>
                <textarea
                  value={draft.publicSkillsText}
                  onChange={(event) =>
                    updateDraft((current) => ({ ...current, publicSkillsText: event.target.value }), {
                      fields: ["publicSkills"],
                    })
                  }
                  placeholder={t("employee.publicSkillsPlaceholder")}
                  rows={2}
                />
              </label>
              <div className="employee-dialog-contract-grid">
                <label className="employee-dialog-field">
                  <span>{t("employee.inputSpecLabel")}</span>
                  <textarea
                    value={draft.inputSpec}
                    onChange={(event) =>
                      updateDraft((current) => ({ ...current, inputSpec: event.target.value }), {
                        fields: ["inputSpec"],
                      })
                    }
                    placeholder={t("employee.inputSpecPlaceholder")}
                    rows={2}
                  />
                </label>
                <label className="employee-dialog-field">
                  <span>{t("employee.outputSpecLabel")}</span>
                  <textarea
                    value={draft.outputSpec}
                    onChange={(event) =>
                      updateDraft((current) => ({ ...current, outputSpec: event.target.value }), {
                        fields: ["outputSpec"],
                      })
                    }
                    placeholder={t("employee.outputSpecPlaceholder")}
                    rows={2}
                  />
                </label>
              </div>
            </div>
          </section>
        </section>
      ) : null}
      <EmployeeAvatarPicker
        open={avatarPickerOpen}
        member={previewMember}
        onOpenChange={setAvatarPickerOpen}
        onConfirm={(patch) =>
          updateDraft(
            (current) => ({
              ...current,
              avatarMode: patch.avatarMode ?? "generated",
              avatarSeed: patch.avatarSeed ?? "",
              avatarDataUrl: patch.avatarDataUrl ?? "",
            }),
            {
              fields: ["avatarMode", "avatarSeed", "avatarDataUrl"],
              immediate: true,
            },
          )
        }
      />
      {contextBudgetInvalid ? (
        <p className="employee-dialog-submit-error" role="alert">
          {t("employee.contextBudgetInvalid")}
        </p>
      ) : null}
      {submitError ? (
        <p className="employee-dialog-submit-error" role="alert">
          {submitError}
        </p>
      ) : null}
      {props.showSubmitActions === false ? null : (
        <>
          <div className="modal-actions">
            {props.showCancel === false ? null : (
              <button className="ghost-button" type="button" onClick={() => props.onOpenChange(false)}>
                {t("common.cancel")}
              </button>
            )}
            <button
              className="primary-button"
              type="button"
              onClick={() => { if (canSubmit && !submitPending) props.onSubmit(); }}
              disabled={!canSubmit || submitPending}
            >
              {submitPending ? t("settings.providerSaving") : editing ? t("filePreview.save") : t("mountedApp.create")}
            </button>
          </div>
        </>
      )}
    </>
  );

  if (props.embedded) {
    return (
      <section
        className="employee-dialog employee-dialog-embedded"
        aria-label={editing ? t("employee.editEmployee") : t("employee.addEmployee")}
      >
        {editorContent}
      </section>
    );
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="employee-dialog"
        aria-label={editing ? t("employee.editEmployee") : t("employee.addEmployee")}
      >
        {editorContent}
      </DialogContent>
    </Dialog>
  );
}

function handleRadioGroupKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const group = event.currentTarget.closest('[role="radiogroup"]');
  if (!group) return;
  const radios = Array.from(group.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)'));
  const currentIndex = radios.indexOf(event.currentTarget);
  if (currentIndex < 0 || radios.length < 2) return;
  event.preventDefault();
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? radios.length - 1
        : (currentIndex + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + radios.length) %
          radios.length;
  const next = radios[nextIndex];
  next?.focus();
  next?.click();
}
