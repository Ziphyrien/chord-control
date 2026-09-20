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
            // Keep Kit's generated config at the path extended by the UI's tsconfig.
            outDir: ".svelte-kit",
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
    // Compile SDK/shared sources with this UI's config, rather than discovering
    // the host app's tsconfig and requiring its generated Kit files as well.
    tsconfig: "./tsconfig.json",
    build: { target: "es2022", assetsInlineLimit: Infinity },
  });
}
