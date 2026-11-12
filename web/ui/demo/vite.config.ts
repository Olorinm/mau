import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
// The demo imports the built package through its public exports (run `npm run build` first).
export default defineConfig({root:resolve(import.meta.dirname),plugins:[react()],server:{host:'127.0.0.1'}});
