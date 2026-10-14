import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const { code } = await transform(await readFile(new URL('../src/host.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
let instance = 0;
const load = () => import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${instance++}`);

test('adapter preserves request bodies, cancellation and streaming responses without replacing global fetch', async () => {
  const { configureFrontend, frontendFetch } = await load();
  const originalFetch = globalThis.fetch;
  const abort = new AbortController();
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: result\n')); controller.close(); } });
  const response = new Response(stream);
  let captured;
  configureFrontend({ apiBase: 'https://product.example/api/', headers: async () => ({ Authorization: 'Bearer fixture' }),
    fetch: async (input, init) => { captured = { input, init }; return response; } });
  const request = new Request('https://product.example/api/ask', { method: 'POST', body: '{"prompt":"fixture"}', headers: { 'x-request-id': 'example' } });
  assert.equal(await frontendFetch(request, { signal: abort.signal }), response);
  assert.equal(captured.input, request);
  assert.equal(captured.init.signal, abort.signal);
  assert.equal(captured.init.headers.get('authorization'), 'Bearer fixture');
  assert.equal(captured.init.headers.get('x-request-id'), 'example');
  assert.equal(await captured.input.text(), '{"prompt":"fixture"}');
  assert.equal(await response.text(), 'event: result\n');
  assert.equal(globalThis.fetch, originalFetch);
});

test('host authentication is scoped to the API origin and path', async () => {
  const { configureFrontend, frontendFetch } = await load();
  const headers = [];
  configureFrontend({ apiBase: 'https://product.example/api/', headers: () => ({ Authorization: 'Bearer fixture' }),
    fetch: async (_input, init) => { headers.push(init.headers.get('authorization')); return new Response(); } });
  for (const url of ['https://product.example/api/rooms', 'https://other.example/api/rooms', 'https://product.example/api-foreign', 'https://product.example/generated/asset', 'https://product.example/api/../outside']) await frontendFetch(url);
  assert.deepEqual(headers, ['Bearer fixture', null, null, null, null]);
});

test('invalid bases and changes to document identity fail explicitly', async () => {
  const { configureFrontend } = await load();
  for (const apiBase of ['file:///api/', 'https://u:p@example.test/api/', 'https://example.test/api/?token=x', 'https://example.test/api/#x']) assert.throws(() => configureFrontend({ apiBase }));
  const options = { apiBase: 'https://example.test/api', storageNamespace: 'mau', productName: 'Mau' };
  configureFrontend(options);
  configureFrontend({ ...options, apiBase: 'https://example.test/api/' });
  assert.throws(() => configureFrontend({ ...options, storageNamespace: 'other' }), /requires_new_document/);
  assert.throws(() => configureFrontend({ ...options, apiBase: 'https://other.test/api/' }), /requires_new_document/);
  assert.throws(() => configureFrontend({ ...options, productName: 'Other' }), /requires_new_document/);
});
