import { defineConfig, lazyPlugins } from "vite-plus";
import { sveltekit } from "@sveltejs/kit/vite";
import { createStaticConfig } from "@chord-control/kit/static";

export default defineConfig({
  plugins: lazyPlugins(() => [
    sveltekit(
      createStaticConfig({
        output: "dist",
        kit: process.env.TELEMETRY_TEST_KIT_OUT_DIR
          ? { outDir: process.env.TELEMETRY_TEST_KIT_OUT_DIR }
          : {},
      }),
    ),
  ]),
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:8787" } },
});
