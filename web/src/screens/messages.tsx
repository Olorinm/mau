import { useQuery } from "@tanstack/react-query";
import { LoadingSurface } from "@olorinm/agent-ui/pages";
import { Button } from "@olorinm/agent-ui/app";
import { ApiError } from "../api/http";
import type { Session } from "../api/session";
import { errorMessage, useI18n } from "../i18n";
import { attachmentLimits, ledgerApi } from "../api/ledger";
import { LedgerMessagesScreen } from "./ledger-messages";

type MessagesProps = {
  session: Session;
  initialAgentId?: string | undefined;
  onStartHandled?(): void;
};

/** Chats are served by Router's owner ledger (agent-router ADR 0005). */
export function MessagesScreen(props: MessagesProps) {
  const { t } = useI18n();
  const me = useQuery({
    queryKey: ["ledger-me", props.session.token],
    queryFn: ({ signal }) => ledgerApi(props.session.token).me(signal),
    retry: false,
    staleTime: 5 * 60_000,
  });
  if (me.isPending) return <LoadingSurface label={t("common.loading")} />;
  if (me.isError) return (
    <div className="mau-error" role="alert">
      {errorMessage(t, me.error instanceof ApiError ? me.error.code : "request_failed")}
      <Button disabled={me.isFetching} onClick={() => void me.refetch()}>{t("common.retry")}</Button>
    </div>
  );
  return <LedgerMessagesScreen {...props} limits={attachmentLimits(me.data)} />;
}
