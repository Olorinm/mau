import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import manifest from './package.json' with { type: 'json' };
export default defineConfig({
 plugins: [react()],
 build: {
  lib: { entry: resolve(import.meta.dirname, 'src/index.ts'), formats: ['es'], fileName: () => 'index.js', cssFileName: 'style' },
  sourcemap: true,
  rollupOptions: { external: id => Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).some(name => id === name || id.startsWith(name + '/')) && !id.endsWith('.css') },
 },
});
