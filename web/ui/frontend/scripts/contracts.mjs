import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
const result = await build({ stdin: {
  contents: 'export { hostProtocol } from "./contracts/protocol/compiled.ts"; export { hostProtocolToOpenApi } from "./contracts/protocol/openapi.ts";',
  resolveDir: process.cwd(), loader: 'ts',
}, bundle: true, platform: 'node', format: 'esm', write: false });
const { hostProtocol, hostProtocolToOpenApi } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
await writeFile('dist/contracts.openapi.json', JSON.stringify(hostProtocolToOpenApi(hostProtocol), null, 2) + '\n');
