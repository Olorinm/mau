import assert from "node:assert/strict";
import {test} from "node:test";
import {projectHostMessage, projectHostInteraction} from "../dist/agent-host.js";
const native = (id, phase, item) => ({type: "native.tool", runId: "run", callId: id, phase, native: item});
test("preserves native IDs, concurrent same-name calls, output and failure instead of merging by tool name", () => {
 const parts = projectHostMessage([
  {type: "tool.started", runId: "run", callId: "a", tool: "search", input: {query: "a"}},
  {type: "tool.started", runId: "run", callId: "b", tool: "search", input: {query: "b"}},
  {type: "tool.finished", runId: "run", callId: "b", tool: "search", result: {success: false, error: "denied"}},
  {type: "tool.finished", runId: "run", callId: "a", tool: "search", result: {success: true, output: "found"}},
 ]);
 assert.deepEqual(parts.filter(p=>p.phase === "call").map(p=>[p.callId,p.status]), [["a","complete"],["b","error"]]);
 assert.equal(parts.find(p=>p.id === "b:result").input.query, "b");
 assert.equal(JSON.parse(parts.find(p=>p.id === "a:result").detail.text).output.output, "found");
});
test("publishes live command output, preserves finished native payload and commentary order", () => {
 const events = [native("cmd", "started", {id: "cmd", type: "commandExecution", command: "pwd", cwd: "/work"}),
 {type: "native.notification", runId: "run", notification: {method: "item/commandExecution/outputDelta", params: {itemId: "cmd", delta: "/work\n"}}},
 {type: "native.notification", runId: "run", notification: {method: "item/started", params: {item: {id: "note", type: "agentMessage", phase: "commentary"}}}},
 {type: "native.notification", runId: "run", notification: {method: "item/agentMessage/delta", params: {itemId: "note", delta: "Checking"}}}];
 const live = projectHostMessage(events, {active: true});
 assert.equal(JSON.parse(live[0].detail.text).output, "/work\n"); assert.equal(live[1].text, "Checking");
 const complete = projectHostMessage([...events, native("cmd", "finished", {type: "commandExecution", command: "pwd", aggregatedOutput: "/work\n", exitCode: 0})], {answer: "Done"});
 assert.equal(complete[0].status, "complete"); assert.equal(complete.at(-1).text, "Done");
 assert.equal(complete.find(p=>p.phase === "result").result.aggregatedOutput, "/work\n");
});
test("anonymous native calls remain unpaired and partial tool results survive interrupted execution", () => {
 const parts = projectHostMessage([native(undefined, "started", {name: "read"}),native(undefined,"finished",{name:"read",content:"unattributed"}),
 native("pi", "started", {toolName:"read", args:{path:"a"}}),native("pi", "updated",{toolName:"read",partialResult:{output:"partial"}})]);
 assert.notEqual(parts[0].callId, parts[1].callId); assert.equal(parts[0].status, "interrupted");
 const pi = parts.find(p=>p.callId === "pi"); assert.equal(pi.input.path,"a"); assert.equal(JSON.parse(pi.detail.text).output.output,"partial");
});
test("retains approval choice identity/scope and question ids, multiselect and secret fields", () => {
 const request = {kind:"approval", title:"Allow", native:{command:"pwd"}, choices:[{id:"session:opaque",label:"Allow session",scope:"session",allows:true},{id:"no",label:"No",allows:false}]};
 const part = projectHostInteraction("native-call",request,{disabledReason:"Expired"});
 assert.equal(part.approvalId,"native-call"); assert.equal(part.interaction.choices[0].id,"session:opaque"); assert.equal(part.interaction.disabledReason,"Expired");
 const q = projectHostInteraction("q",{kind:"questions",title:"Choose",native:{},questions:[{id:"opaque",title:"Value",secret:true,multiple:true,options:[{label:"x"}]}]});
 assert.equal(q.interaction.questions[0].id,"opaque"); assert.equal(q.interaction.questions[0].secret,true); assert.equal(q.interaction.questions[0].multiSelect,true); assert.equal(q.interaction.allowSkip,false);
 assert.equal(projectHostInteraction("url",{kind:"url",title:"Login",native:{}}),undefined);
});
const note = (method, params, threadId = "root") => ({type: "native.notification", runId: "run", threadId, notification: {method, params: {threadId, ...params}}});
test("Codex runs keep commentary and subagent activity in the process and one final answer", () => {
 const sub = {id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "/root/trip_plan"};
 const done = {id: "done", type: "subAgentActivity", kind: "completed", agentThreadId: "child", agentPath: "/root/trip_plan"};
 const events = [
  note("item/started", {item: {id: "c1", type: "agentMessage", phase: "commentary"}}),
  note("item/agentMessage/delta", {itemId: "c1", delta: "I'll ask a subagent."}),
  {type: "assistant.delta", runId: "run", text: "I'll ask a subagent."},
  note("item/started", {item: sub}), note("item/completed", {item: sub}),
  note("item/started", {item: {id: "w", type: "collabAgentToolCall", tool: "wait", status: "inProgress"}}),
  note("item/completed", {item: {id: "x", type: "agentMessage", phase: "final_answer", text: "child answer"}}, "child"),
  note("item/started", {item: done}), note("item/completed", {item: done}),
  note("item/completed", {item: {id: "w", type: "collabAgentToolCall", tool: "wait", status: "completed"}}),
  note("item/started", {item: {id: "f", type: "agentMessage", phase: "final_answer"}}),
  note("item/agentMessage/delta", {itemId: "f", delta: "Plan ready."}),
  {type: "assistant.delta", runId: "run", text: "Plan ready."},
  note("item/completed", {item: {id: "f", type: "agentMessage", phase: "final_answer", text: "Plan ready."}}),
 ];
 const parts = projectHostMessage(events, {answer: "Plan ready."});
 assert.deepEqual(parts.map(p => p.id), ["commentary:c1", "spawn:call", "spawn:result", "w:call", "done:call", "done:result", "w:result", "answer:f"]);
 assert.equal(parts.filter(p => p.type === "text").length, 1);
 assert.equal(parts.at(-1).text, "Plan ready.");
 assert.ok(!parts.some(p => "text" in p && p.text === "child answer"));
 assert.equal(parts.find(p => p.id === "w:call").status, "complete");
 assert.equal(parts.find(p => p.id === "spawn:call").input.agentPath, "/root/trip_plan");
});
test("text streamed before a tool call becomes commentary for kernels without native items", () => {
 const parts = projectHostMessage([
  {type: "assistant.delta", runId: "run", text: "Let me check."},
  {type: "tool.started", runId: "run", callId: "a", tool: "search", input: {query: "a"}},
  {type: "tool.finished", runId: "run", callId: "a", tool: "search", result: {success: true}},
  {type: "assistant.delta", runId: "run", text: "Found it."},
 ]);
 assert.equal(parts[0].type, "note"); assert.equal(parts[0].text, "Let me check."); assert.equal(parts[0].data.phase, "commentary");
 assert.equal(parts.at(-1).type, "text"); assert.equal(parts.at(-1).text, "Found it.");
});
