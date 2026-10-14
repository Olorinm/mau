import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { checkBrowser } from '../test/browser-acceptance.mjs';
import { consumerEntry, consumerHtml } from '../test/consumer-entry.mjs';
const root=await mkdtemp(resolve('.browser-test-'));let server;
try {
 await writeFile(resolve(root,'index.html'),consumerHtml);await writeFile(resolve(root,'main.jsx'),consumerEntry);
 server=await createServer({configFile:false,root,server:{host:'127.0.0.1',port:0},resolve:{alias:{'@olorinm/agent-frontend/style.css':resolve('dist/style.css'),'@olorinm/agent-frontend':resolve('dist/index.js')}}});
 await server.listen();await checkBrowser(server.resolvedUrls.local[0]);
} finally {await server?.close();await rm(root,{recursive:true,force:true});}
