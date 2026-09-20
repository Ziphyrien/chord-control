import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import type { KitConfig } from "@sveltejs/kit";

/** Inline options for sveltekit() (Kit 2.62+). Applications own routes and services. */
export function createStaticConfig({
  output = "dist",
  kit = {},
}: {
  output?: string;
  kit?: KitConfig;
} = {}) {
  return {
    preprocess: vitePreprocess(),
    adapter: adapter({ pages: output, assets: output, fallback: "index.html" }),
    ...kit,
  };
}
