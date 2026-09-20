import { fileURLToPath } from "node:url";
import { defineConfig, lazyPlugins } from "vite-plus";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { sveltekit } from "@sveltejs/kit/vite";
import { createStaticConfig } from "@chord-control/kit/static";
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
  "services/telemetry/worker-configuration.d.ts",
  "services/telemetry/.wrangler/**",
  "**/.svelte-kit/**",
  "services/**/dist/**",
  "plugins/**/dist/**",
];

export default defineConfig(({ mode }) => ({
  fmt: {
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    endOfLine: "lf",
    svelte: true,
    ignorePatterns: ["bun.lock", "src-tauri/Cargo.lock", "plugins/**/Cargo.lock", ...generated],
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
    include: ["tests/*.test.mjs", "src/**/*.test.ts", "packages/ui/tests/*.test.mjs"],
    pool: "forks",
    maxWorkers: 4,
    hookTimeout: 15_000,
    sequence: { hooks: "stack" },
  },
  plugins: lazyPlugins(() =>
    process.env.VITEST
      ? [svelte({ configFile: false })]
      : [
          sveltekit(
            createStaticConfig({
              kit: {
                alias: {
                  $platform: fileURLToPath(
                    new URL(
                      mode === "ui-test" ? "./tests/browser.ts" : "./src/lib/platform.ts",
                      import.meta.url,
                    ),
                  ),
                },
              },
            }),
          ),
        ],
  ),
  define: {
    __CHORD_CONTROL_REPOSITORY__: JSON.stringify(currentRepositorySlug() ?? ""),
    __CHORD_CONTROL_CATALOG_PUBLIC_KEY__: JSON.stringify(catalogPublicKey()),
  },
  clearScreen: false,
  optimizeDeps: { include: ["bits-ui"] },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url))] },
    watch: { ignored },
  },
  build: { target: "es2022", sourcemap: true },
}));
