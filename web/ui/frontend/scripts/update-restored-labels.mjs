import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
const reference=process.env.OPENGROVE_REFERENCE;
if(!reference) throw new Error('Set OPENGROVE_REFERENCE to the extraction baseline.');
async function files(dir){return(await Promise.all((await fs.readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?files(path.join(dir,e.name)):path.join(dir,e.name)))).flat();}
const texts=await Promise.all((await files('src')).filter(p=>/\.tsx?$/.test(p)&&!p.includes('labels')).map(p=>fs.readFile(p,'utf8')));
const keys=new Set(texts.flatMap(text=>[...text.matchAll(/(?:translate|t)\("([^"]+)"/g)].map(m=>m[1])));
const dictionaries={};for(const [lang,variable] of [['en','EN'],['zh-CN','ZH_CN']]){
 const code=await fs.readFile(path.join(reference,'web/src/locales',lang+'.ts'),'utf8');
 const module={};new Function('exports',ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(module);
 const dictionary=module[variable];dictionaries[lang]=Object.fromEntries(Object.keys(dictionary).sort().filter(key=>keys.has(key)||/^(activity|knowledge|flowPreview|filePreview|editor)\./.test(key)).map(key=>[key,dictionary[key]]));
}
await fs.writeFile('src/presentation/restored-labels.ts','// Text from the original retained presentation; FrontendProvider owns the locale.\nexport const restoredLabels: Record<string, Record<string,string>> = '+JSON.stringify(dictionaries,null,2)+';\n');
