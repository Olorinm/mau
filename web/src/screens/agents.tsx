import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, EmployeeAvatar, EmptyState, ProductStatus } from "@olorinm/agent-ui/app";
import { ListDetailLayout, ItemList, PageHeader } from "@olorinm/agent-frontend";
import { mauApi } from "../api/client";
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

  return (
    <>
      <ListDetailLayout detailOpen={!!current} onBack={() => setSelected(null)} backLabel={t("agents.title")}
        list={<>
          <PageHeader title={t("agents.title")} actions={<Button variant="primary" onClick={() => setCreating(true)}>{t("agents.create")}</Button>} />
          {agents.isPending ? <p className="mau-muted">{t("common.loading")}</p> : null}
          {agents.error ? <div className="mau-error" role="alert">
            {errorMessage(t, agents.error instanceof ApiError ? agents.error.code : "request_failed")}
            <Button onClick={() => void agents.refetch()}>{t("common.retry")}</Button>
          </div> : null}
          <ItemList label={t("agents.title")} {...(selected ? {selectedId:selected} : {})} onSelect={setSelected}
            items={list.map(({agent,environment}) => ({id:agent.id,title:agent.name,description:agent.address,
              leading:<EmployeeAvatar seed={agent.id} fallbackName={agent.name} size={36} />,
              trailing:<ProductStatus compact tone={stateTone(environment)} label={t(`state.${environment?.state ?? "unconfigured"}`)} />
            }))} empty={agents.isSuccess ? <EmptyState illustration="sprout" title={t("agents.empty")} description={t("agents.emptyDetail")}
              actions={[{label:t("agents.create"),onClick:()=>setCreating(true),variant:"primary"}]} /> : null} />
        </>}
        detail={current ? <div className="mau-agent-detail"><AgentDetail key={current.agent.id} session={session} summary={current} /></div> : null}
        empty={<EmptyState illustration="sprout" title={t("agents.select")} />} />
      {creating ? <CreateAgentDialog session={session} onClose={() => setCreating(false)}
        onCreated={(id) => {setCreating(false);setSelected(id);void agents.refetch();}} /> : null}
    </>
  );
}
