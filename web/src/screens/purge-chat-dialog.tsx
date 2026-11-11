import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Modal, ModalActions } from "@olorinm/agent-ui/app";
import { ApiError } from "../api/http";
import { errorMessage, useI18n } from "../i18n";

/**
 * Confirms clearing a chat's history for good: the chat's name must be typed, and a running task has to be stopped
 * first (`session_busy` turns the button into "stop and clear"). Used by the "/clear" command and by data controls.
 */
export function PurgeChatDialog({ chat, purge, onClose, onPurged }: {
  chat: { chatId: string; title: string } | undefined;
  purge(chatId: string, cancelActive: boolean): Promise<unknown>;
  onClose(): void;
  onPurged?(chat: { chatId: string; title: string }): void;
}) {
  const { t, language } = useI18n(), zh = language === "zh-CN";
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useMutation({
    mutationFn: (input: { chatId: string; title: string; cancelActive: boolean }) => purge(input.chatId, input.cancelActive),
    onSuccess: (_data, input) => { onClose(); onPurged?.({ chatId: input.chatId, title: input.title }); },
    onError: (error) => { if (error instanceof ApiError && error.code === "session_busy") setBusy(true); },
  });
  useEffect(() => { setTyped(""); setBusy(false); request.reset(); }, [chat?.chatId]);
  return (
    <Modal open={!!chat} onOpenChange={(open) => { if (!open) onClose(); }} closeLabel={t("common.close")}
      title={zh ? "清空聊天记录？" : "Clear chat history?"}
      description={zh ? "聊天记录将被永久删除，无法撤销；员工已经写入的记忆不会被删除。这会删除你在所有渠道（网页、飞书、邮件等）与它的记录，并开始新对话。"
        : "The history is deleted permanently and cannot be undone; memories the employee already wrote are kept. This deletes your messages with it on every channel and starts a new chat."}
      actions={<ModalActions danger confirmLabel={busy ? zh ? "停止任务并清空" : "Stop and clear" : zh ? "永久清空" : "Clear permanently"}
        cancelLabel={t("common.cancel")} pending={request.isPending} disabled={!chat || typed.trim() !== chat.title}
        onConfirm={() => chat && request.mutate({ chatId: chat.chatId, title: chat.title, cancelActive: busy })} onCancel={onClose} />}>
      {chat ? <label className="mau-field">
        <span>{zh ? `输入“${chat.title}”确认` : `Type “${chat.title}” to confirm`}</span>
        <input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
      </label> : null}
      {busy ? <p className="mau-muted">{zh ? "当前任务进行中，清空前需要先停止它。" : "A task is running; it must stop first."}</p> : null}
      {request.error && !(request.error instanceof ApiError && request.error.code === "session_busy")
        ? <p className="mau-error" role="alert">{errorMessage(t, request.error instanceof ApiError ? request.error.code : "request_failed")}</p> : null}
    </Modal>
  );
}
