import { build } from "esbuild";
import { resolve } from "node:path";
import { catalogPublicKey, currentRepositorySlug } from "./repository-config.mjs";
import { fileURLToPath } from "node:url";
export async function buildController() {
  await build({
    entryPoints: ["controller/src/index.ts"],
    outfile: "build/controller.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: false,
    define: {
      __CHORD_CONTROL_REPOSITORY__: JSON.stringify(
        process.argv.includes("--test") ? "" : (currentRepositorySlug() ?? ""),
      ),
      __CHORD_CONTROL_CATALOG_PUBLIC_KEY__: JSON.stringify(
        process.argv.includes("--test") ? "" : catalogPublicKey(),
      ),
    },
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildController();
