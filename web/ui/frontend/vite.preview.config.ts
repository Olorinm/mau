import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(import.meta.dirname, 'examples/mau'),
  server: {
    host: '127.0.0.1',
    ...(process.env.FRONTEND_BACKEND_URL ? { proxy: Object.fromEntries(
      ['/api', '/generated', '/vault-file', '/apps', '/mcp-app-sandbox', '/mcp-app-media'].map(path => [path, {
        target: process.env.FRONTEND_BACKEND_URL, changeOrigin: false,
      }]),
    ) } : {}),
  },
});
