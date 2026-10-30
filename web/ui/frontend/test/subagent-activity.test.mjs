import assert from "node:assert/strict";
import { test } from "node:test";
import { rm } from "node:fs/promises";

test("Codex native subagent items render as agent activity counted once per subagent", async () => {
  const { build } = await import("esbuild");
  const local = ".subagent-test-" + process.pid + ".mjs";
  await build({ entryPoints: ["src/process/activity-model.ts"], outfile: local, bundle: true, platform: "node", format: "esm",
    packages: "external", loader: { ".css": "empty" } });
  try {
    const { createActivityModel } = await import("../" + local);
    const labelFile = ".subagent-labels-" + process.pid + ".mjs";
    await build({ entryPoints: ["src/presentation/restored-labels.ts"], outfile: labelFile, bundle: true, platform: "node", format: "esm" });
    try {
      const { restoredLabels } = await import("../" + labelFile);
      const zh = restoredLabels["zh-CN"];
      const translate = (key, values = {}) => (zh[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
      const model = createActivityModel(translate);
      const tool = (id, item, status) => ({ type: "tool", call: { id: id + ":call", type: "tool", phase: "call", toolId: item.type, callId: id,
        title: item.type, input: item, status, error: "", approvalId: "", approvalStatus: "", approvalReason: "", questionId: "", questionStatus: "", questionPrompt: "" } });
      const started = tool("s", { type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "/root/trip_plan" }, "complete");
      const completed = tool("c", { type: "subAgentActivity", kind: "completed", agentThreadId: "child", agentPath: "/root/trip_plan" }, "complete");
      const waiting = tool("w", { type: "collabAgentToolCall", tool: "wait" }, "running");
      assert.equal(model.activityItemKind(started), "agent");
      assert.equal(model.activityItemTitle(started, "complete"), "开始子 Agent trip_plan");
      assert.equal(model.activityItemTitle(completed, "complete"), "子 Agent trip_plan 完成");
      assert.equal(model.activityItemTitle(waiting, "running"), "正在等待 子 Agent");
      const summary = model.summarizeActivityItems([started, waiting, completed], {});
      assert.match(JSON.stringify(summary), /已委派 Agent/);
    } finally { await rm(labelFile, { force: true }); }
  } finally { await rm(local, { force: true }); }
});
