import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import manifest from './package.json' with { type: 'json' };

export const aliases = {
  '#protocol': resolve(import.meta.dirname, 'contracts/protocol/index.ts'),
  '@opengrove/protocol': resolve(import.meta.dirname, 'contracts/protocol/index.ts'),
  '@opengrove/client': resolve(import.meta.dirname, 'contracts/client/index.ts'),
  '@opengrove/agent-protocol/locale-registry': resolve(import.meta.dirname, 'contracts/agent-protocol/locale-registry.ts'),
  '@opengrove/agent-protocol': resolve(import.meta.dirname, 'contracts/agent-protocol/index.ts'),
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: aliases },
  define: {
    __OPENGROVE_BUILD_ID__: JSON.stringify('library'),
    __OPENGROVE_PACKAGE_VERSION__: JSON.stringify(manifest.version),
    __OPENGROVE_DEV_FIXTURE_ACCOUNTS__: 'false',
  },
  build: {
    lib: { entry: resolve(import.meta.dirname, 'src/index.ts'), formats: ['es'], fileName: () => 'index.js', cssFileName: 'style' },
    sourcemap: true,
    rollupOptions: {
      external: (id) => Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).some(name => id === name || id.startsWith(name + '/')) && !id.endsWith('.css'),
    },
  },
});
