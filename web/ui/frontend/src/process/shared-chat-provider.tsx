import { ChatProvider } from "@olorinm/agent-ui";
import type { ReactNode } from "react";
import { useI18n } from "../presentation/i18n";
import { Button } from "@olorinm/agent-ui/app";
export function SharedChatProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <ChatProvider translate={t} Button={Button}>
      {children}
    </ChatProvider>
  );
}
