import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { LoadingSurface } from "@olorinm/agent-frontend";
import { Button } from "@olorinm/agent-ui/app";
import { ApiError } from "../api/http";
import type { Session } from "../api/session";
import { errorMessage, useI18n } from "../i18n";
import { attachmentLimits, chatSourcePreference, ledgerApi, ledgerFeatures, matrixEnabled } from "../api/ledger";
import { LedgerMessagesScreen } from "./ledger-messages";

// The Matrix chat source (and its Matrix client code) loads only when it is used (agent-router ADR 0005 19.3).
const MatrixMessagesScreen = lazy(() => import("./matrix-messages"));

type MessagesProps = {
  session: Session;
  initialAgentId?: string | undefined;
  onStartHandled?(): void;
};

/**
 * Matrix stays the chat source unless this browser opted in (`localStorage["mau.chatSource"] = "ledger"`)
 * and Router advertises the `history` feature (agent-router ADR 0005, phase 2). Otherwise nothing changes.
 * An edge login has no Matrix token, so it always uses the ledger; so does a Router with Matrix off (19.3).
 */
export function MessagesScreen(props: MessagesProps) {
  const { t } = useI18n();
  const me = useQuery({
    queryKey: ["ledger-me", props.session.token],
    queryFn: ({ signal }) => ledgerApi(props.session.token).me(signal),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const preferLedger = !!props.session.edge || chatSourcePreference() === "ledger";
  if (me.isPending) return <LoadingSurface label={t("common.loading")} />;
  // An edge login has no Matrix account: a failed request is retried, never answered with the Matrix console.
  if (me.isError && props.session.edge) return (
    <div className="mau-error" role="alert">
      {errorMessage(t, me.error instanceof ApiError ? me.error.code : "request_failed")}
      <Button disabled={me.isFetching} onClick={() => void me.refetch()}>{t("common.retry")}</Button>
    </div>
  );
  const features = ledgerFeatures(me.data);
  const matrix = (groups: boolean) => (
    <Suspense fallback={<LoadingSurface label={t("common.loading")} />}><MatrixMessagesScreen {...props} matrixGroups={groups} /></Suspense>
  );
  if (!preferLedger && matrixEnabled(me.data)) return matrix(true);
  // A Router without the ledger web API (or with history off) keeps the Matrix console.
  if (!features.has("history")) return matrix(!features.has("groups"));
  return <LedgerMessagesScreen {...props} features={features} limits={attachmentLimits(me.data)} matrix={matrixEnabled(me.data)} />;
}
