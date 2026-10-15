import { useThemePreference } from "../theme";
import { useState } from "react";
import {
  AppCreateWizard,
  Catalog,
  ExtensionsPage,
  InlineNotice,
  SettingsLayout,
  SettingsAppearancePanel,
  SettingsModePanel,
  SettingsAppsPanel,
  SettingsKernelPanel,
  SettingsDesktopPanel,
  SettingsUpdatePanel,
  SettingsNetworkPanel,
  usePresentationLabels,
} from "@olorinm/agent-frontend";
import { Button, ProductIcon } from "@olorinm/agent-ui/app";
import { useI18n } from "../i18n";

function Unconnected({ name }: { name: string }) {
  const { language } = useI18n();
  return (
    <InlineNotice
      title={language === "zh-CN" ? "尚未接入" : "Not connected yet"}
    >
      {language === "zh-CN"
        ? `Mau 尚未接入${name}服务。`
        : `${name} services are not connected to Mau yet.`}
    </InlineNotice>
  );
}
export function AppsScreen() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [query, setQuery] = useState("");
  return (
    <Catalog
      title={zh ? "App 商店" : "App Store"}
      connected={false}
      items={[]}
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder={zh ? "搜索 App" : "Search apps"}
      notice={<Unconnected name={zh ? "应用商店" : "App Store"} />}
      empty={zh ? "暂无可展示的 App" : "No apps available"}
    />
  );
}
export function ExtensionsScreen() {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [tab, setTab] = useState("skills");
  const [query, setQuery] = useState("");
  return (
    <ExtensionsPage
      title={zh ? "扩展" : "Extensions"}
      summary={zh ? "管理 Agent 的能力" : "Manage Agent capabilities"}
      tabs={[
        {
          id: "skills",
          label: "Skills",
          description: zh
            ? "管理可供 Agent 使用的技能。"
            : "Manage skills available to Agents.",
          icon: <ProductIcon name="tools" />,
        },
        {
          id: "mcp",
          label: "MCP",
          description: zh
            ? "管理工具与数据连接。"
            : "Manage tool and data connections.",
          icon: <ProductIcon name="network" />,
        },
        {
          id: "plugins",
          label: zh ? "内核插件" : "Kernel plugins",
          description: zh
            ? "管理内核可用的扩展。"
            : "Manage extensions available to kernels.",
          icon: <ProductIcon name="extensions" />,
        },
        {
          id: "hooks",
          label: "Hooks",
          description: zh ? "管理事件触发器。" : "Manage event hooks.",
          icon: <ProductIcon name="refresh" />,
        },
        {
          id: "tools",
          label: "Tools",
          description: zh ? "管理可用的工具。" : "Manage available tools.",
          icon: <ProductIcon name="tools" />,
        },
        {
          id: "cli",
          label: "CLI",
          description: zh
            ? "管理命令行扩展。"
            : "Manage command-line extensions.",
          icon: <ProductIcon name="kernel" />,
        },
      ]}
      selectedId={tab}
      onSelect={setTab}
      query={query}
      onQueryChange={setQuery}
      notice={
        <Unconnected
          name={zh ? "图形化扩展管理" : "Graphical extension management"}
        />
      }
      actions={<Button disabled>{zh ? "添加扩展" : "Add extension"}</Button>}
      empty={zh ? "暂无可展示的扩展" : "No extensions available"}
    />
  );
}
export function SettingsScreen() {
  const { language, setLanguage } = useI18n();
  const zh = language === "zh-CN";
  const [selected, setSelected] = useState("appearance");
  const [theme, setTheme] = useThemePreference();
  const items = [
    ["modes", zh ? "模式" : "Modes", "mode"],
    ["kernels", zh ? "内核" : "Kernels", "kernel"],
    ["appearance", zh ? "外观" : "Appearance", "appearance"],
    ["desktop", zh ? "桌面端" : "Desktop", "desktop"],
    ["updates", zh ? "版本更新" : "Updates", "refresh"],
    ["network", zh ? "网络" : "Network", "network"],
    ["ops", zh ? "运行中心" : "Operations", "ops"],
    ["providers", zh ? "模型提供方" : "Model providers", "provider"],
    ["apps", "Apps", "store"],
    ["voice", zh ? "语音" : "Voice", "voice"],
  ] as const;
  const { t } = usePresentationLabels();
  const noop = () => {};
  const panels: Record<string, React.ReactNode> = {
    modes: (
      <SettingsModePanel
        t={t}
        developerMode={false}
        loading={false}
        saving={false}
        onSaveDeveloperMode={noop}
      />
    ),
    kernels: (
      <SettingsKernelPanel
        t={t}
        kernels={[]}
        expandedKernelId=""
        kernelPathOverrides={{}}
        loading={false}
        saving={false}
        onToggleKernelExpanded={noop}
        onSetKernelPathDraft={noop}
        onSaveKernelPathOverride={noop}
      />
    ),
    desktop: <SettingsDesktopPanel />,
    updates: <SettingsUpdatePanel currentVersion="—" />,
    network: (
      <SettingsNetworkPanel
        t={t}
        kernelProxy={{
          enabled: false,
          proxyUrl: "",
          noProxy: "",
          nodeUseEnvProxy: false,
        }}
        showKernelProxy
        serviceUrl=""
        savedServiceUrl=""
        serviceManaged
        loading={false}
        saving={false}
        onSetServiceUrl={noop}
        onSaveServiceUrl={noop}
        onSetKernelProxyDraft={noop}
        onSaveKernelProxy={noop}
      />
    ),
    apps: (
      <SettingsAppsPanel
        t={t}
        mountedApps={[]}
        automaticUpdates={false}
        loading={false}
        saving={false}
        onPatchMountedAppDraft={noop}
        onUpdateMountedApp={noop}
        onRemoveMountedApp={noop}
        onSetAutomaticUpdates={noop}
      />
    ),
  };
  return (
    <SettingsLayout
      title={zh ? "设置" : "Settings"}
      kicker={zh ? "设置" : "Settings"}
      selectedId={selected}
      onSelect={setSelected}
      sections={items.map(([id, label, icon]) => ({
        id,
        label,
        icon: <ProductIcon name={icon} />,
        dividerAfter: id === "updates",
        description:
          id === "appearance"
            ? zh
              ? "主题和界面语言。"
              : "Theme and interface language."
            : undefined,
        content:
          id === "appearance" ? (
            <SettingsAppearancePanel
              t={t}
              themePreference={theme}
              themeSelectOptions={[
                { id: "system", label: zh ? "跟随系统" : "System" },
                { id: "light", label: zh ? "浅色" : "Light" },
                { id: "dark", label: zh ? "深色" : "Dark" },
              ]}
              iconStylePreference="professional"
              iconStyleSelectOptions={[
                { id: "professional", label: zh ? "专业风格" : "Professional" },
              ]}
              languagePreference={language}
              languageSelectOptions={[
                { id: "zh-CN", label: "简体中文" },
                { id: "en", label: "English" },
              ]}
              onSetThemePreference={setTheme}
              onSetIconStylePreference={noop}
              onSetLanguagePreference={(value) =>
                setLanguage(value as "zh-CN" | "en")
              }
            />
          ) : (
            <>
              <Unconnected name={label} />
              {panels[id] ? (
                <fieldset
                  disabled
                  style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
                >
                  {panels[id]}
                </fieldset>
              ) : null}
            </>
          ),
      }))}
    />
  );
}

export function CreateAppScreen({
  onCancel,
  onStore,
}: {
  onCancel(): void;
  onStore(): void;
}) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState("");
  return (
    <section className="view-panel tab-view">
      <Unconnected name={zh ? "应用创建" : "App creation"} />
      <AppCreateWizard
        title={name}
        description={description}
        source={source}
        onTitleChange={setName}
        onDescriptionChange={setDescription}
        onSourceChange={setSource}
        canRequestAgent={false}
        onRequestAgent={() => {}}
        onCancel={onCancel}
        onOpenStore={onStore}
      />
    </section>
  );
}
