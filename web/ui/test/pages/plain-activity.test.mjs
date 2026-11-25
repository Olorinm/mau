import assert from "node:assert/strict";
import { test } from "node:test";
import { rm } from "node:fs/promises";
import { projectHostMessage } from "../../dist/agent-host.js";

/** The activity model with the labels of one language, built from the sources. */
async function models() {
  const { build } = await import("esbuild");
  const files = [".plain-model-" + process.pid + ".mjs", ".plain-labels-" + process.pid + ".mjs"];
  await build({ entryPoints: ["src/pages/process/activity-model.ts"], outfile: files[0], bundle: true, platform: "node", format: "esm", packages: "external", loader: { ".css": "empty" } });
  await build({ entryPoints: ["src/pages/presentation/labels.ts"], outfile: files[1], bundle: true, platform: "node", format: "esm" });
  try {
    const { createActivityModel } = await import("../../" + files[0]);
    const { presentationLabels } = await import("../../" + files[1]);
    return Object.fromEntries(["zh-CN", "en"].map((language) => [language, createActivityModel((key, values = {}) =>
      (presentationLabels[language][key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? "")))]));
  } finally { for (const file of files) await rm(file, { force: true }); }
}

// Tool events as each kernel's Host reports them (shapes taken from recorded runs).
let seq = 0;
const claude = (name, input) => { const id = "toolu_" + ++seq; return [
  { type: "native.tool", runId: "run", phase: "started", callId: id, tool: name, native: { type: "tool_use", id, name, input, caller: { type: "direct" } } },
  { type: "native.tool", runId: "run", phase: "finished", callId: id, native: { tool_use_id: id, type: "tool_result", content: "ok", is_error: false } }]; };
const codex = (command, commandActions) => { const id = "exec-" + ++seq, item = (status) => ({ type: "commandExecution", id, command: `/bin/sh -lc ${JSON.stringify(command)}`,
  cwd: "/repo", status, commandActions, aggregatedOutput: status === "completed" ? "ok" : null, exitCode: status === "completed" ? 0 : null });
  return [{ type: "native.tool", runId: "run", phase: "started", callId: id, native: item("inProgress") }, { type: "native.tool", runId: "run", phase: "finished", callId: id, native: item("completed") }]; };
const acp = (kind, title, args, path) => { const id = "call_" + ++seq, update = (sessionUpdate, status) => ({ sessionUpdate, toolCallId: id, name: title, title, args, status, kind,
  ...(path ? { locations: [{ path }] } : {}), rawInput: args, id });
  return [{ type: "native.tool", runId: "run", phase: "started", callId: id, tool: title, native: update("tool_call", "in_progress") },
    { type: "native.tool", runId: "run", phase: "finished", callId: id, tool: title, native: update("tool_call_update", "completed") }]; };
const product = (tool, input, result) => { const id = "run:tool:" + ++seq; return [{ type: "tool.started", runId: "run", callId: id, tool, input },
  { type: "tool.finished", runId: "run", callId: id, tool, result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] } }]; };
const items = (model, events) => model.buildActivityItems(projectHostMessage(events.flat(), { active: false }).filter((part) => part.type === "tool"));
const titles = (model, events) => items(model, events).map((item) => model.activityItemTitle(item));

test("a Claude command is named by the sentence Claude wrote for it", async () => {
  const { "zh-CN": zh, en } = await models();
  const events = [claude("Bash", { command: "cd /repo && git status -sb && git log --oneline | head -30", description: "查看仓库状态、分支和改动范围" })];
  const [item] = items(zh, events);
  assert.equal(zh.activityItemKind(item), "command");
  assert.equal(zh.activityItemTitle(item), "查看仓库状态、分支和改动范围");
  assert.equal(en.activityItemTitle(items(en, events)[0]), "查看仓库状态、分支和改动范围");
  // Without a description the row names the programs the command ran, not the command.
  assert.deepEqual(titles(zh, [claude("Bash", { command: "cd /repo && git status -sb && git log --oneline | head -30" })]), ["已运行 git status、git log、head"]);
});

