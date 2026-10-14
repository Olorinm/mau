import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { consumerEntry, consumerHtml } from '../test/consumer-entry.mjs';
import { checkBrowser } from '../test/browser-acceptance.mjs';

const exec = promisify(execFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const task = await mkdtemp(join(tmpdir(), 'agent-frontend-package-'));
const consumer = join(task, 'consumer');
let server;
async function run(args, cwd) {
  try { return await exec(npm, args, { cwd, maxBuffer: 8 * 1024 * 1024, shell: process.platform === 'win32' }); }
  catch (error) { console.error(error.stdout, error.stderr); throw error; }
}
try {
  const packed = await run(['pack', '--ignore-scripts', '--json', '--pack-destination', task], process.cwd());
  const [artifact] = JSON.parse(packed.stdout);
  const files = new Set(artifact.files.map(f => f.path));
  for (const name of ['dist/index.js', 'dist/index.d.ts', 'dist/host.d.ts', 'dist/style.css', 'README.md', 'NOTICE', 'LICENSE']) assert.ok(files.has(name), name);
  assert.ok(![...files].some(name => /^(src|test|node_modules)\//.test(name)));
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
    '@olorinm/agent-frontend': pathToFileURL(join(task, artifact.filename)).href,
    react: '19.3.0', 'react-dom': '19.3.0', vite: '^8.3.3', typescript: 'npm:@typescript/typescript6@6.0.2',
  }}));
  await writeFile(join(consumer, 'index.html'), consumerHtml);
  await writeFile(join(consumer, 'main.js'), consumerEntry);
  await writeFile(join(consumer, 'usage.ts'), `import { mountFrontend, type FrontendOptions, type FrontendHandle } from '@olorinm/agent-frontend';
const options: FrontendOptions = { apiBase: 'https://example.test/api/', productName: 'Mau' };
const handle: Promise<FrontendHandle> = mountFrontend(document.body, options);
void handle.then(app => app.dispose());\n`);
  await run(['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  const typescriptManifest = JSON.parse(await readFile(join(consumer, 'node_modules/typescript/package.json'), 'utf8'));
  await exec(process.execPath, [join(consumer, 'node_modules/typescript', (typescriptManifest.bin.tsc ?? typescriptManifest.bin.tsc6)), '--noEmit', '--module', 'nodenext', '--target', 'es2022', '--skipLibCheck', 'usage.ts'], { cwd: consumer });
  // Build and serve using ONLY dependencies installed in the temporary consumer.
  const vite = await import(pathToFileURL(join(consumer, 'node_modules/vite/dist/node/index.js')).href);
  await vite.build({ configFile: false, root: consumer, logLevel: 'warn', build: { target: 'esnext' } });
  server = await vite.preview({ configFile: false, root: consumer, preview: { host: '127.0.0.1', port: 0 } });
  await checkBrowser(server.resolvedUrls.local[0].replace(/\/$/, ''));
  console.log(`Independent archive verified: ${artifact.filename}; no repository aliases, symlinks or source imports.`);
} finally {
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  await rm(task, { recursive: true, force: true });
}
