import {readFile,writeFile} from 'node:fs/promises';
// CSS is an explicit consumer import, not a TypeScript module dependency.
const path=new URL('../dist/index.d.ts',import.meta.url);
await writeFile(path,(await readFile(path,'utf8')).replace(/^import ['"]\.\/style\.css['"];\r?\n/m,''));
