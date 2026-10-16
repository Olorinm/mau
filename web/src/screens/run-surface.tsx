import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AgentInteraction, AgentProcess, type HostInteractionAnswer } from "@olorinm/agent-ui/agent-host";
import { ChatMarkdown } from "@olorinm/agent-ui";
import { Button } from "@olorinm/agent-ui/app";
import { answerInteraction, describeInteraction, type InteractionAnswer, type NativeRequest } from "@olorinm/agent-host/interactions";
import { ApiError } from "../api/http";
import { runApi, RunReader, type CommunicationTask, type RunDetail } from "../api/runs";
import { errorMessage, useI18n } from "../i18n";

function Interaction({ call, claimId, api, active, onAnswered }: {
  call: RunDetail["calls"][number]; claimId: string; api: ReturnType<typeof runApi>; active: boolean; onAnswered(): Promise<unknown>;
}) {
  const { language } = useI18n(), zh = language === "zh-CN";
  const request = describeInteraction({ method: call.name, params: call.input } as NativeRequest);
  const pending = active && call.status === "pending" && Date.parse(call.deadlineAt) > Date.now();
  return <div className="mau-interaction" data-call-id={call.id}>
    <AgentInteraction requestId={call.id} request={request} disabled={!pending}
      {...(zh ? { labels: { expired: "请求已结束", details: "请求详情", schema: "表单结构", native: "原生请求", json: "JSON 回答", completed: "已完成此步骤", submit: "提交回答", decline: "拒绝", cancel: "取消请求", objectRequired: "请填写 JSON 对象" } } : {})}
      onReply={async (answer: HostInteractionAnswer) => {
        try { await api.answer(claimId, call.id, answerInteraction(request, answer as InteractionAnswer)); }
        finally { await onAnswered(); }
      }} />
    {!pending ? <p className="mau-muted">{call.status === "completed" ? zh ? "已处理" : "Answered" : zh ? "请求已结束或过期" : "Request closed or expired"}</p> : null}
  </div>;
}

function RunSurface({ task, claimId, token, agentId, fallback }: { task: CommunicationTask; claimId: string; token: string; agentId: string; fallback: string }) {
  const { t, language } = useI18n(), zh = language === "zh-CN";
  const queries = useQueryClient();
  const api = useMemo(() => runApi(token, agentId), [token, agentId]);
  const reader = useMemo(() => new RunReader(api, claimId), [api, claimId]);
  const key = ["run", token, agentId, claimId];
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => reader.refresh(signal),
    refetchInterval: (query) => !query.state.data || query.state.data.more || query.state.data.detail.run.status === "running" ? 1000 : false });
  const cancel = useMutation({ mutationFn: () => api.cancel(task.id),
    onSuccess: () => queries.invalidateQueries({ queryKey: ["run-tasks", token, agentId] }) });
  const data = query.data, active = data?.detail.run.status === "running";
  const calls = data?.detail.calls.filter((call) => call.kind === "interaction") ?? [];
  const pending = calls.some((call) => call.status === "pending" && Date.parse(call.deadlineAt) > Date.now());
  const status = data?.detail.run.status;
  const label = !data ? zh ? "正在读取执行过程…" : "Loading execution…"
    : active ? pending ? zh ? "等待你的回应" : "Waiting for your response" : task.cancelRequested ? zh ? "正在停止…" : "Stopping…" : zh ? "正在执行" : "Running"
    : status === "completed" ? zh ? "已完成" : "Completed" : status === "cancelled" ? zh ? "已取消" : "Cancelled" : zh ? "执行未完成" : "Execution failed";
  const failure = query.error ?? cancel.error;
  const answer = active ? data?.view.text : data?.detail.run.answer || data?.view.text;
  return <section className="mau-run" data-run-id={claimId}>
    <div className="mau-run-status"><span role="status">{label}</span>
      {active ? <Button disabled={cancel.isPending || task.cancelRequested} onClick={() => cancel.mutate()}>{zh ? "停止" : "Stop"}</Button> : null}</div>
    {query.error || cancel.error ? <p role="alert">{errorMessage(t, failure instanceof ApiError ? failure.code : "request_failed")} <Button onClick={() => void query.refetch()}>{zh ? "重试" : "Retry"}</Button></p> : null}
    {data ? <>
      <AgentProcess events={data.view.events} active={active}
        {...(zh ? { labels: { process: "执行过程", running: "执行中", completed: "完成", failed: "失败", interrupted: "已中断", input: "参数", output: "结果", empty: "等待执行事件" } } : {})} />
      {data.truncated ? <p className="mau-muted">{zh ? "部分较早的执行事件已不在保留范围内。" : "Some earlier execution events are no longer retained."}</p> : null}
      {calls.map((call) => <Interaction key={call.id} call={call} claimId={claimId} api={api} active={active} onAnswered={() => query.refetch()} />)}
    </> : null}
    <ChatMarkdown markdown={answer || fallback} />
  </section>;
}

export function TaskSurface({ task, token, agentId, fallback }: { task: CommunicationTask; token: string; agentId: string; fallback: string }) {
  const { language } = useI18n(), zh = language === "zh-CN";
  if (!task.runs.length) return <p role="status">{task.status === "canceled" ? zh ? "已取消" : "Cancelled" : zh ? "等待执行…" : "Queued…"}</p>;
  return <>{task.runs.map((run) => run.runId ? <RunSurface key={run.claimId} task={task} claimId={run.claimId} token={token} agentId={agentId} fallback={fallback} />
    : <p role="status" key={run.claimId}>{run.phase === "unknown" ? zh ? "执行结果待确认，不会自动重试。" : "Execution outcome is uncertain; it will not be retried automatically." : zh ? "正在启动…" : "Starting…"}</p>)}</>;
}
