// Original EmployeeSettingsSurface capability subpage; selection policy and writes belong to caller.
import {useState} from "react";
import {ProductIcon, Tooltip} from "@olorinm/agent-ui/app";
import {useI18n} from "../presentation/i18n";
export interface EmployeeSkillView {id: string; name: string; title?: string; description?: string}
export function EmployeeCapabilities(props: {
 skills: EmployeeSkillView[]; availableSkillIds: string[]; requiredSkillIds: string[]; toolIds: string[];
 editable?: boolean; saving?: boolean; onReset?(): void; onSelectAll?(): void; onClear?(): void;
 onToggleAvailable?(id: string): void; onToggleRequired?(id: string): void; onRemoveRequired?(id: string): void;
}) {
 const {t} = useI18n(); const [managingSkills, setManagingSkills] = useState(false); const [skillQuery, setSkillQuery] = useState("");
 const canEditRuntime = props.editable === true, directSaving = props.saving;
 const skillOptions = props.skills, availableSkillIds = props.availableSkillIds, effectiveSkillIds = props.requiredSkillIds, toolIds = props.toolIds;
 const filteredSkillOptions = skillOptions.filter(skill => `${skill.title ?? ""} ${skill.name} ${skill.description ?? ""}`.toLowerCase().includes(skillQuery.toLowerCase()));
 const effectiveSkills = skillOptions.filter(skill => effectiveSkillIds.includes(skill.id));
 const toggleAvailableSkill = (id: string) => props.onToggleAvailable?.(id), toggleRequiredSkill = (id: string) => props.onToggleRequired?.(id), removeDefaultSkill = (id: string) => props.onRemoveRequired?.(id);
 return (
              <section
                className="contacts-console-section contacts-skill-section contacts-capability-page"
                aria-label={t("contacts.employeeCapabilities")}
              >
                <section className="contacts-capability-section">
                  <div className="contacts-capability-section-heading">
                    <h3>{t("settings.extensionKindSkill")}</h3>
                    {canEditRuntime ? (
                      <button type="button" onClick={() => setManagingSkills((open) => !open)}>
                        <ProductIcon name={managingSkills ? "success" : "edit"} size={16} />
                        {managingSkills ? t("contacts.collapse") : t("contacts.manageSkills")}
                      </button>
                    ) : null}
                  </div>
                  <div className="contacts-capability-card">
                    {managingSkills && canEditRuntime ? (
                      <>
                        <div className="contacts-skill-toolbar">
                          <label className="contacts-skill-search">
                            <ProductIcon name="search" size={15} />
                            <input
                              value={skillQuery}
                              onChange={(event) => setSkillQuery(event.target.value)}
                              placeholder={t("contacts.searchSkillPlaceholder")}
                            />
                          </label>
                          <div className="contacts-skill-batch-actions">
                            <button
                              type="button"
                              disabled={directSaving || !props.onReset}
                              onClick={props.onReset}
                            >
                              <ProductIcon name="refresh" size={15} />
                              <span>{t("contacts.resetAvailable")}</span>
                            </button>
                            <button
                              type="button"
                              disabled={directSaving || !props.onSelectAll}
                              onClick={props.onSelectAll}
                            >
                              <ProductIcon name="success" size={15} />
                              <span>{t("contacts.allAvailable")}</span>
                            </button>
                            <button
                              type="button"
                              disabled={directSaving || !props.onClear}
                              onClick={props.onClear}
                            >
                              <ProductIcon name="close" size={15} />
                              <span>{t("commands.clearTitle")}</span>
                            </button>
                          </div>
                        </div>
                        <div className="contacts-skill-picker" aria-label={t("contacts.skillPickerLabel")}>
                          {filteredSkillOptions.map((skill) => {
                            const available = availableSkillIds.includes(skill.id);
                            const required = effectiveSkillIds.includes(skill.id);
                            return (
                              <div
                                className="contacts-skill-option"
                                data-selected={available ? "true" : "false"}
                                key={skill.id}
                              >
                                <span className="contacts-capability-row-icon" aria-hidden="true">
                                  <ProductIcon name="extensions" size={18} />
                                </span>
                                <span className="contacts-skill-copy">
                                  <strong>{skill.title || skill.name}</strong>
                                  <small>
                                    {skill.description || t("contacts.skillCommandFallback", { name: skill.name })}
                                  </small>
                                </span>
                                <span className="contacts-skill-mode-controls">
                                  <label>
                                    <input
                                      type="checkbox"
                                      checked={available}
                                      disabled={directSaving || !props.onToggleAvailable}
                                      onChange={() => toggleAvailableSkill(skill.id)}
                                    />
                                    <span>{available ? <ProductIcon name="success" size={12} /> : null}</span>
                                    {t("common.available")}
                                  </label>
                                  <label>
                                    <input
                                      type="checkbox"
                                      checked={required}
                                      disabled={directSaving}
                                      onChange={() => toggleRequiredSkill(skill.id)}
                                    />
                                    <span>{required ? <ProductIcon name="success" size={12} /> : null}</span>
                                    {t("contacts.skillRequired")}
                                  </label>
                                </span>
                              </div>
                            );
                          })}
                          {!filteredSkillOptions.length ? (
                            <div className="contacts-capability-empty">{t("contacts.noSelectableSkills")}</div>
                          ) : null}
                        </div>
                      </>
                    ) : effectiveSkills.length ? (
                      <div className="contacts-capability-list">
                        {effectiveSkills.map((skill) => (
                          <div className="contacts-capability-row" key={skill.id}>
                            <span className="contacts-capability-row-icon" aria-hidden="true">
                              <ProductIcon name="extensions" size={18} />
                            </span>
                            <span className="contacts-skill-copy">
                              <strong>{skill.title || skill.name}</strong>
                              <small>
                                {skill.description || t("contacts.skillCommandFallback", { name: skill.name })}
                              </small>
                            </span>
                            {canEditRuntime ? (
                              <Tooltip content={t("contacts.removeFromDefaultSkills")} side="left">
                                <button
                                  className="contacts-capability-row-action"
                                  type="button"
                                  disabled={directSaving || !props.onRemoveRequired}
                                  onClick={() => removeDefaultSkill(skill.id)}
                                  aria-label={t("mountedApp.removeMember", { name: skill.title || skill.name })}
                                >
                                  <ProductIcon name="close" size={15} />
                                </button>
                              </Tooltip>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div
                        className="contacts-capability-empty contacts-editable-panel"
                        role={canEditRuntime ? "button" : undefined}
                        tabIndex={canEditRuntime ? 0 : undefined}
                        onClick={() => {if (canEditRuntime) setManagingSkills(true)}}
                        onKeyDown={(event) => {
                          if (!canEditRuntime) return;
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          setManagingSkills(true);
                        }}
                      >
                        {t("contacts.noDefaultSkillsHint")}
                      </div>
                    )}
                  </div>
                </section>

                <section className="contacts-capability-section">
                  <div className="contacts-capability-section-heading">
                    <h3>{t("settings.extensionKindTool")}</h3>
                  </div>
                  <div className="contacts-capability-card">
                    {toolIds.length ? (
                      <div className="contacts-capability-list">
                        {toolIds.map((toolId) => (
                          <div className="contacts-capability-row" key={toolId}>
                            <span className="contacts-capability-row-icon" aria-hidden="true">
                              <ProductIcon name="tools" size={18} />
                            </span>
                            <span className="contacts-skill-copy">
                              <strong>{toolId}</strong>
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="contacts-capability-empty">{t("contacts.noToolsDeclared")}</div>
                    )}
                  </div>
                </section>
              </section>
);
}
