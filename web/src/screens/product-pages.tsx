import { useState } from "react";
import { AppCreateDialog, Catalog, InlineNotice } from "@olorinm/agent-frontend";
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
export function FilesScreen() {
  const { language } = useI18n();
  return (
    <Unconnected
      name={language === "zh-CN" ? "共享文件浏览" : "Shared file browsing"}
    />
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
export function CreateAppScreen({
  open,
  onCancel,
  onStore,
}: {
  open: boolean;
  onCancel(): void;
  onStore(): void;
}) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState("");
  const close = () => {
    setName("");
    setDescription("");
    setSource("");
    onCancel();
  };
  return (
    <AppCreateDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      notice={<Unconnected name={zh ? "应用创建" : "App creation"} />}
      title={name}
      description={description}
      source={source}
      onTitleChange={setName}
      onDescriptionChange={setDescription}
      onSourceChange={setSource}
      canRequestAgent={false}
      onRequestAgent={() => {}}
      onCancel={close}
      onOpenStore={() => {
        close();
        onStore();
      }}
    />
  );
}
