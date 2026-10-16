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
