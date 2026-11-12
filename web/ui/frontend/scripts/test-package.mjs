import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {consumerEntry,consumerHtml} from '../test/consumer-entry.mjs';
import {checkBrowser} from '../test/browser-acceptance.mjs';
import {createDialogHtml,createDialogEntry,checkCreateDialog} from '../test/create-dialog-acceptance.mjs';
const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const exec=promisify(execFile), npm=process.platform==='win32'?'npm.cmd':'npm';
const task=await mkdtemp(join(tmpdir(),'agent-frontend-package-')),consumer=join(task,'consumer');let server;
async function run(args,cwd){try{return await exec(npm,args,{cwd,maxBuffer:8*1024*1024,shell:process.platform==='win32'})}catch(e){console.error(e.stdout,e.stderr);throw e}}
try {
 const packed=await run(['pack','--ignore-scripts','--json','--pack-destination',task],process.cwd());
 const [archive]=JSON.parse(packed.stdout);const files=new Set(archive.files.map(f=>f.path));
 for (const entry of ['shell','conversation','settings','files','catalog','extensions','auth','profile']) {
  for (const path of [`dist/${entry}.js`,`dist/${entry}.css`,`dist/entries/${entry}.d.ts`]) assert.ok(files.has(path),path);
 }
 for(const name of ['dist/index.js','dist/index.d.ts','dist/style.css','README.md','NOTICE','LICENSE'])assert.ok(files.has(name),name);
 assert.ok(![...files].some(name=>/contracts|host\.d\.ts|bridge|^src\//.test(name)));
 await mkdir(consumer);await writeFile(join(consumer,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'@olorinm/agent-frontend':pathToFileURL(join(task,archive.filename)).href,'@olorinm/agent-ui':process.env.AGENT_UI_ARCHIVE ?? manifest.devDependencies['@olorinm/agent-ui'],react:'19.3.0','react-dom':'19.3.0',vite:'^8.3.3',typescript:'npm:@typescript/typescript6@6.0.2','@types/react':'19.3.0'}}));
 await writeFile(join(consumer,'index.html'),consumerHtml);await writeFile(join(consumer,'main.jsx'),consumerEntry);
 await writeFile(join(consumer,'create-dialog.html'),createDialogHtml);await writeFile(join(consumer,'create-dialog.jsx'),createDialogEntry);
 await writeFile(join(consumer,'usage.ts'),`import {type ComponentProps} from 'react';import {AppShell,Conversation,FileEditor,Navigation} from '@olorinm/agent-frontend';
const shell:ComponentProps<typeof AppShell>={brand:'A separate product',children:null};
const nav:ComponentProps<typeof Navigation>={items:[],onSelect:()=>{}};
const conversation:ComponentProps<typeof Conversation>={messages:[],composer:{value:'',onChange:()=>{},onSend:()=>{}}};
const editor:ComponentProps<typeof FileEditor>={value:'',format:'text',onChange:()=>{}};
void [shell,nav,conversation,editor];`);
 await run(['install','--ignore-scripts','--no-audit','--no-fund'],consumer);
 const ts=JSON.parse(await readFile(join(consumer,'node_modules/typescript/package.json'),'utf8'));
 await exec(process.execPath,[join(consumer,'node_modules/typescript',ts.bin.tsc??ts.bin.tsc6),'--noEmit','--module','esnext','--moduleResolution','bundler','--target','es2022','--jsx','react-jsx','usage.ts'],{cwd:consumer});
 const vite=await import(pathToFileURL(join(consumer,'node_modules/vite/dist/node/index.js')).href);
 await vite.build({configFile:false,root:consumer,logLevel:'error',build:{target:'esnext',rollupOptions:{input:{main:join(consumer,'index.html'),create:join(consumer,'create-dialog.html')}}}});
 server=await vite.preview({configFile:false,root:consumer,preview:{host:'127.0.0.1',port:0}});
 await checkBrowser(server.resolvedUrls.local[0]);
 await checkCreateDialog(server.resolvedUrls.local[0]);
 console.log('Independent archive installed, typed, built and browser-tested with no service adapter or repository aliases.');
}finally{if(server)await new Promise(resolve=>server.httpServer.close(resolve));await rm(task,{recursive:true,force:true});}
