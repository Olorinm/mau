import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer as httpServer } from 'node:http';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { runFixtures } from '../test/fixtures/run-parts.mjs';
const reference = process.env.OPENGROVE_REFERENCE;
if (!reference) throw new Error('Set OPENGROVE_REFERENCE to the read-only extraction baseline checkout.');
const root = process.cwd(), original = path.resolve(reference), output = path.resolve(process.env.RUN_COMPARISON_OUTPUT || '.run-comparison');
await fs.mkdir(output, { recursive: true });
const source = await fs.readFile(path.join(original, 'web/src/components/rooms/room-message-stream.tsx'), 'utf8');
const isolated = source.slice(source.indexOf('function RoomTextBubble('), source.indexOf('function RoomMessageAttachments('));
// This harness isolates unexported presentation functions from the original file.
// Their bodies and JSX are read unchanged; no production controllers are invoked.
const originalRoom = `import {useLayoutEffect,useRef,useState} from 'react';
import {Check,Square} from 'lucide-react';
import {AgentStateIndicator,Tooltip} from '@olorinm/agent-ui/app';
import {useI18n} from '../../i18n';
import {TextShimmer} from '../ui/motion/text-shimmer';
import {TextTransition} from '../ui/motion/text-transition';
import {ThreadTextBlock} from '../chat/message-markdown';
import {Disclosure} from '../chat/disclosure';
import {AssistantProcessBlock,ApprovalInteractionCard,QuestionInteractionCard,renderActivitySummary,choiceFormFromItem,summarizeActivityItems} from '../chat/message-activity';
import {processGroupsToActivityEntries,processGroupsHaveRunningActivity,isNativeAgentCommentaryNote,isConnectorProcessNote} from '../chat/assistant-run-view-model';
${isolated}\nexport {RoomAgentMessageBody};`;
const shim = `import {EN} from ${JSON.stringify(path.join(original,'web/src/locales/en.ts'))};
import {ZH_CN} from ${JSON.stringify(path.join(original,'web/src/locales/zh-CN.ts'))};
export const translate=(key,values)=>{const d=window.fixtureLanguage==='en'?EN:ZH_CN;return (d[key]??EN[key]??key).replace(/\\{([^}]+)\\}/g,(m,k)=>String(values?.[k]??m));};
export const useI18n=()=>({t:translate,language:window.fixtureLanguage});export const rawDiagnosticText=v=>v;`;
const common = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{TooltipProvider}from'@olorinm/agent-ui/app';
import {runFixtures} from ${JSON.stringify(path.join(root,'test/fixtures/run-parts.mjs'))};
const params=new URLSearchParams(location.search);window.fixtureLanguage=params.get('language')||'zh-CN';const fixture=runFixtures[params.get('case')||'mixed'];
window.actions=[];const callbacks={onResolveApproval:(...args)=>window.actions.push(['approval',...args]),onResolveQuestion:(...args)=>window.actions.push(['question',...args]),onInsertPrompt:()=>{}};
const frame=body=><div className="rooms-view" style={{display:'block',height:'auto',padding:24,background:'var(--c-bg)'}}><div className="room-chat-stream" style={{width:'100%',padding:0}}><article className="room-chat-message from-agent"><div className="room-chat-content">{body}</div></article></div></div>;
`;
for (const target of ['reference','candidate']) {
 const ref = target==='reference';
 const entry=common+(ref?`import {RoomAgentMessageBody} from ${JSON.stringify(path.join(original,'web/src/components/rooms/room-message-stream.tsx'))};
import {splitAssistantPartsForSurface} from ${JSON.stringify(path.join(original,'web/src/components/chat/assistant-run-view-model.ts'))};
import ${JSON.stringify(path.join(original,'web/src/styles/tokens.css'))};import ${JSON.stringify(path.join(original,'web/src/styles/reset.css'))};import ${JSON.stringify(path.join(original,'web/src/styles/primitives.css'))};import ${JSON.stringify(path.join(original,'web/src/styles/base/document.css'))};
import ${JSON.stringify(path.join(original,'web/src/components/rooms/rooms.css'))};import ${JSON.stringify(path.join(original,'web/src/components/rooms/room-message-stream.css'))};
const body=<RoomAgentMessageBody {...fixture} {...splitAssistantPartsForSurface(fixture.parts,'fixture')} {...callbacks} fallbackText="" hasTextPart={fixture.parts.some(p=>p.type==='text')} />;
createRoot(document.getElementById('root')).render(<TooltipProvider>{frame(body)}</TooltipProvider>);`
 : `import {FrontendProvider,RunMessage} from ${JSON.stringify(path.join(root,'dist/conversation.js'))};import ${JSON.stringify(path.join(root,'dist/conversation.css'))};
