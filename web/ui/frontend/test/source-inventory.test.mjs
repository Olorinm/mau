import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
const root=new URL('../../',import.meta.url);
test('baseline component inventory has no missing destinations or duplicate source records',async()=>{
 const inventory=JSON.parse(await readFile(new URL('../docs/opengrove-source-inventory.json',import.meta.url),'utf8'));
 assert.equal(inventory.files.length,115);
 assert.equal(new Set(inventory.files.map(file=>file.source)).size,115);
 for(const file of inventory.files){
  assert.ok(['extracted','extracted/adapted','adapted','controller','excluded'].includes(file.classification),file.source);
  assert.ok(file.destinationOrReason,file.source);
  for(const destination of file.destinationOrReason.split(', '))
   if(/^(frontend|src)\//.test(destination)) await access(new URL(destination,root));
 }
});
