import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Development proxies the same-origin API paths to a local mau-server.
const backend = process.env.MAU_DEV_BACKEND_URL ?? "http://127.0.0.1:8790";
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/_mau": backend, "/_agent-router": backend } },
});