createRoot(document.getElementById('root')).render(<FrontendProvider language={window.fixtureLanguage} theme={params.get('theme')||'light'}><TooltipProvider>{frame(<RunMessage id="fixture" {...fixture} {...callbacks} />)}</TooltipProvider></FrontendProvider>);`);
 await build({stdin:{contents:entry,loader:'tsx',resolveDir:root},outfile:path.join(output,target+'.js'),bundle:true,format:'esm',jsx:'automatic',loader:{'.css':'css'},plugins:[{
  name:'reference-presentation-only',setup(b){
   b.onResolve({filter:/^[^./]|^@/},async args=>{
    if(args.pluginData?.resolved || !args.importer.startsWith(original + "/web/"))return;
    return b.resolve(args.path,{kind:args.kind,resolveDir:root,pluginData:{resolved:true}});
   });
   b.onLoad({filter:/room-message-stream\.tsx$/},args=>args.path.startsWith(original)?{contents:originalRoom,loader:'tsx',resolveDir:path.dirname(args.path)}:undefined);
   b.onLoad({filter:/\/web\/src\/i18n\.ts$/},args=>args.path.startsWith(original)?{contents:shim,loader:'tsx',resolveDir:root}:undefined);
   b.onLoad({filter:/\/web\/src\/format\.ts$/},args=>args.path.startsWith(original)?{contents:`export {formatJson,summarize} from ${JSON.stringify(path.join(root,'src/process/format.ts'))};`,loader:'ts'}:undefined);
   b.onLoad({filter:/\/web\/src\/(api-base|bridge-client)\.ts$/},args=>args.path.startsWith(original)?{contents:'export const apiUrl=x=>x;export class BridgeDownloadError extends Error{};export const downloadBridgeFile=async()=>{};',loader:'ts'}:undefined);
  }
 }]});
 await fs.writeFile(path.join(output,target+'.html'),`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${target}.css"><style>body{margin:0}#root{width:100%;min-height:100vh}</style></head><body><div id="root"></div><script>document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')||'light';document.documentElement.dataset.resolvedTheme=document.documentElement.dataset.theme;</script><script type="module" src="${target}.js"></script></body></html>`);
}
const server=httpServer(async(req,res)=>{try{const file=path.join(output,new URL(req.url,'http://local').pathname);res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch();const results=[];
try {
 for(const width of [1200,390])for(const theme of ['light','dark'])for(const language of ['zh-CN','en']) {
  const pages=await Promise.all(['reference','candidate'].map(()=>browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'})));
  try {for(const name of Object.keys(runFixtures)) {
   for(let i=0;i<2;i++){const target=['reference','candidate'][i],page=pages[i];page.on('pageerror',e=>{throw e;});await page.goto(`http://127.0.0.1:${server.address().port}/${target}.html?case=${name}&theme=${theme}&language=${language}`);await page.locator('.room-chat-agent-stack').waitFor();}
   for(const expanded of [false,true]) {
    if(expanded)for(const page of pages){for(let n=0;n<20;n++){const toggle=page.locator('.og-disclosure-toggle[aria-expanded=false], .thread-activity-toggle[aria-expanded=false], .thread-activity-cluster-toggle[aria-expanded=false], .thread-activity-row-toggle[aria-expanded=false], .thread-activity-edit-diff-toggle[aria-expanded=false]').filter({visible:true}).first();if(!await toggle.count())break;const handle=await toggle.elementHandle();await handle.click();await page.waitForFunction(el=>el.getAttribute('aria-expanded')==='true',handle);await page.waitForFunction(()=>Array.from(document.querySelectorAll('.og-disclosure[data-open=true] > .og-disclosure-panel > .og-disclosure-panel-motion')).every(el=>getComputedStyle(el).opacity==='1'&&getComputedStyle(el).display!=='none'));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}}
    if(expanded&&name==='mixed')for(const page of pages){await expect(page.locator('.thread-activity-row')).toHaveCount(3);await expect(page.getByText('pwd',{exact:true})).toBeVisible();await expect(page.getByText('new',{exact:true})).toBeVisible();}
    const key=`${name}-${width}-${theme}-${language}-${expanded?'expanded':'collapsed'}`;
    if(['running','approval','question'].includes(name)) {for(const page of pages)await expect(page.locator('.room-chat-agent-stack')).toBeVisible();continue;}
    const shots=[];for(let i=0;i<2;i++){await pages[i].evaluate(()=>document.fonts.ready);shots.push(await pages[i].locator('.room-chat-agent-stack').screenshot({animations:'disabled',path:path.join(output,`${key}-${i}.png`)}));}
    const [a,b]=shots.map(shot=>PNG.sync.read(shot));let ratio=1,different=-1;
    if(a.width===b.width&&a.height===b.height){const diff=new PNG({width:a.width,height:a.height});different=pixelmatch(a.data,b.data,diff.data,a.width,a.height,{threshold:0.1});ratio=different/(a.width*a.height);if(different)await fs.writeFile(path.join(output,key+'-diff.png'),PNG.sync.write(diff));}
    results.push({key,reference:[a.width,a.height],candidate:[b.width,b.height],different,ratio});
   }
   if(name==='plain')for(const page of pages)await expect(page.locator('.og-disclosure--room-run')).toHaveCount(0);
   if(name==='approval'||name==='question'){for(const page of pages){if(name==='approval')await page.locator('.thread-approval-actions button').first().click();else await page.locator('.thread-question-option').filter({hasText:'workspace'}).click();await expect.poll(()=>page.evaluate(()=>window.actions.length)).toBe(1);}const actions=await Promise.all(pages.map(page=>page.evaluate(()=>window.actions)));expect(actions[1]).toEqual(actions[0]);}
  }}finally{for(const page of pages)await page.close();}
 }
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify(results,null,2));
 console.log(JSON.stringify({comparisons:results.length,passed:results.filter(r=>r.ratio===0).length,failures:results.filter(r=>r.ratio>0).slice(0,12),output}));
 if(results.some(r=>r.ratio>0))process.exitCode=1;
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
