import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { catalogPublicKey, currentRepositorySlug } from "./scripts/repository-config.mjs";

const ignored = ["src-tauri", "controller", "build", "release", ".local", "test-results"].map(
  (directory) => `**/${directory}/**`,
);

export default defineConfig({
  plugins: [svelte({ configFile: false, preprocess: vitePreprocess() })],
  define: {
    __CHORD_CONTROL_REPOSITORY__: JSON.stringify(currentRepositorySlug() ?? ""),
    __CHORD_CONTROL_CATALOG_PUBLIC_KEY__: JSON.stringify(catalogPublicKey()),
  },
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true, watch: { ignored } },
  build: { target: "es2022", sourcemap: true, outDir: "dist", emptyOutDir: true },
});
