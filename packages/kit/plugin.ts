import { join } from "node:path";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, lazyPlugins } from "vite-plus";
import { createStaticConfig } from "./static.ts";

/** Build-time configuration only; the plugin host serves the resulting HTML. */
export function createPluginConfig() {
  const root = process.env.CHORD_PLUGIN_UI_BUILD_ROOT;
  return defineConfig({
    plugins: lazyPlugins(() => [
      sveltekit(
        createStaticConfig({
          output: root ? join(root, "public") : "dist/ui",
          kit: {
            outDir: root ? join(root, "kit") : ".svelte-kit",
            embedded: true,
            // Archive identity and page revocation own updates; timestamps must not change bytes.
            version: { name: "plugin", pollInterval: 0 },
            output: { bundleStrategy: "inline" },
            prerender: { entries: [] },
            serviceWorker: { register: false },
          },
        }),
      ),
    ]),
    build: { target: "es2022", assetsInlineLimit: Infinity },
  });
}
