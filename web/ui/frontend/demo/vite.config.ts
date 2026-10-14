import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
export default defineConfig({root:resolve(import.meta.dirname),plugins:[react()],server:{host:'127.0.0.1'},resolve:{alias:{'@olorinm/agent-frontend/style.css':resolve(import.meta.dirname,'../dist/style.css'),'@olorinm/agent-frontend':resolve(import.meta.dirname,'../dist/index.js')}}});
