import assert from "node:assert/strict";
import { test } from "node:test";
import { rm } from "node:fs/promises";
import { projectHostMessage } from "../../dist/agent-host.js";

/** The activity model with the labels of one language, built from the sources. */
async function models() {
  const { build } = await import("esbuild");
  const files = [".partner-model-" + process.pid + ".mjs", ".partner-labels-" + process.pid + ".mjs"];
  await build({ entryPoints: ["src/pages/process/activity-model.ts"], outfile: files[0], bundle: true, platform: "node", format: "esm", packages: "external", loader: { ".css": "empty" } });
  await build({ entryPoints: ["src/pages/presentation/labels.ts"], outfile: files[1], bundle: true, platform: "node", format: "esm" });
  try {
    const { createActivityModel } = await import("../../" + files[0]);
    const { presentationLabels } = await import("../../" + files[1]);
    return Object.fromEntries(["zh-CN", "en"].map((language) => [language, createActivityModel((key, values = {}) =>
      (presentationLabels[language][key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? "")))]));
  } finally { for (const file of files) await rm(file, { force: true }); }
}
const answer = (value) => ({ success: !value.isError, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] });
/** One call of the partners tool as a Host reports it, and the activity item the run's process shows for it. */
function call(model, input, result, options = {}) {
  const events = [{ type: "tool.started", runId: "run", callId: "c", tool: options.tool ?? "partners", input },
    ...(result ? [{ type: "tool.finished", runId: "run", callId: "c", tool: options.tool ?? "partners", result: answer(result) }] : [])];
  const parts = projectHostMessage(events, { active: !result, ...(options.describeError ? { describeError: options.describeError } : {}) });
  const [item] = model.buildActivityItems(parts.filter((part) => part.type === "tool"));
  return { item, parts };
}

test("each action of the partners tool is one readable line that names its partner", async () => {
  const { "zh-CN": zh, en } = await models();
  const recruited = { status: "recruited", partner: { name: "korea-trip" } }, sent = { status: "sent", to: "korea-trip" };
  const cases = [
    [{ action: "recruit", name: "korea-trip", duty: "Plans the trip" }, recruited, "招募了 korea-trip", "Recruited korea-trip", "korea-trip"],
    [{ action: "recruit", name: "korea-trip", duty: "Plans the trip" }, { status: "restored", partner: { name: "korea-trip" } }, "恢复了 korea-trip", "Brought back korea-trip", "korea-trip"],
    [{ action: "recruit", name: "korea-trip", duty: "Plans the trip" }, undefined, "正在招募 korea-trip", "Recruiting korea-trip", "korea-trip"],
    [{ action: "message", to: "korea-trip", text: "Book it", intent: "relay" }, sent, "转给 korea-trip", "Passed it to korea-trip", "korea-trip"],
    [{ action: "message", to: "korea-trip", text: "How long?", intent: "ask" }, sent, "询问 korea-trip", "Asked korea-trip", "korea-trip"],
    [{ action: "message", to: "korea-trip", text: "FYI", intent: "inform" }, { status: "recorded" }, "告知 korea-trip", "Informed korea-trip", "korea-trip"],
    [{ action: "message", to: "korea-trip", text: "How long?", intent: "ask" }, undefined, "正在询问 korea-trip", "Asking korea-trip", "korea-trip"],
    [{ action: "dismiss", name: "visa" }, { status: "dismissed", name: "visa" }, "解散了 visa", "Dismissed visa", "visa"],
    [{ action: "wait" }, undefined, "正在等待回复", "Waiting for replies", ""],
    [{ action: "wait" }, { results: [], pending: [{ to: "visa" }] }, "还没有等到回复", "No reply yet", ""],
    [{ action: "wait" }, { results: [{ to: "korea-trip", status: "completed" }], pending: [] }, "收到 korea-trip 的回复", "Got the reply of korea-trip", "korea-trip"],
    [{ action: "wait" }, { results: [{ to: "korea-trip" }, { to: "visa" }], pending: [] }, "收到 2 条回复", "Got 2 replies", ""],
    [{ action: "roster" }, { partners: [] }, "查看了伙伴名单", "Looked at the partners", ""],
    [{ action: "message", to: "flights", text: "x", intent: "ask" }, { isError: true, error: "partner_not_found" }, "没能询问 flights", "Could not ask flights", "flights"],
    [{ action: "recruit", name: "Bad Name", duty: "x" }, { isError: true, error: "partner_name_invalid" }, "没能招募 Bad Name", "Could not recruit Bad Name", "Bad Name"],
  ];
  for (const [input, result, chinese, english, name] of cases) {
    const shown = call(zh, input, result).item;
    assert.equal(zh.activityItemKind(shown), "partner");
    assert.equal(zh.activityItemTitle(shown), chinese);
    assert.equal(en.activityItemTitle(call(en, input, result).item), english);
    // The title is given in parts, so that the partner's name can be a link between them.
    const title = zh.partnerActivityTitle(shown);
    assert.equal(title.name, name);
    assert.equal(title.before + title.name + title.after, chinese);
  }
  // A tool of another name is not a partner action, whatever its arguments.
  const other = call(zh, { action: "recruit", name: "korea-trip" }, { status: "recruited" }, { tool: "work_sessions" }).item;
  assert.equal(zh.activityItemKind(other), "tool");
  assert.equal(zh.partnerActivityTitle(other), null);
  // What the partner was told is the row's second line; a recruit without a message shows the duty.
  assert.equal(zh.activityItemDetail(call(zh, { action: "message", to: "korea-trip", text: "Book the hotel.\n\nTwo guests.", intent: "relay" }, sent).item), "Book the hotel. Two guests.");
  assert.equal(zh.activityItemDetail(call(zh, { action: "recruit", name: "korea-trip", duty: "Plans the trip" }, recruited).item), "Plans the trip");
  assert.equal(zh.activityItemDetail(call(zh, { action: "roster" }, { partners: [] }).item), "");
});

