// Original EmployeeSettingsSurface activity subpage; all metrics and records supplied by caller.
import {ProductIcon} from "@olorinm/agent-ui/app";
import {useI18n} from "../presentation/i18n";
export interface EmployeeActivityView {
 currentWork?: string; totalRuns: number; successRate: number; averageDuration?: string; failedRuns: number;
 recentRuns: {id: string; title: string; status: string; createdAt: string; duration?: string; statusLabel: string}[];
}
export function EmployeeActivity({activity}: {activity: EmployeeActivityView}) {
 const {t} = useI18n(); return (
              <section className="contacts-console-section" aria-label={t("contacts.employeeActivity")}>
                <div className="contacts-activity-card quiet">
                  <strong>{t("common.current")}</strong>
                  <span>{activity.currentWork || t("contacts.noOngoingWork")}</span>
                </div>
                <div className="contacts-activity-card metric">
                  <span>{t("contacts.performance30d")}</span>
                  <strong>{activity.totalRuns}</strong>
                  <p>
                    {t("contacts.performanceSummary", {
                      successRate: activity.successRate,
                      averageDuration: activity.averageDuration || "-",
                      failedRuns: activity.failedRuns,
                    })}
                  </p>
                </div>
                <div className="contacts-activity-card">
                  <strong>{t("contacts.recentActivity")}</strong>
                  {activity.recentRuns.length ? (
                    <div className="contacts-recent-run-list">
                      {activity.recentRuns.map((run) => (
                        <div key={run.id} className="contacts-recent-run" data-status={run.status}>
                          <span aria-hidden="true">
                            <ProductIcon
                              name={
                                run.status === "running"
                                  ? "loading"
                                  : run.status === "failed" || run.status === "interrupted"
                                    ? "error"
                                    : run.status === "done"
                                      ? "success"
                                      : "send"
                              }
                              size={19}
                            />
                          </span>
                          <div>
                            <strong>{run.title}</strong>
                            <small>
                              {run.createdAt} · {run.duration || t("contacts.unknownDuration")} · {run.statusLabel}
                            </small>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="contacts-capability-empty">{t("contacts.noEmployeeRuns")}</div>
                  )}
                </div>
              </section>
);
}
