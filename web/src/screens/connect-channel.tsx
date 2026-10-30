import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Dialog, DialogContent, DialogTitle, ProductStatus, useToast } from "@olorinm/agent-ui/app";
import { isJob, routerApi, type AgentSummary, type ChannelKind, type ConnectionJob, type ConnectionRequest } from "../api/client";
import { ApiError } from "../api/http";
import type { Session } from "../api/session";
import { errorMessage, useI18n } from "../i18n";
import { LinkCode } from "./link-code";

const kinds: ChannelKind[] = ["feishu", "weixin", "telegram", "matrix", "grove-mail"];
const terminal = (job: ConnectionJob) => job.state === "ready" || job.state === "failed";

export function ConnectChannelDialog(props: {
  session: Session;
  summary: AgentSummary;
  job?: ConnectionJob;
  initialKind?: ChannelKind;
  onClose(): void;
  onConnected(): void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const router = routerApi(props.session.token);
  const agentId = props.summary.agent.id;
  const connected = new Set(props.summary.connections.map((c) => c.kind));
  const [kind, setKind] = useState<ChannelKind | null>(props.job?.kind ?? props.initialKind ?? null);
  const [job, setJob] = useState<ConnectionJob | null>(props.job ?? null);
  const [recovery, setRecovery] = useState<ConnectionJob["recovery"]>();
  const done = (channel: ChannelKind) => {
    toast({ kind: "success", title: channel === "matrix" ? t("connect.matrixReady") : t("connect.ready", { channel: t(`channel.${channel}`) }) });
    props.onConnected();
    props.onClose();
  };
  const connect = useMutation({
    mutationFn: (body: ConnectionRequest) => router.connect(agentId, body),
    onSuccess: (result, body) => { if (isJob(result)) setJob(result); else done(body.kind); },
  });
  const error = connect.error instanceof ApiError ? connect.error.code : connect.error ? "request_failed" : null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="mau-dialog" aria-describedby={undefined}>
        <DialogTitle>{kind ? t(`channel.${kind}`) : t("connect.title")}</DialogTitle>
        {job ? (
          <JobProgress session={props.session} agentId={agentId} initial={job} onReady={() => done(job.kind)}
            onRecover={(next) => { setRecovery(next); setJob(null); connect.reset(); }} />
        ) : kind ? (
          <ChannelForm recovery={recovery} kind={kind} summary={props.summary} session={props.session} pending={connect.isPending}
            onBack={props.job ? undefined : () => { connect.reset(); setKind(null); }}
            onSubmit={(body) => connect.mutate(body)}>
            {error ? <p className="mau-error" role="alert">{errorMessage(t, error)}</p> : null}
          </ChannelForm>
        ) : (
          <div className="mau-form">
            <p className="mau-muted">{t("connect.choose")}</p>
            <div className="mau-channel-grid">
              {kinds.map((k) => (
                <button key={k} type="button" className="mau-channel-choice" disabled={connected.has(k)} onClick={() => setKind(k)}>
                  <strong>{t(`channel.${k}`)}</strong>
                  {connected.has(k) ? <ProductStatus compact tone="success" label={t("job.ready")} /> : null}
                </button>
              ))}
            </div>
            <div className="modal-actions"><Button onClick={props.onClose}>{t("common.close")}</Button></div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChannelForm(props: {
  kind: ChannelKind;
  summary: AgentSummary;
  session: Session;
  pending: boolean;
  recovery: ConnectionJob["recovery"];
  children: ReactNode;
  onBack: (() => void) | undefined;
  onSubmit(body: ConnectionRequest): void;
}) {
  const { t } = useI18n();
  const [domain, setDomain] = useState<"feishu" | "lark">(props.recovery?.domain ?? "feishu");
  const hostReady = !!props.summary.host;
  const [personalTools, setPersonalTools] = useState(props.recovery?.personalTools ?? hostReady);
  const [appId, setAppId] = useState(props.recovery?.appId ?? "");
  const existingRequired = props.recovery?.action === "authorize_existing_app";
  const [token, setToken] = useState("");
  const [mail, setMail] = useState({ serviceId: "", inboxId: "", ownerEmail: "", apiKey: "" });
  const mailServices = useQuery({
    queryKey: ["connection-options"],
    queryFn: () => routerApi(props.session.token).connectionOptions(),
    enabled: props.kind === "grove-mail",
  });
  const services = mailServices.data?.mailServices ?? [];
  const serviceId = mail.serviceId || services[0]?.id || "";
  const body = (): ConnectionRequest | null => {
    switch (props.kind) {
      case "feishu": {
        const id = appId.trim();
        if (existingRequired && !id || id && !/^cli_[a-zA-Z0-9_]{1,128}$/.test(id)) return null;
        return { kind: "feishu", domain, personalTools: hostReady && personalTools, ...(id ? { appId: id } : {}) };
      }
      case "weixin": return { kind: "weixin" };
      case "matrix": return { kind: "matrix" };
      case "telegram": return token.trim() ? { kind: "telegram", token: token.trim() } : null;
      case "grove-mail":
        return serviceId && mail.inboxId && mail.ownerEmail && mail.apiKey
          ? { kind: "grove-mail", serviceId, inboxId: mail.inboxId.trim(), ownerEmail: mail.ownerEmail.trim(), apiKey: mail.apiKey.trim() }
          : null;
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const request = body();
    if (request && !props.pending) props.onSubmit(request);
  };
  return (
    <form className="mau-form" onSubmit={submit}>
      {props.kind === "feishu" ? (
        <>
          <label className="mau-field">
            <span>{t("connect.appId")}</span>
            <input value={appId} onChange={(e) => setAppId(e.target.value)} autoComplete="off" required={existingRequired} placeholder="cli_…" />
            <small>{t(existingRequired ? "connect.recoveryHint" : "connect.appIdHint")}</small>
          </label>
          <fieldset className="mau-field">
            <legend>{t("connect.domain")}</legend>
            {(["feishu", "lark"] as const).map((value) => (
              <label key={value} className="mau-choice">
                <input type="radio" name="domain" checked={domain === value} onChange={() => setDomain(value)} />
                <span><strong>{t(value === "feishu" ? "connect.domainFeishu" : "connect.domainLark")}</strong></span>
              </label>
            ))}
          </fieldset>
          <label className="mau-check">
            <input type="checkbox" checked={hostReady && personalTools} disabled={!hostReady}
              onChange={(e) => setPersonalTools(e.target.checked)} />
            <span>{t("connect.personalTools")}{hostReady ? null : <small>{t("connect.personalToolsNeedsHost")}</small>}</span>
          </label>
        </>
      ) : null}
      {props.kind === "telegram" ? (
        <label className="mau-field">
          <span>{t("connect.telegramToken")}</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required />
          <small>{t("connect.telegramHint")}</small>
        </label>
      ) : null}
      {props.kind === "grove-mail" ? (
        mailServices.isSuccess && !services.length ? <p className="mau-muted">{t("connect.noMail")}</p> : (
          <>
            <label className="mau-field">
              <span>{t("connect.mailService")}</span>
              <select value={serviceId} onChange={(e) => setMail({ ...mail, serviceId: e.target.value })}>
                {services.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            <label className="mau-field">
              <span>{t("connect.mailInbox")}</span>
              <input type="email" value={mail.inboxId} onChange={(e) => setMail({ ...mail, inboxId: e.target.value })} required />
            </label>
            <label className="mau-field">
              <span>{t("connect.mailOwner")}</span>
              <input type="email" value={mail.ownerEmail} onChange={(e) => setMail({ ...mail, ownerEmail: e.target.value })} required />
            </label>
            <label className="mau-field">
              <span>{t("connect.mailKey")}</span>
              <input type="password" value={mail.apiKey} onChange={(e) => setMail({ ...mail, apiKey: e.target.value })}
                autoComplete="off" required />
            </label>
          </>
        )
      ) : null}
      {props.children}
      <div className="modal-actions">
        {props.onBack ? <Button onClick={props.onBack}>{t("common.back")}</Button> : null}
        <Button type="submit" variant="primary" disabled={!body() || props.pending}>
          {props.pending ? t("common.loading") : t("connect.start")}
        </Button>
      </div>
    </form>
  );
}

function JobProgress(props: { session: Session; agentId: string; initial: ConnectionJob; onReady(): void; onRecover(recovery: ConnectionJob["recovery"]): void }) {
  const { t, language } = useI18n();
  const router = routerApi(props.session.token);
  const [code, setCode] = useState("");
  const job = useQuery({
    queryKey: ["job", props.agentId, props.initial.id],
    queryFn: () => router.job(props.agentId, props.initial.id),
    initialData: props.initial,
    // Keep polling through temporary network/server failures, but stop for expired
    // jobs and permanent client errors. The server supplies each job deadline.
    refetchInterval: (query) => {
      const { data, error } = query.state;
      const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429;
      return data && !terminal(data) && Date.parse(data.expiresAt) > Date.now() && !rejected ? 2000 : false;
    },
    retry: false,
  });
  const pair = useMutation({ mutationFn: () => router.pair(props.agentId, props.initial.id, code.trim()) });
  const current = job.data;
  const reported = useRef(false), onReady = useRef(props.onReady);
  onReady.current = props.onReady;
  useEffect(() => {
    if (current.state !== "ready" || reported.current) return;
    reported.current = true;
    onReady.current();
  }, [current.state]);
  const expired = job.error instanceof ApiError && job.error.code === "setup_job_not_found" ||
    !terminal(current) && !(Date.parse(current.expiresAt) > Date.now());
  if (expired || current.state === "failed") return (
    <div className="mau-form">
      <p className="mau-error" role="alert">{expired ? t("job.expired") : t("job.failed")}
        {current.error ? ` · ${errorMessage(t, current.error)}` : ""}</p>
      {current.kind === "feishu" ? <>
        <p>{t("connect.recoveryHint")}</p>
        <Button onClick={() => props.onRecover(current.recovery ?? { action: "authorize_existing_app", domain: "feishu", personalTools: false })}>
          {t("connect.recover")}
        </Button>
      </> : null}
    </div>
  );
  const expires = new Intl.DateTimeFormat(language, { timeStyle: "short" }).format(new Date(current.expiresAt));
  return (
    <div className="mau-form" aria-live="polite">
      <ProductStatus tone={current.state === "ready" ? "success" : "running"} label={t(`job.${current.state}`)} />
      {job.error ? (
        <div className="mau-error" role="alert">
          {errorMessage(t, job.error instanceof ApiError ? job.error.code : "request_failed")}
          <Button disabled={job.isFetching} onClick={() => void job.refetch()}>{t("common.retry")}</Button>
        </div>
      ) : null}
      {current.state === "pairing" ? (
        <form className="mau-inline-form" onSubmit={(e) => { e.preventDefault(); if (code.trim()) pair.mutate(); }}>
          <label className="mau-field">
            <span>{t("job.code")}</span>
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} inputMode="numeric"
              autoComplete="one-time-code" maxLength={12} required />
          </label>
          <Button type="submit" variant="primary" disabled={!code.trim() || pair.isPending}>{t("job.submitCode")}</Button>
          {pair.error ? <p className="mau-error" role="alert">
            {errorMessage(t, pair.error instanceof ApiError ? pair.error.code : "request_failed")}</p> : null}
        </form>
      ) : <LinkCode url={current.url} />}
      <small className="mau-muted">{t("connect.expires", { time: expires })}</small>
    </div>
  );
}
