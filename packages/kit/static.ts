import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import type { Config as KitConfig } from "@sveltejs/kit/vite";

/** Inline options for sveltekit() (Kit 3). Applications own routes and services. */
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
