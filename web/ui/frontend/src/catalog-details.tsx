// Original store requirements, employee details and diagnostic chips; package policy is supplied by caller.
import {ObjectSettingsSection, ObjectSettingsRow, ProductStatus} from "@olorinm/agent-ui/app";
import {RoomMemberAvatar} from "./people/member-avatar";
import type {MemberIdentity} from "./people/identity";
import {useI18n} from "./presentation/i18n";
export interface CatalogEmployeeView extends MemberIdentity {kernel?: string; model?: string; role?: string; publicDescription?: string; inputSpec?: string; outputSpec?: string; publicSkills?: string[]; tools?: {id: string; title?: string}[]}
export interface CatalogDetailView {
 id: string; publishKind?: "app" | "employee"; packageKey?: string; visibility?: string; visibilityLabel?: string;
 openIssue?: string; updateAvailable?: boolean; updateSafe?: boolean; employee?: CatalogEmployeeView; agents?: CatalogEmployeeView[];
 requirements?: {kind: string; label: string; items: string[]}[];
 dependencies?: {skills?: {id: string; title?: string; name?: string}[]; tools?: {id: string; title?: string}[]; kernels?: string[]; runtimes?: string[]};
 doctor?: {ok: boolean; summary: string; items: {kind: string; id: string; status: string; label: string}[]};
}
export function CatalogDetails({item}: {item: CatalogDetailView}) {
 const {t} = useI18n(); const isEmployee = item.publishKind === "employee";
 const employee = item.employee ?? item.agents?.[0];
 const dependencySkills = item.dependencies?.skills ?? [], dependencyTools = item.dependencies?.tools ?? employee?.tools ?? [], dependencyKernels = item.dependencies?.kernels ?? [], dependencyRuntimes = item.dependencies?.runtimes ?? [];
 const requirementGroups = item.requirements ?? [];
 return <>
        <ObjectSettingsSection
          title={isEmployee ? t("appStore.employeeDetailsAriaLabel") : t("appStore.packageDetailsAriaLabel")}
          className="app-store-dialog-overview"
        >
          <ObjectSettingsRow
            title={t("appStore.typeLabel")}
            value={isEmployee ? t("appStore.employeePackage") : t("appStore.appPackage")}
          />
          {item.visibility ? (
            <ObjectSettingsRow
              title={t("contacts.visibility")}
              value={item.visibilityLabel ?? item.visibility}
            />
          ) : null}
          <ObjectSettingsRow
            title={item.packageKey ? t("appStore.packageKeyLabel") : t("appStore.packageIdLabel")}
            value={item.packageKey ?? item.id}
          />
          {item.openIssue ? (
            <ObjectSettingsRow
              title={t("appStore.localStateLabel")}
              value={<ProductStatus tone="warning" compact label={item.openIssue} />}
            />
          ) : null}
          {item.updateAvailable && item.updateSafe === false ? (
            <ObjectSettingsRow title={t("appStore.updateMethodLabel")} value={t("appStore.updateMethodManual")} />
          ) : null}
          {employee?.kernel ? <ObjectSettingsRow title={t("appStore.kernelLabel")} value={employee.kernel} /> : null}
          {employee?.model ? <ObjectSettingsRow title={t("composer.model")} value={employee.model} /> : null}
          {dependencyKernels.length ? (
            <ObjectSettingsRow title={t("appStore.requiredKernelsLabel")} value={dependencyKernels.join(", ")} />
          ) : null}
          {dependencyRuntimes.length ? (
            <ObjectSettingsRow title={t("appStore.runtimesLabel")} value={dependencyRuntimes.join(", ")} />
          ) : null}
          <ObjectSettingsRow
            title={t("appStore.doctorLabel")}
            value={
              <ProductStatus
                tone={item.doctor?.ok === false ? "warning" : "success"}
                compact
                label={item.doctor?.summary ?? ""}
              />
            }
          />
          {employee?.role ? <ObjectSettingsRow title={t("appStore.roleLabel")} detail={employee.role} /> : null}
          {employee?.publicDescription ? (
            <ObjectSettingsRow title={t("appStore.publicDescriptionLabel")} detail={employee.publicDescription} />
          ) : null}
          {employee?.inputSpec ? (
            <ObjectSettingsRow title={t("appStore.inputSpecLabel")} detail={employee.inputSpec} />
          ) : null}
          {employee?.outputSpec ? (
            <ObjectSettingsRow title={t("appStore.outputSpecLabel")} detail={employee.outputSpec} />
          ) : null}
        </ObjectSettingsSection>
        {employee?.publicSkills?.length ? (
          <div className="app-store-dialog-chip-section" aria-label={t("appStore.publicSkills")}>
            <strong>{t("appStore.publicSkills")}</strong>
            <div>
              {employee.publicSkills.map((skill) => (
                <span key={skill}>{skill}</span>
              ))}
            </div>
          </div>
        ) : null}
        {requirementGroups.length ? (
          <div className="app-store-dialog-requirements" aria-label={t("appStore.postInstallConfig")}>
            <strong>{t("appStore.postInstallConfig")}</strong>
            {requirementGroups.map((group) => (
              <div key={group.kind}>
                <span>{group.label}</span>
                <div>
                  {group.items.map((item) => (
                    <code key={`${group.kind}-${item}`}>{item}</code>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {dependencySkills.length ? (
          <div className="app-store-dialog-chip-section" aria-label={t("appStore.includedSkillsAriaLabel")}>
            <strong>Skills</strong>
            <div>
              {dependencySkills.map((skill) => (
                <span key={skill.id}>{skill.title || skill.name || skill.id}</span>
              ))}
            </div>
          </div>
        ) : null}
        {dependencyTools.length ? (
          <div className="app-store-dialog-chip-section" aria-label={t("appStore.includedToolsAriaLabel")}>
            <strong>Tools</strong>
            <div>
              {dependencyTools.map((tool) => (
                <span key={tool.id}>{tool.title || tool.id}</span>
              ))}
            </div>
          </div>
        ) : null}
        {item.doctor?.items.length ? (
          <div className="app-store-dialog-doctor" aria-label={t("appStore.doctorDetailsAriaLabel")}>
            {item.doctor.items.map((item) => (
              <span key={`${item.kind}-${item.id}`} data-status={item.status}>
                {item.label}
              </span>
            ))}
          </div>
        ) : null}

</>;
}
export function CatalogAgentStack(props: { agents: MemberIdentity[]; limit?: number }) {
  const { language } = useI18n();
  const limit = props.limit ?? 3;
  const visible = props.agents.slice(0, limit);
  const remaining = Math.max(0, props.agents.length - visible.length);
  return (
    <span
      className="app-store-agent-stack"
      aria-label={new Intl.ListFormat(language === "zh-CN" ? "zh-CN" : "en-US", {
        style: "short",
        type: "conjunction",
      }).format(props.agents.map((agent) => agent.name))}
    >
      {visible.map((agent) => (
        <RoomMemberAvatar
          key={agent.id}
          member={{
            id: agent.id,
            name: agent.name,
            avatarMode: agent.avatarMode,
            avatarSeed: agent.avatarSeed,
            avatarDataUrl: agent.avatarDataUrl,
            status: "idle",
            color: "#64748b",
            source: "local",
          }}
          showStatus={false}
        />
      ))}
      {remaining ? <span className="app-store-agent-stack-more">+{remaining}</span> : null}
    </span>
  );
}
