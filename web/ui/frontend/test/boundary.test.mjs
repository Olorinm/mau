import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import ts from 'typescript';
async function files(dir) {return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(item=>item.isDirectory()?files(`${dir}/${item.name}`):`${dir}/${item.name}`))).flat();}
test('public package has no product protocol, transport, storage or backend dependencies',async()=>{
 const manifest=JSON.parse(await readFile('package.json','utf8'));
 assert.ok(!Object.keys(manifest.dependencies).some(name=>/opengrove|agent-host|agent-router|agent-environment|matrix|zod|react-query|react-router/.test(name)));
 const forbidden=new Set(['fetch','XMLHttpRequest','WebSocket','EventSource','localStorage','sessionStorage','indexedDB']);
 for(const path of (await files('src')).filter(path=>/\.[jt]sx?$/.test(path))){
  const source=await readFile(path,'utf8');
  const tree=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
  function visit(node){
   if(ts.isIdentifier(node)) assert.ok(!forbidden.has(node.text),`${path}: ${node.text}`);
   if(ts.isStringLiteral(node)) assert.ok(!/^(?:@opengrove\/|#protocol|@olorinm\/agent-(?:host|router|environment))|\/(?:auth\/session|ask\/stream|_mau|_agent-router)|x-opengrove-token|opengrove-desktop:/.test(node.text),`${path}: ${node.text}`);
   ts.forEachChild(node,visit);
  }visit(tree);
 }
 const entry=await readFile('dist/index.d.ts','utf8');
 assert.doesNotMatch(entry,/mountFrontend|FrontendOptions|apiBase|passwordLogin|import .*style\.css/);
});
test('independent components can render with two different products and no browser globals',async()=>{
 const {build}=await import('esbuild');
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');
 const dir=await mkdtemp(tmpdir()+'/frontend-ssr-');
 try {
  await build({entryPoints:['src/index.ts'],outfile:dir+'/ui.mjs',bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'}});
  // Resolve external dependencies from this repository while keeping the output temporary.
  const local='.ssr-test-'+process.pid+'.mjs';
  await build({entryPoints:['src/index.ts'],outfile:local,bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'}});
  try {
   const React=await import('react');const {renderToString}=await import('react-dom/server');const ui=await import('../'+local);
   const html=renderToString(React.createElement('div',null,...['Notebook','Studio'].map(brand=>React.createElement(ui.AppShell,{brand,key:brand},React.createElement(ui.Catalog,{items:[]})))));
   assert.match(html,/Notebook/);assert.match(html,/Studio/);assert.doesNotMatch(html,/OpenGrove|Mau|wallet|withdraw/i);
  }finally{await rm(local,{force:true});}
 }finally{await rm(dir,{recursive:true,force:true});}
});