test("a command without a description is named by the programs it ran", async () => {
  const { "zh-CN": zh, en } = await models();
  const cases = [
    ["git rev-parse main feat/coupon && git diff main...feat/coupon && git show feat/coupon:billing.py && git diff --stat", "已运行 git rev-parse、git diff、git show", "Ran git rev-parse, git diff, git show"],
    // What is inside quotes is not a separator, and an option before the subcommand is not the subcommand.
    ["git -C /repo ls-tree -r --name-only feat/coupon && git grep -n -E 'order_total|优惠券|coupon' feat/coupon", "已运行 git ls-tree、git grep", "Ran git ls-tree, git grep"],
    ["PYTHONDONTWRITEBYTECODE=1 python3 - <<'PY'\nfrom billing import order_total\nprint(order_total([], None))\nPY", "已运行 python3 脚本", "Ran a python3 script"],
    ["python3 -B -m unittest discover -s /repo -v", "已运行 python3 -m unittest", "Ran python3 -m unittest"],
    ["ls -la /repo; npm test; cargo build; make; echo done", "已运行 ls、npm test、cargo build 等 5 个", "Ran ls, npm test, cargo build and 2 more"],
  ];
  for (const [command, chinese, english] of cases) {
    assert.deepEqual(titles(zh, [codex(command, [{ type: "unknown", command }])]), [chinese]);
    assert.deepEqual(titles(en, [codex(command, [{ type: "unknown", command }])]), [english]);
  }
});

test("Codex's own reading of a command decides what the row says", async () => {
  const { "zh-CN": zh } = await models();
  const read = items(zh, [codex("sed -n 1,40p billing.py", [{ type: "read", command: "sed -n 1,40p billing.py", name: "billing.py", path: "/repo/billing.py" }])])[0];
  assert.equal(zh.activityItemKind(read), "read");
  assert.equal(zh.activityItemTitle(read), "已读取 billing.py");
  const listed = items(zh, [codex("rg --files -g '*.py'", [{ type: "listFiles", command: "rg --files -g '*.py'", path: null }])])[0];
  assert.equal(zh.activityItemKind(listed), "search");
  const searched = items(zh, [codex("rg -n order_total src", [{ type: "search", command: "rg -n order_total src", query: "order_total", path: "src" }])])[0];
  assert.equal(zh.activityItemKind(searched), "search");
  assert.match(zh.activityItemTitle(searched), /order_total/);
  // A command Codex could not classify is a command, whatever it starts with.
  const unknown = items(zh, [codex("cat a.py && python3 -m unittest", [{ type: "unknown", command: "cat a.py && python3 -m unittest" }])])[0];
  assert.equal(zh.activityItemKind(unknown), "command");
});

test("an ACP call is read by the kind and the location its agent gave", async () => {
  const { "zh-CN": zh } = await models();
  const events = [
    acp("read", "File repos/demo/billing.py", { Path: "/home/user/workspace/repos/demo/billing.py" }, "/home/user/workspace/repos/demo/billing.py"),
    acp("execute", "python3 -B -m unittest discover -s /repo -v", { CommandLine: "python3 -B -m unittest discover -s /repo -v", WaitMsBeforeAsync: 1000 }),
    // OpenCode names every call but a command by its tool; the path is in the locations alone.
    acp("read", "read", { filePath: "src/app.ts" }, "/repo/src/app.ts"),
    acp("edit", "edit", { filePath: "src/app.ts" }, "/repo/src/app.ts"),
    acp("search", "grep", { pattern: "order_total" }),
  ];
  const shown = items(zh, events);
  assert.deepEqual(shown.map((item) => zh.activityItemKind(item)), ["read", "command", "read", "edit", "search"]);
  assert.equal(zh.activityItemTitle(shown[0]), "已读取 billing.py");
  assert.equal(zh.activityItemTitle(shown[1]), "已运行 python3 -m unittest");
  assert.equal(zh.activityItemTitle(shown[2]), "已读取 app.ts");
});

test("what a kernel does for itself is not a row, and one call is one row", async () => {
  const { "zh-CN": zh } = await models();
  const ask = { action: "message", to: "reviewer", intent: "ask", text: "请做合并前审查。" };
  const events = [
    claude("ToolSearch", { query: "select:mcp__agent_host__partners", max_results: 3 }),
    claude("Bash", { command: "git diff main...feat/coupon", description: "导出待审的完整改动" }),
    // Claude reports the product tool it calls through MCP, and the Host reports the same call as the product's own.
    claude("mcp__agent_host__partners", ask), product("partners", ask, { status: "sent", to: "reviewer" }),
  ];
  assert.deepEqual(titles(zh, events), ["导出待审的完整改动", "询问 reviewer"]);
  // A product tool the Host did not report stays visible under the name its kernel gave.
  assert.equal(items(zh, [claude("mcp__agent_host__memory", { action: "read" })]).length, 1);
});

