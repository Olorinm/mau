// Product-independent, stateful component stories. Data and actions are examples only.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProductIcon } from "@olorinm/agent-ui/app";
import {
  FrontendProvider,
  AppShell,
  Navigation,
  SettingsLayout,
  SettingsAppearancePanel,
  SettingsProvidersPanel,
  ProviderEditor,
  SettingsOperationsPanel,
  Conversation,
  PageHeader,
  SidebarHeader,
  CollaborationTabs,
  ItemList,
  ListDetailLayout,
  RoomHeaderActions,
  Catalog,
  ExtensionsPage,
  AppCreateDialog,
  usePresentationLabels,
} from "@olorinm/agent-frontend";
import "@olorinm/agent-frontend/style.css";

const sections = [
  ["modes", "模式", "mode"],
  ["kernels", "内核", "kernel"],
  ["appearance", "外观", "appearance"],
  ["desktop", "桌面端", "desktop"],
  ["updates", "版本更新", "refresh"],
  ["network", "网络", "network"],
  ["ops", "运行中心", "ops"],
  ["providers", "模型提供方", "provider"],
  ["apps", "Apps", "store"],
  ["voice", "语音", "voice"],
];
const groups = [
  {
    id: "native",
    label: "原生 app",
    items: [
      { id: "messages", label: "员工", icon: <ProductIcon name="rooms" /> },
    ],
  },
  {
    id: "apps",
    label: "我的App",
    items: [
      { id: "create", label: "新建应用", icon: <ProductIcon name="add" /> },
    ],
  },
  {
    id: "resources",
    label: "资源",
    items: [
      { id: "catalog", label: "App 商店", icon: <ProductIcon name="store" /> },
    ],
  },
  {
    id: "configuration",
    label: "配置",
    items: [
      {
        id: "extensions",
        label: "扩展",
        icon: <ProductIcon name="extensions" />,
      },
      { id: "settings", label: "设置", icon: <ProductIcon name="settings" /> },
    ],
  },
];
function ProviderStory() {
  const [selected, setSelected] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [visible, setVisible] = useState(false);
  const [draft, setDraft] = useState({
    id: "example",
    name: "示例服务",
    protocol: "openai",
    baseUrl: "https://example.test/v1",
    apiKey: "",
    apiKeyEnv: "PROVIDER_API_KEY",
    description: "独立产品提供的数据",
  });
  const [models, setModels] = useState(["example-model"]);
  const [saved, setSaved] = useState("idle");
  return (
    <SettingsProvidersPanel
      providers={[
        {
          id: "example",
          name: draft.name,
          detail: "1 个模型 · 示例协议",
          enabled,
        },
      ]}
      selectedId={selected}
      onSelect={(id) => setSelected(selected === id ? "" : id)}
      onEnabledChange={(_, value) => setEnabled(value)}
      onAdd={() => setSelected("example")}
      editor={
        <ProviderEditor
          detailForm={draft}
          protocolOptions={[
            { id: "openai", label: "OpenAI" },
            { id: "anthropic", label: "Anthropic" },
          ]}
          editableProviderModels={models}
          providerApiKeyVisible={visible}
          providerSaveState={saved}
          onToggleProviderApiKeyVisible={() => setVisible(!visible)}
          onUpdateProviderField={(key, value) =>
            setDraft({ ...draft, [key]: value })
          }
          onUpdatePrimaryBaseUrl={(baseUrl) => setDraft({ ...draft, baseUrl })}
          onSetProviderModels={setModels}
          onUpdateProviderModel={(index, value) =>
            setModels(models.map((m, i) => (i === index ? value : m)))
          }
          onRemoveProviderModelAt={(index) =>
            setModels(models.filter((_, i) => i !== index))
          }
          onAddProviderModel={() => setModels([...models, ""])}
          onSaveProviderProfile={() => setSaved("saved")}
          onCloseProviderDetail={() => setSelected("")}
        />
      }
    />
  );
}
function OperationsStory() {
  const [selected, setSelected] = useState("");
  return (
    <SettingsOperationsPanel
      selectedId={selected}
      onSelect={setSelected}
      metrics={[
        { id: "runs", label: "运行", value: "1", meta: "本地示例" },
        {
          id: "failures",
          label: "失败",
          value: "0",
          meta: "无失败运行",
          tone: "good",
        },
        {
          id: "approvals",
          label: "审批",
          value: "0",
          meta: "无待处理审批",
          tone: "good",
        },
        { id: "events", label: "事件", value: "2", meta: "1 次执行" },
      ]}
      runs={[
        {
          id: "example",
          title: "检查组件界面",
          tone: "good",
          sourceLabel: "示例",
          statusLabel: "已完成",
          dateLabel: "2026-10-15 10:00",
          durationLabel: "2s",
          eventCount: 2,
          toolCount: 0,
          result: "组件正常显示。",
          input: "检查界面和交互。",
          sections: [
            {
              id: "events",
              title: "事件流",
              emptyLabel: "无事件",
              records: [
                { id: "done", title: "完成", detail: "调用方提供的显示内容" },
              ],
            },
          ],
        },
      ]}
    />
  );
}
function Stories() {
  const [view, setView] = useState("messages");
  const [section, setSection] = useState("appearance");
  const [theme, setTheme] = useState("system");
  const [language, setLanguage] = useState("zh-CN");
  const [iconStyle, setIconStyle] = useState("professional");
  return (
    <FrontendProvider theme={theme} language={language}>
      <StoryContent
        {...{
          view,
          setView,
          section,
          setSection,
          theme,
          setTheme,
          language,
          setLanguage,
          iconStyle,
          setIconStyle,
        }}
      />
    </FrontendProvider>
  );
}
function StoryContent({
  view,
  setView,
  section,
  setSection,
  theme,
  setTheme,
  language,
  setLanguage,
  iconStyle,
  setIconStyle,
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const { t } = usePresentationLabels();
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState(true);
  const [query, setQuery] = useState("");
  const [extension, setExtension] = useState("skills");
  const [messages, setMessages] = useState([]);
  const [files, setFiles] = useState([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState("");
  return (
    <AppShell
      brand="UI examples"
      navigation={
        <Navigation
          groups={groups}
          selectedId={view}
          onSelect={(id) =>
            id === "create" ? setCreateOpen(true) : setView(id)
          }
          account={{
            name: "示例账号",
            label: "账号",
            actions: [
              {
                id: "account",
                label: "账号设置",
                onSelect: () => setView("settings"),
              },
            ],
          }}
        />
      }
    >
      {view === "settings" && (
        <SettingsLayout
          title="设置"
          kicker="设置"
          selectedId={section}
          onSelect={setSection}
          sections={sections.map(([id, label, icon]) => ({
            id,
            label,
            icon: <ProductIcon name={icon} />,
            dividerAfter: id === "updates",
            description: id === "appearance" ? "主题和界面语言。" : undefined,
            content:
              id === "appearance" ? (
                <SettingsAppearancePanel
                  t={t}
                  themePreference={theme}
                  themeSelectOptions={[
                    { id: "system", label: "跟随系统" },
                    { id: "light", label: "浅色" },
                    { id: "dark", label: "深色" },
                  ]}
                  iconStylePreference={iconStyle}
                  iconStyleSelectOptions={[
                    { id: "professional", label: "专业风格" },
                    { id: "playful", label: "趣味风格" },
                  ]}
                  languagePreference={language}
                  languageSelectOptions={[
                    { id: "zh-CN", label: "简体中文" },
                    { id: "en", label: "English" },
                  ]}
                  onSetThemePreference={setTheme}
                  onSetIconStylePreference={setIconStyle}
                  onSetLanguagePreference={setLanguage}
                />
              ) : id === "providers" ? (
                <ProviderStory />
              ) : id === "ops" ? (
                <OperationsStory />
              ) : (
                <p>本示例未提供此类数据。</p>
              ),
          }))}
        />
      )}
      {view === "messages" && (
        <ListDetailLayout
          detailOpen={selected}
          onBack={() => setSelected(false)}
          list={
            <>
              <SidebarHeader title="消息" />
              <CollaborationTabs
                label="消息视图"
                selectedId="messages"
                items={[
                  { id: "messages", label: "对话" },
                  { id: "contacts", label: "通讯录" },
                ]}
                onSelect={() => {}}
              />
              <ItemList
                label="对话列表"
                selectedId={selected ? "guide" : undefined}
                items={[
                  {
                    id: "guide",
                    title: "新手引导员",
                    description: "还没有消息",
                  },
                ]}
                onSelect={() => setSelected(true)}
              />
            </>
          }
          detail={
            <Conversation
              header={
                <PageHeader
                  title="新手引导员"
                  actions={
                    <RoomHeaderActions
                      roomId="guide"
                      roomTitle="新手引导员"
                      messages={[]}
                      onLocateMessage={() => {}}
                    />
                  }
                />
              }
              messages={messages}
              composer={{
                value: draft,
                onChange: setDraft,
                placeholder: "发送给 新手引导员",
                onSend: () => {
                  setMessages([
                    ...messages,
                    {
                      id: String(messages.length),
                      role: "user",
                      title: "示例账号",
                      content: <p>{draft}</p>,
                    },
                  ]);
                  setDraft("");
                },
                onMentionClick: () => {},
                onFiles: (next) => setFiles([...files, ...next]),
                attachments: files.map((file, i) => ({
                  id: String(i),
                  name: file.name,
                  onRemove: () => setFiles(files.filter((_, n) => n !== i)),
                })),
              }}
            />
          }
        />
      )}
      {view === "catalog" && (
        <Catalog
          title="App 商店"
          items={[]}
          query={query}
          onQueryChange={setQuery}
        />
      )}
      {view === "extensions" && (
        <ExtensionsPage
          title="扩展"
          tabs={[
            { id: "skills", label: "Skills" },
            { id: "mcp", label: "MCP" },
            { id: "plugins", label: "内核插件" },
            { id: "hooks", label: "Hooks" },
            { id: "tools", label: "Tools" },
            { id: "cli", label: "CLI" },
          ]}
          selectedId={extension}
          onSelect={setExtension}
          query={query}
          onQueryChange={setQuery}
          rows={[
            {
              id: "example",
              title: "Example skill",
              description: "示例扩展",
              enabled: true,
            },
          ]}
        />
      )}
      <AppCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={name}
        description={description}
        source={source}
        onTitleChange={setName}
        onDescriptionChange={setDescription}
        onSourceChange={setSource}
        onCancel={() => setCreateOpen(false)}
        onOpenStore={() => {
          setCreateOpen(false);
          setView("catalog");
        }}
        onChooseLocalFolder={() => setSource("/example/workspace")}
        onRequestAgent={() => setCreateOpen(false)}
        canRequestAgent
      />
    </AppShell>
  );
}
createRoot(document.getElementById("root")).render(<Stories />);
