import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  EmployeeAvatar,
  EmptyState,
  ProductStatus,
} from "@olorinm/agent-ui/app";
import {
  ListDetailLayout,
  ItemList,
  SidebarHeader,
  CollaborationTabs,
  SearchField,
  LoadingSurface,
} from "@olorinm/agent-frontend";
import { mauApi } from "../api/client";
import type { Session } from "../api/session";
import { errorMessage, useI18n } from "../i18n";
import { ApiError } from "../api/http";
import { stateTone } from "../status";
import { AgentDetail } from "./agent-detail";
import { CreateAgentDialog } from "./create-agent";

const selectedKey = "agent";
const readSelected = () =>
  new URLSearchParams(location.search).get(selectedKey);

export function AgentsScreen({
  session,
  onMessages,
}: {
  session: Session;
  onMessages(id?: string): void;
}) {
  const { t, language } = useI18n();
  const zh = language === "zh-CN";
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(readSelected);
  const [creating, setCreating] = useState(false);
  const agents = useQuery({
    queryKey: ["agents", session.owner],
    queryFn: () => mauApi(session.token).agents(),
    // Provisioning and lifecycle changes are durable server operations; poll faster only while one runs.
    refetchInterval: (query) =>
      query.state.data?.some((a) => a.environment?.busy) ? 1000 : 10_000,
  });
  useEffect(() => {
    const url = new URL(location.href);
    if (selected) url.searchParams.set(selectedKey, selected);
    else url.searchParams.delete(selectedKey);
    history.replaceState(null, "", url);
  }, [selected]);
  const list = agents.data ?? [];
  useEffect(() => {
    if (!selected && list.length && matchMedia("(min-width: 901px)").matches)
      setSelected(list[0]!.agent.id);
  }, [list, selected]);
  const current = list.find((a) => a.agent.id === selected);

  return (
    <>
      <ListDetailLayout
        variant="contacts"
        detailOpen={!!current}
        onBack={() => setSelected(null)}
        backLabel={t("agents.title")}
        list={
          <>
            <SidebarHeader
              variant="contacts"
              title={zh ? "消息" : "Messages"}
              actions={[
                {
                  id: "create",
                  label: t("agents.create"),
                  onSelect: () => setCreating(true),
                },
              ]}
            />
            <CollaborationTabs
              label={zh ? "员工视图" : "Agent views"}
              items={[
                { id: "messages", label: zh ? "对话" : "Conversations" },
                { id: "contacts", label: zh ? "通讯录" : "Contacts" },
              ]}
              selectedId="contacts"
              onSelect={(id) => {
                if (id === "messages") onMessages();
              }}
            />
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder={zh ? "搜索联系人" : "Search contacts"}
            />
            {agents.isPending ? (
              <LoadingSurface label={t("common.loading")} />
            ) : null}
            {agents.error ? (
              <div className="mau-error" role="alert">
                {errorMessage(
                  t,
                  agents.error instanceof ApiError
                    ? agents.error.code
                    : "request_failed",
                )}
                <Button onClick={() => void agents.refetch()}>
                  {t("common.retry")}
                </Button>
              </div>
            ) : null}
            <ItemList
              variant="contacts"
              heading={t("agents.title")}
              count={zh ? `${list.length} 个员工` : `${list.length} Agents`}
              label={t("agents.title")}
              {...(selected ? { selectedId: selected } : {})}
              onSelect={setSelected}
              items={list
                .filter(({ agent }) =>
                  agent.name.toLowerCase().includes(search.toLowerCase()),
                )
                .map(({ agent, environment }) => ({
                  id: agent.id,
                  title: agent.name,
                  leading: (
                    <EmployeeAvatar
                      seed={agent.id}
                      fallbackName={agent.name}
                      size={24}
                    />
                  ),
                }))}
              empty={
                agents.isSuccess ? (
                  <EmptyState
                    illustration="sprout"
                    title={t("agents.empty")}
                    description={t("agents.emptyDetail")}
                    actions={[
                      {
                        label: t("agents.create"),
                        onClick: () => setCreating(true),
                        variant: "primary",
                      },
                    ]}
                  />
                ) : null
              }
            />
          </>
        }
        detail={
          current ? (
            <AgentDetail
              key={current.agent.id}
              session={session}
              summary={current}
              onMessage={() => onMessages(current.agent.id)}
            />
          ) : null
        }
        empty={<EmptyState illustration="sprout" title={t("agents.select")} />}
      />
      {creating ? (
        <CreateAgentDialog
          session={session}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
            void agents.refetch();
          }}
        />
      ) : null}
    </>
  );
}
