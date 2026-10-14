import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, EmployeeAvatar, EmptyState, ObjectSettingsRow, ObjectSettingsSection, ProductStatus, useCompactLayout } from "@olorinm/agent-ui/app";
import { mauApi, type AgentSummary } from "../api/client";
import type { Session } from "../api/session";
import { errorMessage, useI18n } from "../i18n";
import { ApiError } from "../api/http";
import { stateTone } from "../status";
import { AgentDetail } from "./agent-detail";
import { CreateAgentDialog } from "./create-agent";

const selectedKey = "agent";
const readSelected = () => new URLSearchParams(location.search).get(selectedKey);

export function AgentsScreen({ session }: { session: Session }) {
  const { t } = useI18n();
  const compact = useCompactLayout();
  const [selected, setSelected] = useState<string | null>(readSelected);
  const [creating, setCreating] = useState(false);
  const agents = useQuery({
    queryKey: ["agents", session.owner],
    queryFn: () => mauApi(session.token).agents(),
    // Provisioning and lifecycle changes are durable server operations; poll faster only while one runs.
    refetchInterval: (query) => query.state.data?.some((a) => a.environment?.busy) ? 1000 : 10_000,
  });
  useEffect(() => {
    const url = new URL(location.href);
    if (selected) url.searchParams.set(selectedKey, selected);
    else url.searchParams.delete(selectedKey);
    history.replaceState(null, "", url);
  }, [selected]);
  const list = agents.data ?? [];
  const current = list.find((a) => a.agent.id === selected);
  const showList = !compact || !current;
  const showDetail = !compact || !!current;

  return (
    <div className="mau-agents" data-compact={compact || undefined}>
      {showList ? (
        <section className="mau-list" aria-label={t("agents.title")}>
          <div className="mau-section-heading">
            <h2>{t("agents.title")}</h2>
            <Button variant="primary" onClick={() => setCreating(true)}>{t("agents.create")}</Button>
          </div>
          {agents.isPending ? <p className="mau-muted">{t("common.loading")}</p> : null}
          {agents.error ? (
            <div className="mau-error" role="alert">
              {errorMessage(t, agents.error instanceof ApiError ? agents.error.code : "request_failed")}
              <Button onClick={() => void agents.refetch()}>{t("common.retry")}</Button>
            </div>
          ) : null}
          {agents.isSuccess && !list.length ? (
            <EmptyState illustration="sprout" title={t("agents.empty")} description={t("agents.emptyDetail")}
              actions={[{ label: t("agents.create"), onClick: () => setCreating(true), variant: "primary" }]} />
          ) : null}
          {list.length ? (
            <ObjectSettingsSection>
              {list.map((summary) => <AgentRow key={summary.agent.id} summary={summary}
                selected={summary.agent.id === selected} onSelect={() => setSelected(summary.agent.id)} />)}
            </ObjectSettingsSection>
          ) : null}
        </section>
      ) : null}
      {showDetail ? (
        <section className="mau-detail">
          {current ? (
            <AgentDetail key={current.agent.id} session={session} summary={current}
              {...(compact ? { onBack: () => setSelected(null) } : {})} />
          ) : list.length ? <p className="mau-muted mau-placeholder">{t("agents.select")}</p> : null}
        </section>
      ) : null}
      {creating ? (
        <CreateAgentDialog session={session} onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); setSelected(id); void agents.refetch(); }} />
      ) : null}
    </div>
  );
}

function AgentRow(props: { summary: AgentSummary; selected: boolean; onSelect(): void }) {
  const { t } = useI18n();
  const { agent, environment } = props.summary;
  return (
    <ObjectSettingsRow
      {...(props.selected ? { className: "mau-row-selected" } : {})}
      leading={<EmployeeAvatar seed={agent.id} fallbackName={agent.name} size={36} />}
      title={agent.name}
      detail={agent.address}
      value={<ProductStatus compact tone={stateTone(environment)} label={t(`state.${environment?.state ?? "unconfigured"}`)} />}
      onClick={props.onSelect}
    />
  );
}
