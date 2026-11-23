import { useState } from "react";
import { AppCreateDialog, InlineNotice } from "@olorinm/agent-ui/pages";
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
export function CreateAppScreen({
  open,
  onCancel,
}: {
  open: boolean;
  onCancel(): void;
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
    />
  );
}
