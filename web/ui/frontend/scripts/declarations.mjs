import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

for (const name of ['host', 'index']) {
  const source = await readFile(`src/${name}.ts`, 'utf8');
  const result = ts.transpileDeclaration(source, {
    fileName: `${name}.ts`, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(result.diagnostics, {
      getCanonicalFileName: f => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
    }));
  }
  await writeFile(`dist/${name}.d.ts`, result.outputText.replace(/from ["']\.\/host["']/g, 'from "./host.js"'));
}
