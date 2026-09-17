import { defineConfig, lazyPlugins } from "vite-plus";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { catalogPublicKey, currentRepositorySlug } from "./scripts/repository-config.mjs";

const ignored = ["src-tauri", "controller", "build", "release", ".local", "test-results"].map(
  (directory) => `**/${directory}/**`,
);
const generated = [
  "build/**",
  "dist/**",
  "release/**",
  ".local/**",
  "src-tauri/target/**",
  "src-tauri/gen/**",
];

export default defineConfig({
  fmt: {
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    endOfLine: "lf",
    svelte: true,
    ignorePatterns: ["bun.lock", "src-tauri/Cargo.lock", ...generated],
  },
  lint: {
    categories: { correctness: "error" },
    ignorePatterns: generated,
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
  },
  test: {
    environment: "node",
    include: ["tests/*.test.mjs", "src/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 4,
    hookTimeout: 15_000,
    sequence: { hooks: "stack" },
  },
  plugins: lazyPlugins(() => [svelte({ configFile: false, preprocess: vitePreprocess() })]),
  define: {
    __CHORD_CONTROL_REPOSITORY__: JSON.stringify(currentRepositorySlug() ?? ""),
    __CHORD_CONTROL_CATALOG_PUBLIC_KEY__: JSON.stringify(catalogPublicKey()),
  },
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true, watch: { ignored } },
  build: { target: "es2022", sourcemap: true, outDir: "dist", emptyOutDir: true },
});