test("an opened row is what was run and what it printed, or what was written", async () => {
  const { "zh-CN": zh } = await models();
  const opened = (events) => items(zh, events).map((item) => zh.activityItemOpened(item));
  assert.deepEqual(opened([codex("git status", [{ type: "unknown", command: "git status" }])]), ["/repo $ git status\n\nok"]);
  assert.deepEqual(opened([claude("Bash", { command: "npm test", description: "跑测试" })]), ["$ npm test\n\nok"]);
  const ask = { action: "message", to: "reviewer", intent: "ask", text: "请做合并前审查。" };
  assert.deepEqual(opened([product("partners", ask, { status: "sent", to: "reviewer" })]), ["请做合并前审查。"]);
  // A call that ran nothing and told nobody anything opens as the caller's record of it, which is not this.
  assert.deepEqual(opened([claude("Read", { file_path: "/repo/a.py" })]), [""]);
});

test("the summary of a run counts what was done, each kind once", async () => {
  const { "zh-CN": zh, en } = await models();
  const ask = { action: "message", to: "reviewer", intent: "ask", text: "请做合并前审查。" };
  const events = [
    acp("read", "read", { filePath: "a.py" }, "/repo/a.py"), acp("read", "read", { filePath: "b.py" }, "/repo/b.py"),
    claude("Bash", { command: "npm test", description: "跑测试" }), claude("Bash", { command: "git commit -m x", description: "提交" }),
    product("partners", ask, { status: "sent", to: "reviewer" }),
  ];
  assert.equal(zh.summarizeActivityItems(items(zh, events), { includeReasoning: false }), "已探索 2 个文件 · 已运行 2 条命令 · 询问 reviewer");
  assert.equal(en.summarizeActivityItems(items(en, events), { includeReasoning: false }), "Explored 2 files · Ran 2 commands · Asked reviewer");
});

test("a command's result stays with the step it began when the partner spoke in between", async () => {
  const { build } = await import("esbuild");
  const file = ".plain-run-" + process.pid + ".mjs";
  await build({ entryPoints: ["src/pages/process/run-model.ts"], outfile: file, bundle: true, platform: "node", format: "esm", packages: "external", loader: { ".css": "empty" } });
  try {
    const { "zh-CN": zh } = await models();
    const { createRunModel } = await import("../../" + file);
    const run = createRunModel((key) => key, zh);
    const [started, finished] = codex("git status", [{ type: "unknown", command: "git status" }]);
    const parts = projectHostMessage([started, { type: "assistant.delta", runId: "run", text: "先看一下。" }, finished], { active: true });
    const { processGroups } = run.splitAssistantPartsForSurface(parts, "message");
    // One step, whole in the group its call opened: nothing of it is left after what was said.
    assert.deepEqual(processGroups.map((group) => group.type === "activity" ? group.parts.map((part) => part.phase) : group.type), [["call", "result"], "note"]);
    const [entry] = run.processGroupsToActivityEntries(processGroups);
    assert.equal(zh.activityItemOpened(entry.item), "/repo $ git status\n\nok");
  } finally { await rm(file, { force: true }); }
});

test("partner bridge records match one Host invocation and preserve independent failures", async () => {
  const { "zh-CN": zh } = await models();
  const ask = { action: "message", to: "reviewer", intent: "ask", text: "Review this change." };
  const failed = (to) => {
    const [call, result] = claude("mcp__agent_host__partners", { ...ask, to });
    result.native.is_error = true;
    return [call, result];
  };
  const bridge = claude("mcp__agent_host__partners", ask);
  const host = product("partners", { text: ask.text, intent: "ask", to: "reviewer", action: "message" }, { status: "sent" });
  assert.deepEqual(titles(zh, [failed("advisor"), failed("reviewer"), bridge, host]),
    ["没能询问 advisor", "没能询问 reviewer", "询问 reviewer"]);
  assert.deepEqual(titles(zh, [bridge, claude("mcp__agent_host__partners", ask), host]), ["询问 reviewer", "询问 reviewer"]);
  const id = host[0].callId;
  const native = phase => ({ type: "native.tool", runId: "run", phase, callId: id, tool: "partners",
    native: { type: "dynamicToolCall", id, tool: "partners", arguments: ask, ...(phase === "finished" ? host[1].result : {}) } });
  assert.deepEqual(titles(zh, [native("started"), host, native("finished")]), ["询问 reviewer"]);
});

test("Codex command details retain streamed output when the final item omits it", async () => {
  const { "zh-CN": zh } = await models();
  const [start, end] = codex("pwd", [{ type: "unknown", command: "pwd" }]);
  const delta = text => ({ type: "native.notification", runId: "run",
    notification: { method: "item/commandExecution/outputDelta", params: { itemId: start.callId, delta: text } } });
  for (const value of [null, "", undefined, "final output"]) {
    end.native.aggregatedOutput = value;
    const [item] = items(zh, [start, delta("/re"), delta("po"), end]);
    assert.equal(zh.activityItemOpened(item), "/repo $ pwd\n\n" + (value || "/repo"));
  }
});
