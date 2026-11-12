import {useState} from "react";
import {ChevronDown,ChevronRight,FileText} from "lucide-react";
import {useI18n} from "../presentation/i18n";
export interface FlowRunView {path:string;title:string;status:string;description:string}
export interface FlowGroupView {id:string;title:string;status:string;active?:boolean;description:string;latestFlow:{path:string};flows:FlowRunView[]}
export function AppFlowList(props: {
  groups: FlowGroupView[];
  loading: boolean;
  historyLimit?: number;
  selectedPath: string;
  onSelect(path: string): void;
}) {
  const { t } = useI18n();
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(() => new Set());
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(() => new Set());
  const [expandedHistoryGroupIds, setExpandedHistoryGroupIds] = useState<Set<string>>(() => new Set());

  function toggleGroup(groupId: string, expanded: boolean) {
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      if (expanded) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (expanded) {
        next.add(groupId);
      } else {
        next.delete(groupId);
      }
      return next;
    });
  }

  function expandHistory(groupId: string) {
    setExpandedHistoryGroupIds((current) => {
      const next = new Set(current);
      next.add(groupId);
      return next;
    });
  }

  if (props.loading) {
    return <MountedAppDirectoryLoadingState label={t("mountedApp.loading")} />;
  }
  if (!props.groups.length) {
    return (
      <div className="mounted-app-tree-state">
        <FileText size={15} />
        <span>{t("mountedApp.noWorkflows")}</span>
      </div>
    );
  }
  return (
    <div className="mounted-app-flow-list">
      {props.groups.map((group) => {
        const active = group.flows.some((flow) => flow.path === props.selectedPath);
        const collapsed = collapsedGroupIds.has(group.id);
        const expanded =
          !collapsed &&
          (active || expandedGroupIds.has(group.id) || !!group.active);
        const fullHistoryExpanded = expandedHistoryGroupIds.has(group.id);
        const visibleRuns = fullHistoryExpanded ? group.flows : group.flows.slice(0, (props.historyLimit ?? 10));
        const hiddenRunCount = Math.max(0, group.flows.length - visibleRuns.length);
        const groupMeta = group.description;
        return (
          <section className="mounted-app-flow-group" key={group.id}>
            <div className="mounted-app-flow-workflow">
              <button
                className="mounted-app-flow-expander"
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? t("mountedApp.flowCollapseRuns") : t("mountedApp.flowExpandRuns")}
                title={expanded ? t("mountedApp.flowCollapseRuns") : t("mountedApp.flowExpandRuns")}
                onClick={() => toggleGroup(group.id, expanded)}
              >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <button
                className="mounted-app-flow-workflow-row"
                type="button"
                data-active={active ? "true" : "false"}
                data-status={group.status}
                onClick={() => props.onSelect(group.latestFlow.path)}
              >
                <FileText size={14} />
                <span>
                  <strong>{group.title}</strong>
                  <small>{groupMeta}</small>
                </span>
              </button>
            </div>
            {expanded ? (
              <div className="mounted-app-flow-run-list">
                {visibleRuns.map((flow) => {
                  const status = flow.status;
                  const runTime = flow.title;
                  return (
                    <button
                      className="mounted-app-flow-row"
                      type="button"
                      data-active={flow.path === props.selectedPath ? "true" : "false"}
                      data-status={status}
                      key={flow.path}
                      onClick={() => props.onSelect(flow.path)}
                    >
                      <FileText size={13} />
                      <span>
                        <strong>{runTime}</strong>
                        <small>
                          {flow.description}
                        </small>
                      </span>
                    </button>
                  );
                })}
                {hiddenRunCount ? (
                  <button className="mounted-app-flow-more-runs" type="button" onClick={() => expandHistory(group.id)}>
                    {t("mountedApp.flowMoreRuns", { count: hiddenRunCount })}
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function MountedAppDirectoryLoadingState(props: { label: string }) {
  return (
    <div className="og-skeleton-stack" role="status" aria-label={props.label} aria-busy="true">
      <span className="og-skeleton og-skeleton-line" style={{ width: "68%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "84%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "58%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "76%" }} />
    </div>
  );
}
