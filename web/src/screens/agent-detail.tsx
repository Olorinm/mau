import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DetailHero,
  EmployeeAvatar,
  ListRow,
  ProductIcon,
  SegmentedControl,
  SelectMenu,
  SettingsSection,
  StatusLine,
  TextButton,
  useConfirm,
  useToast,
  type ProductStatusTone,
} from "@olorinm/agent-ui/app";
import {
  mauApi,
  routerApi,
  type AgentSummary,
  type ConnectionJob,
  type ConnectorAccount,
  type EnvironmentAction,
} from "../api/client";
import { ApiError } from "../api/http";
import type { Session } from "../api/session";
import { errorMessage, useI18n } from "../i18n";
import { availableActions, canDestroy, stateTone } from "../status";
import { ConnectChannelDialog } from "./connect-channel";
import { AppMark, productFor, productIdFor } from "../settings/app-marks";
import { openSettings } from "../settings/route";
import { employeeDocuments, memoryTarget, type EmployeeDocument } from "./side-views";

const actionLabel = {
  pause: "env.pause",
  resume: "env.resume",
  reconcile: "env.reconcile",
  destroy: "env.destroy",
} as const;
type LineTone = "success" | "danger" | "warning" | "neutral";
const lineTone: Record<ProductStatusTone, LineTone> = { success: "success", error: "danger", warning: "warning", neutral: "neutral", running: "neutral" };
const checkTone: Record<string, LineTone> = {
  verified: "success",
  needs_action: "warning",
  not_verified: "neutral",
};
const channels = [
  "feishu",
  "weixin",
  "telegram",
  "grove-mail",
] as const;
const isChannel = (kind: string): kind is (typeof channels)[number] =>
  (channels as readonly string[]).includes(kind);
