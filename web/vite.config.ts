import { randomUUID } from "node:crypto";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Development proxies the same-origin API paths to a local mau-server.
const backend = process.env.MAU_DEV_BACKEND_URL ?? "http://127.0.0.1:8790";
const buildId = process.env.MAU_WEB_BUILD_ID ?? randomUUID();
export default defineConfig({
  define: {__MAU_BUILD_ID__: JSON.stringify(buildId)},
  plugins: [react(), {name: "mau-build-version", generateBundle() {this.emitFile({type: "asset", fileName: "version.json", source: JSON.stringify({buildId})});}}],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/_mau": backend, "/_agent-router": backend } },
});
