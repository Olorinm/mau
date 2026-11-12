import { ChatProvider } from "../../index";
import type { ReactNode } from "react";
import { useI18n } from "../presentation/i18n";
import { Button } from "../../app/index";
export function SharedChatProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <ChatProvider translate={t} Button={Button}>
      {children}
    </ChatProvider>
  );
}