type Tab = "status" | "channels" | "abilities" | "documents" | "config";
/** The select's value for "use the runtime's own default"; no model or effort has this name. */
const DEFAULT_CHOICE = "\u0000default";
const effortNames: Record<string, string> = { none: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
const effortLabel = (value: string, zh: boolean) => (zh ? effortNames[value] : undefined) ?? value;

/** One employee, in the people panel: what state it is in, how it is reached, what it can use, and its settings. */
export function AgentDetail(props: {
  session: Session;
  summary: AgentSummary;
  /** The document open beside the conversation, and opening another (or closing the open one). */
  document?: EmployeeDocument | undefined;
  onDocument?(name: EmployeeDocument | undefined): void;
}) {
  const { t, language } = useI18n();
  const { toast } = useToast();
  const confirm = useConfirm();
  const queries = useQueryClient();
  const { agent, environment } = props.summary;
  const { connections } = props.summary;
  const mau = mauApi(props.session.token),
    router = routerApi(props.session.token);
  const [connecting, setConnecting] = useState<{ job?: ConnectionJob } | null>(
    null,
  );
  const [tab, setTab] = useState<Tab>("status");
  const zh = language === "zh-CN";
  // The connector accounts this employee may use; the same query as the settings page, read when the tab opens.
  const accounts = useQuery({
    queryKey: ["connector-accounts", props.session.owner],
    queryFn: mau.connectorAccounts,
    enabled: tab === "abilities",
    staleTime: 30_000,
  });
  const memory = useQuery({ queryKey: ["agent-memory", agent.id], queryFn: () => mau.agentMemory(agent.id), enabled: tab === "documents" });
  const models = useQuery({ queryKey: ["model-settings", agent.id], queryFn: () => mau.modelSettings(agent.id), enabled: tab === "config" });
  const usable = (accounts.data?.data ?? []).filter((account) => account.assignedAgents?.includes(agent.id));
  const accountStatus = (account: ConnectorAccount) =>
    account.state === "connected" ? <StatusLine tone="success">{zh ? "可用" : "Available"}</StatusLine>
      : ["expired", "authorization_required", "needs_attention", "needs_setup"].includes(account.state) ? <StatusLine tone="warning">{zh ? "需要处理" : "Needs attention"}</StatusLine>
      : account.state === "authorization_pending" ? <StatusLine tone="warning">{zh ? "等待授权" : "Waiting"}</StatusLine>
      : <StatusLine>{zh ? "未连接" : "Not connected"}</StatusLine>;
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
  const remove = useMutation({
    mutationFn: () => mau.deleteAgent(agent.id),
    onSuccess: () => {
      toast({ kind: "success", title: t("agents.deleted", { name: agent.name }) });
      void refresh();
    },
    onError: failed,
  });
  const selectModel = useMutation({
    mutationFn: (change: { model?: string | null; effort?: string | null }) => mau.selectModelSettings(agent.id, change),
    onSuccess: (view) => queries.setQueryData(["model-settings", agent.id], view),
    onError: failed,
  });
  const checks = useMutation({
    mutationFn: () => router.check(agent.id),
    onError: failed,
  });
  // Model and effort apply to the employee's following turns. Without a list from the runtime owner they are read-only.
  const modelRows = () => {
    const view = models.data, modelTitle = zh ? "模型" : "Model", effortTitle = zh ? "思考强度" : "Reasoning effort";
    if (!view?.models.length) return <ListRow title={modelTitle} trailing={<span className="mau-profile-value">{view?.defaultModel ?? "—"}</span>} />;
    const chosen = view.models.find((option) => option.id === (view.selection.model ?? view.defaultModel));
    const efforts = chosen?.efforts ?? view.efforts, standard = zh ? "默认" : "Default";
    const pick = (model: string | null) => {
      const next = view.models.find((option) => option.id === (model ?? view.defaultModel))?.efforts ?? view.efforts;
      // An effort the newly chosen model does not offer returns to that model's default.
      selectModel.mutate({ model, ...(view.selection.effort && !next.includes(view.selection.effort) ? { effort: null } : {}) });
    };
    return <>
      <ListRow title={modelTitle} trailing={<SelectMenu label={modelTitle} disabled={selectModel.isPending} value={view.selection.model ?? DEFAULT_CHOICE}
        options={[{ value: DEFAULT_CHOICE, label: view.defaultModel ? `${standard} · ${view.models.find((option) => option.id === view.defaultModel)?.label ?? view.defaultModel}` : standard },
          ...view.models.map((option) => ({ value: option.id, label: option.label }))]}
        onChange={(value) => pick(value === DEFAULT_CHOICE ? null : value)} />} />
      {efforts.length ? <ListRow title={effortTitle} trailing={<SelectMenu label={effortTitle} disabled={selectModel.isPending} value={view.selection.effort ?? DEFAULT_CHOICE}
        options={[{ value: DEFAULT_CHOICE, label: standard }, ...efforts.map((value) => ({ value, label: effortLabel(value, zh) }))]}
        onChange={(value) => selectModel.mutate({ effort: value === DEFAULT_CHOICE ? null : value })} />} /> : null}
    </>;
  };
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

  const destroy = async () => {
    const result = await confirm({
      title: t("env.destroyTitle", { name: agent.name }),
      body: t("env.destroyBody"),
      confirmLabel: t("env.destroy"),
      danger: true,
    });
    if (result === "primary") lifecycle.mutate("destroy");
  };
  const deleteAgent = async () => {
    const result = await confirm({
      title: t("agents.deleteTitle", { name: agent.name }),
      body: t("agents.deleteBody"),
      confirmLabel: t("agents.delete"),
      danger: true,
    });
    if (result === "primary") remove.mutate();
  };

  const icon = (name: "ops" | "chat" | "extensions" | "copy" | "settings") => <ProductIcon name={name} size={18} />;
  return (
    <>
      <div className="mau-profile">
        <DetailHero icon={<EmployeeAvatar seed={agent.id} fallbackName={agent.name} size={72} />} title={agent.name} />
        <SegmentedControl<Tab> display="icon" className="mau-profile-tabs" label={zh ? "员工资料分类" : "Profile sections"} value={tab} onChange={setTab}
          options={[
            { value: "status", label: zh ? "状态" : "Status", icon: icon("ops") },
            { value: "channels", label: t("channels.title"), icon: icon("chat") },
            { value: "abilities", label: zh ? "能力" : "Capabilities", icon: icon("extensions") },
            { value: "documents", label: zh ? "文档" : "Documents", icon: icon("copy") },
            { value: "config", label: zh ? "配置" : "Configuration", icon: icon("settings"), divided: true },
          ]} />
        {tab === "status" ? (
          <>
            <SettingsSection title={t("env.title")}>
              <ListRow
                title={t("env.state")}
                {...(state === "sleeping" ? { subtitle: t("env.sleepingHint") } : state === "paused" ? { subtitle: t("env.pausedHint") } : {})}
                trailing={<StatusLine tone={lineTone[stateTone(environment)]}>{t(`state.${state}`)}</StatusLine>}
              />
              {environment?.error ? <ListRow muted title={errorMessage(t, environment.error)} /> : null}
              {availableActions(environment).map((action) => (
                <ListRow key={action} tone="action" disabled={busy} title={t(actionLabel[action])} onClick={() => lifecycle.mutate(action)} />
              ))}
              {state === "unconfigured" ? profiles.map((p) => (
                <ListRow key={p.id} tone="action" disabled={busy} title={`${t("env.configure")} · ${p.label}`} onClick={() => configure.mutate(p.id)} />
              )) : null}
            </SettingsSection>
            <SettingsSection title={t("check.title")}
              action={<TextButton disabled={checks.isPending} onClick={() => checks.mutate()}>{t("check.run")}</TextButton>}>
              {checks.data ? checks.data.map((check, index) => (
                <ListRow
                  key={`${check.kind}:${check.connectionId ?? index}`}
                  title={check.kind === "host" ? t("check.host") : check.kind === "connections" ? t("channels.title") : isChannel(check.kind) ? t(`channel.${check.kind}`) : check.kind}
                  {...(check.detail ? { subtitle: check.detail } : {})}
                  trailing={<StatusLine tone={checkTone[check.status] ?? "neutral"}>{t(`check.${check.status}`)}</StatusLine>}
                />
              )) : <ListRow muted title={zh ? "还没有运行过自检" : "No checks run yet"} />}
            </SettingsSection>
          </>
        ) : tab === "channels" ? (
          <SettingsSection title={t("channels.title")} action={<TextButton onClick={() => setConnecting({})}>{t("channels.connect")}</TextButton>}>
            {connections.length || pending.length ? null : <ListRow muted title={t("channels.empty")} />}
            {connections.map((connection) => (
              <ListRow key={connection.id} icon={<AppMark id={connection.kind} />} title={t(`channel.${connection.kind}`)}
                trailing={<StatusLine tone="success">{zh ? "已连接" : "Connected"}</StatusLine>} />
            ))}
            {pending.map((job) => (
              <ListRow key={job.id} icon={<AppMark id={job.kind} />} title={t(`channel.${job.kind}`)} subtitle={t(`job.${job.state}`)}
                trailing={<TextButton onClick={() => setConnecting({ job })}>{t("channels.resume")}</TextButton>} />
            ))}
          </SettingsSection>
        ) : tab === "abilities" ? (
          <SettingsSection title={zh ? "连接器" : "Connectors"}
            action={<TextButton onClick={() => openSettings({ section: "connectors" })}>{zh ? "管理" : "Manage"}</TextButton>}>
            {accounts.isPending ? <ListRow muted title={zh ? "正在读取…" : "Loading…"} />
              : accounts.isError ? <ListRow muted title={errorMessage(t, accounts.error instanceof ApiError ? accounts.error.code : "request_failed")} />
              : usable.length ? usable.map((account) => {
                const product = productFor(productIdFor(account), usable);
                return <ListRow key={account.id} icon={<AppMark id={productIdFor(account)} />}
                  title={product ? (zh ? product.name : product.en ?? product.name) : account.label} trailing={accountStatus(account)} />;
              })
              : <ListRow muted title={zh ? "还没有可用的连接器" : "No connectors yet"} />}
          </SettingsSection>
        ) : tab === "documents" ? (
          <SettingsSection title={zh ? "文档" : "Documents"}>
            {employeeDocuments.map((name) => {
              const file = memory.data?.files.find((item) => item.target === memoryTarget(name));
              return <ListRow key={name} icon={<span className="mau-settings-glyph">{icon("copy")}</span>} title={name} ariaLabel={name}
                onClick={() => props.onDocument?.(props.document === name ? undefined : name)}
                trailing={<span className="mau-profile-value">{!memoryTarget(name) ? (zh ? "只读" : "Read-only") : file ? `${file.usage.used} / ${file.usage.limit}` : ""}</span>} />;
            })}
          </SettingsSection>
        ) : (
          <>
            <SettingsSection title={zh ? "运行方式" : "Runtime"}>
              <ListRow title={zh ? "内核" : "Kernel"} trailing={<span className="mau-profile-value">{profile?.kernel ?? "—"}</span>} />
              {modelRows()}
              <ListRow title={t("env.profile")} trailing={<span className="mau-profile-value">{profile?.label ?? "—"}</span>} />
            </SettingsSection>
            <SettingsSection>
              {canDestroy(environment) ? <ListRow tone="danger" disabled={busy} title={t("env.destroy")} onClick={() => void destroy()} /> : null}
              <ListRow tone="danger" disabled={busy || remove.isPending} title={remove.isPending ? t("agents.deleting") : t("agents.delete")} onClick={() => void deleteAgent()} />
            </SettingsSection>
          </>
        )}
      </div>
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
