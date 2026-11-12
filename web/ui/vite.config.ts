import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import manifest from "./package.json" with { type: "json" };
import { scopedStyles } from "./scripts/scoped-styles.mjs";

// One library build for every public entry. The page entries (src/pages) also get one complete,
// `.af-scope`-scoped stylesheet each; the component stylesheets are copied unchanged by copy-styles.
const pages = ["shell", "conversation", "settings", "files", "catalog", "extensions", "auth", "profile"];
export default defineConfig({
  plugins: [react(), scopedStyles()],
  build: {
    cssCodeSplit: true,
    lib: {
      entry: {
        index: resolve(import.meta.dirname, "src/index.ts"),
        "agent-host": resolve(import.meta.dirname, "src/agent-host.tsx"),
        "app/index": resolve(import.meta.dirname, "src/app/index.ts"),
        "pages/index": resolve(import.meta.dirname, "src/pages/index.ts"),
        ...Object.fromEntries(pages.map((name) => [`pages/entries/${name}`, resolve(import.meta.dirname, `src/pages/entries/${name}.ts`)])),
      },
      formats: ["es"],
      fileName: (_, name) => `${name}.js`,
    },
    sourcemap: true,
    rollupOptions: {
      output: { assetFileNames: "assets/[name]-[hash][extname]", chunkFileNames: "chunks/[name].js" },
      external: (id) =>
        Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })
          .some((name) => id === name || id.startsWith(name + "/")) && !id.endsWith(".css"),
    },
  },
});
