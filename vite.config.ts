import { defineConfig } from "vite";
import { catalogPublicKey, currentRepositorySlug } from "./scripts/repository-config.mjs";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte({ configFile: false, preprocess: vitePreprocess() })],
  define: {
    __CHORD_CONTROL_REPOSITORY__: JSON.stringify(currentRepositorySlug() ?? ""),
    __CHORD_CONTROL_CATALOG_PUBLIC_KEY__: JSON.stringify(catalogPublicKey()),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/controller/**",
        "**/build/**",
        "**/release/**",
        "**/.local/**",
        "**/test-results/**",
      ],
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
