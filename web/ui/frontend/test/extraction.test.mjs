import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const source = JSON.parse(await readFile(join(root, 'source-manifest.json'), 'utf8'));
const walk = async dir => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async item =>
  item.isDirectory() ? walk(join(dir, item.name)) : [join(dir, item.name)]))).flat();

test('every extracted page and stylesheet is present; styles retain upstream bytes', async () => {
  for (const [file, hash] of Object.entries(source.webFiles)) {
    if (source.excluded.includes(`web/src/${file}`)) continue;
    const data = await readFile(join(root, 'src', file));
    if (file.endsWith('.css')) assert.equal(createHash('sha256').update(data).digest('hex'), hash, file);
  }
  for (const file of ['apps/catalog.ts', 'components/sidebar/settings-sections.ts', 'components/sidebar/navigation-mode-policy.ts', 'components/sidebar/settings-mode-policy.ts']) {
    const data = await readFile(join(root, 'src', file));
    assert.equal(createHash('sha256').update(data).digest('hex'), source.webFiles[file], `${file}: retain all existing entries and policies`);
  }
});

test('frontend sources use no server runtime or cross-repository relative import', async () => {
  const names = (await Promise.all(['src','shared','contracts'].map(dir => walk(join(root, dir))))).flat();
  for (const file of names.filter(file => /\.[tj]sx?$/.test(file))) {
    const text = await readFile(file, 'utf8');
    for (const { fileName: spec } of ts.preProcessFile(text, true, true).importedFiles) {
      assert.ok(!spec.startsWith('node:') && !['electron','fs','path','child_process'].includes(spec), `${file}: ${spec}`);
      if (spec.startsWith('.')) assert.ok(resolve(file, '..', spec).startsWith(root + '/'), `${file}: escaped package`);
    }
  }
});

test('approved orphan UI is absent while file and diagnostics UI remain', async () => {
  const markdown = await readFile(join(root,'src/components/knowledge/markdown-preview.tsx'),'utf8');
  const ops = await readFile(join(root,'src/components/system/ops-center-view.tsx'),'utf8');
  assert.doesNotMatch(markdown, /export function (MarkdownProperties|recommendedMarkdownProperties|insertMarkdownFrontmatterProperty|vaultFileDisplayTitle)\b/);
  assert.match(markdown, /export function MarkdownPreview\b/);
  assert.doesNotMatch(ops, /export function (OpsCenterSidebar|OpsCenterView)\b/);
  assert.match(ops, /export function OpsCenterSettingsPanel\b/);
});
