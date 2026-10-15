import { ProfileSurface, InlineNotice } from "@olorinm/agent-frontend";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  EmployeeAvatar,
  ObjectSettingsRow,
  ObjectSettingsSection,
  ProductStatus,
  useConfirm,
  useToast,
  type ProductStatusTone,
} from "@olorinm/agent-ui/app";
import {
  mauApi,
  routerApi,
  type AgentSummary,
  type ConnectionJob,
  type EnvironmentAction,
} from "../api/client";
import { ApiError } from "../api/http";
import type { Session } from "../api/session";
import { errorMessage, useI18n } from "../i18n";
import { availableActions, canDestroy, stateTone } from "../status";
import { ConnectChannelDialog } from "./connect-channel";
import { FeishuAuthorizationRow } from "./feishu-authorization";

const actionLabel = {
  pause: "env.pause",
  resume: "env.resume",
  reconcile: "env.reconcile",
  destroy: "env.destroy",
} as const;
const checkTone: Record<string, ProductStatusTone> = {
  verified: "success",
  needs_action: "warning",
  not_verified: "neutral",
};
const channels = [
  "feishu",
  "weixin",
  "telegram",
  "matrix",
  "grove-mail",
] as const;
const isChannel = (kind: string): kind is (typeof channels)[number] =>
  (channels as readonly string[]).includes(kind);