test("a run's summary says what was done with partners, and a refused call says why in the caller's words", async () => {
  const { "zh-CN": zh, en } = await models();
  const done = (model) => [
    call(model, { action: "roster" }, { partners: [] }).item,
    call(model, { action: "recruit", name: "korea-trip", duty: "x" }, { status: "recruited" }).item,
    call(model, { action: "message", to: "visa", text: "x", intent: "ask" }, { status: "sent" }).item,
    call(model, { action: "wait" }, { results: [] }).item,
  ];
  assert.equal(zh.summarizeActivityItems(done(zh), {}), "招募了 korea-trip · 询问 visa");
  assert.equal(en.summarizeActivityItems(done(en), {}), "Recruited korea-trip · Asked visa");
  const many = ["a", "b", "c", "d", "e"].map((name) => call(zh, { action: "message", to: name, text: "x", intent: "inform" }, { status: "recorded" }).item);
  assert.equal(zh.summarizeActivityItems(many, {}), "告知 a · 告知 b · 告知 c · 另有 2 项");
  assert.equal(zh.primaryActivityKind(done(zh)), "partner");
  // While the call runs, the summary is the action itself.
  assert.equal(zh.summarizeActivityItems([call(zh, { action: "recruit", name: "korea-trip", duty: "x" }).item], { active: true }), "正在招募 korea-trip");

  // The tool's refusal is a code in its answer. The caller gives the sentence; without one the row has no error text.
  const refusal = { isError: true, error: "partner_chain_limit", instruction: "Tell the owner where things stand." };
  const input = { action: "message", to: "korea-trip", text: "x", intent: "relay" };
  const worded = call(zh, input, refusal, { describeError: (code, tool) => `${tool}: ${code} in words` });
  assert.equal(zh.activityItemStatus(worded.item), "error");
  assert.equal(zh.activityItemError(worded.item), "partners: partner_chain_limit in words");
  assert.equal(zh.activityItemTitle(worded.item), "没能转给 korea-trip");
  assert.equal(zh.activityItemError(call(zh, input, refusal).item), "");
  // A refused action is counted with the errors, not said as done.
  assert.equal(zh.summarizeActivityItems([worded.item], {}), "1 个错误");
  // The full arguments and the tool's whole answer stay in the row's detail.
  assert.match(worded.parts.find((part) => part.phase === "result").detail.text, /Tell the owner where things stand/);
});
