import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import manifest from "./package.json" with { type: "json" };
import { scopedStyles } from "./scripts/scoped-styles.mjs";
export default defineConfig({
  plugins: [react(), scopedStyles()],
  build: {
    cssCodeSplit: true,
    lib: {
      entry: Object.fromEntries(
        [
          "index",
          "shell",
          "conversation",
          "settings",
          "files",
          "catalog",
          "extensions",
          "auth",
          "profile",
        ].map((name) => [
          name,
          resolve(
            import.meta.dirname,
            name === "index" ? "src/index.ts" : `src/entries/${name}.ts`,
          ),
        ]),
      ),
      formats: ["es"],
      fileName: (_, name) => `${name}.js`,
    },
    sourcemap: true,
    rollupOptions: {
      output: { assetFileNames: "assets/[name]-[hash][extname]" },
      external: (id) =>
        Object.keys({
          ...manifest.dependencies,
          ...manifest.peerDependencies,
        }).some((name) => id === name || id.startsWith(name + "/")) &&
        !id.endsWith(".css"),
    },
  },
});
