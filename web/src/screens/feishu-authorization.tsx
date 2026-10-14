import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, ObjectSettingsRow, ProductStatus } from "@olorinm/agent-ui/app";
import { routerApi } from "../api/client";
import { ApiError } from "../api/http";
import type { Session } from "../api/session";
import { errorMessage, useI18n } from "../i18n";
import { LinkCode } from "./link-code";

/** Owner authorization for Feishu personal tools; Router performs the official CLI flow. */
export function FeishuAuthorizationRow(props: { session: Session; agentId: string }) {
  const { t } = useI18n();
  const router = routerApi(props.session.token);
  const [link, setLink] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ["feishu-authorization", props.agentId],
    queryFn: () => router.feishuAuthorization(props.agentId),
    retry: false,
  });
  const begin = useMutation({
    mutationFn: () => router.beginFeishuAuthorization(props.agentId),
    onSuccess: (result) => setLink(result.verificationUrl),
  });
  const complete = useMutation({
    mutationFn: () => router.completeFeishuAuthorization(props.agentId),
    onSuccess: () => { setLink(null); void status.refetch(); },
  });
  const error = [status.error, begin.error, complete.error].find(Boolean);
  const authorized = status.data?.authorized && status.data.verified;
  return (
    <>
      <ObjectSettingsRow
        title={t("feishu.personal")}
        {...(error ? { detail: errorMessage(t, error instanceof ApiError ? error.code : "request_failed") } : {})}
        value={status.data ? (
          <ProductStatus compact tone={authorized ? "success" : "warning"}
            label={authorized ? t("feishu.authorized", { name: status.data.userName ?? "" }) : t("feishu.unauthorized")} />
        ) : null}
        {...(authorized ? {} : {
          trailing: <Button disabled={begin.isPending} onClick={() => begin.mutate()}>{t("feishu.authorize")}</Button>,
        })}
      />
      {link ? (
        <div className="mau-inline-panel">
          <p className="mau-muted">{t("feishu.scan")}</p>
          <LinkCode url={link} />
          <Button variant="primary" disabled={complete.isPending} onClick={() => complete.mutate()}>{t("feishu.complete")}</Button>
        </div>
      ) : null}
    </>
  );
}