export function AgentDetail(props: {
  session: Session;
  summary: AgentSummary;
  onMessage?: () => void;
}) {
  const { t, language } = useI18n();
  const { toast } = useToast();
  const confirm = useConfirm();
  const queries = useQueryClient();
  const { agent, environment, connections } = props.summary;
  const mau = mauApi(props.session.token),
    router = routerApi(props.session.token);
  const [connecting, setConnecting] = useState<{ job?: ConnectionJob } | null>(
    null,
  );
  const options = useQuery({
    queryKey: ["options", props.session.owner],
    queryFn: mau.options,
  });
  const jobs = useQuery({
    queryKey: ["jobs", agent.id],
    queryFn: () => router.jobs(agent.id),
  });
  const refresh = () =>
    queries.invalidateQueries({ queryKey: ["agents", props.session.owner] });
  // A 401 already returns to sign-in with its own notice.
  const failed = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) return;
    toast({
      kind: "error",
      title: errorMessage(
        t,
        error instanceof ApiError ? error.code : "request_failed",
      ),
    });
  };
  const lifecycle = useMutation({
    mutationFn: (action: EnvironmentAction) =>
      mau.environmentAction(agent.id, action),
    onSuccess: refresh,
    onError: failed,
  });
  const configure = useMutation({
    mutationFn: (profileId: string) =>
      mau.createEnvironment(agent.id, profileId),
    onSuccess: refresh,
    onError: failed,
  });
  const checks = useMutation({
    mutationFn: () => router.check(agent.id),
    onError: failed,
  });
  const profiles = options.data?.environments ?? [];
  const profile = profiles.find((p) => p.id === environment?.profileId);
  const state = environment?.state ?? "unconfigured";
  const busy =
    !!environment?.busy || lifecycle.isPending || configure.isPending;
  const latest = (jobs.data ?? []).filter(
    (job, index, all) =>
      !all.slice(index + 1).some((next) => next.kind === job.kind),
  );
  const pending = latest.filter(
    (job) =>
      !connections.some((connection) => connection.kind === job.kind) &&
      ((job.state === "failed" && job.recovery) ||
        (!["ready", "failed"].includes(job.state) &&
          Date.parse(job.expiresAt) > Date.now())),
  );
  const time = (iso: string) =>
    new Intl.DateTimeFormat(language, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));

  const destroy = async () => {
    const result = await confirm({
      title: t("env.destroyTitle", { name: agent.name }),
      body: t("env.destroyBody"),
      confirmLabel: t("env.destroy"),
      danger: true,
    });
    if (result === "primary") lifecycle.mutate("destroy");
  };

  return (
    <>
      <ProfileSurface
        name={agent.name}
        avatar={
          <EmployeeAvatar
            seed={agent.id}
            fallbackName={agent.name}
            size={112}
          />
        }
        actions={[
          {
            id: "message",
            label: language === "zh-CN" ? "发消息" : "Message",
            icon: "rooms",
            onSelect: () => props.onMessage?.(),
          },
          {
            id: "channel",
            label: t("channels.connect"),
            icon: "network",
            onSelect: () => setConnecting({}),
          },
        ]}
        activity={{
          title: t(`state.${state}`),
          metrics: [
            { label: t("channels.title"), value: connections.length },
            { label: t("env.profile"), value: profile?.label ?? "—" },
          ],
        }}
        pages={[
          {
            id: "capabilities",
            label: language === "zh-CN" ? "能力" : "Capabilities",
            icon: "extensions",
            content: (
              <InlineNotice
                title={language === "zh-CN" ? "尚未接入" : "Not connected yet"}
              >
                {language === "zh-CN"
                  ? "Mau 尚未接入图形化能力管理。"
                  : "Graphical capability management is not connected to Mau yet."}
              </InlineNotice>
            ),
          },
        ]}
        overview={
          <div className="mau-agent">
            <ObjectSettingsSection title={t("env.title")}>
              <ObjectSettingsRow
                title={t("env.state")}
                {...(state === "sleeping"
                  ? { detail: t("env.sleepingHint") }
                  : state === "paused"
                    ? { detail: t("env.pausedHint") }
                    : {})}
                value={
                  <ProductStatus
                    tone={stateTone(environment)}
                    label={t(`state.${state}`)}
                  />
                }
              />
              {environment?.error ? (
                <ObjectSettingsRow title={errorMessage(t, environment.error)} />
              ) : null}
              {profile ? (
                <ObjectSettingsRow
                  title={t("env.profile")}
                  value={profile.label}
                  detail={profile.kernel}
                />
              ) : null}
              {environment?.updatedAt ? (
                <ObjectSettingsRow
                  title={t("env.updated")}
                  value={time(environment.updatedAt)}
                />
              ) : null}
            </ObjectSettingsSection>
            <div className="mau-actions">
              {availableActions(environment).map((action) => (
                <Button
                  key={action}
                  variant={
                    action === "resume" || action === "reconcile"
                      ? "primary"
                      : "ghost"
                  }
                  disabled={busy}
                  onClick={() => lifecycle.mutate(action)}
                >
                  {t(actionLabel[action])}
                </Button>
              ))}
              {state === "unconfigured"
                ? profiles.map((p) => (
                    <Button
                      key={p.id}
                      variant="primary"
                      disabled={busy}
                      onClick={() => configure.mutate(p.id)}
                    >
                      {t("env.configure")} · {p.label}
                    </Button>
                  ))
                : null}
            </div>

            <ObjectSettingsSection
              title={t("channels.title")}
              action={
                <Button onClick={() => setConnecting({})}>
                  {t("channels.connect")}
                </Button>
              }
            >
              {connections.length || pending.length ? null : (
                <ObjectSettingsRow title={t("channels.empty")} />
              )}
              {connections.map((connection) => (
                <ObjectSettingsRow
                  key={connection.id}
                  title={t(`channel.${connection.kind}`)}
                  value={
                    <ProductStatus
                      compact
                      tone="success"
                      label={t("job.ready")}
                    />
                  }
                />
              ))}
              {connections.some(
                (c) => c.kind === "feishu" && c.personalTools,
              ) ? (
                <FeishuAuthorizationRow
                  session={props.session}
                  agentId={agent.id}
                />
              ) : null}
              {pending.map((job) => (
                <ObjectSettingsRow
                  key={job.id}
                  title={t(`channel.${job.kind}`)}
                  detail={t(`job.${job.state}`)}
                  trailing={
                    <Button onClick={() => setConnecting({ job })}>
                      {t("channels.resume")}
                    </Button>
                  }
                />
              ))}
            </ObjectSettingsSection>

            <ObjectSettingsSection
              title={t("check.title")}
              action={
                <Button
                  disabled={checks.isPending}
                  onClick={() => checks.mutate()}
                >
                  {t("check.run")}
                </Button>
              }
            >
              {checks.data ? (
                checks.data.map((check, index) => (
                  <ObjectSettingsRow
                    key={`${check.kind}:${check.connectionId ?? index}`}
                    title={
                      check.kind === "host"
                        ? t("check.host")
                        : check.kind === "feishu_personal"
                          ? t("feishu.personal")
                          : check.kind === "connections"
                            ? t("channels.title")
                            : isChannel(check.kind)
                              ? t(`channel.${check.kind}`)
                              : check.kind
                    }
                    detail={check.detail}
                    value={
                      <ProductStatus
                        compact
                        tone={checkTone[check.status] ?? "neutral"}
                        label={t(`check.${check.status}`)}
                      />
                    }
                  />
                ))
              ) : (
                <ObjectSettingsRow title={t("check.empty")} />
              )}
            </ObjectSettingsSection>

            {canDestroy(environment) ? (
              <div className="mau-actions mau-danger">
                <button
                  type="button"
                  className="danger-button"
                  disabled={busy}
                  onClick={() => void destroy()}
                >
                  {t("env.destroy")}
                </button>
              </div>
            ) : null}
          </div>
        }
      />
      {connecting ? (
        <ConnectChannelDialog
          session={props.session}
          summary={props.summary}
          {...(connecting.job ? { job: connecting.job } : {})}
          onClose={() => {
            setConnecting(null);
            void jobs.refetch();
          }}
          onConnected={() => {
            void jobs.refetch();
            void refresh();
          }}
        />
      ) : null}
    </>
  );
}
