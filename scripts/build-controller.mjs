import { isBuiltin } from "node:module";
import { join, resolve } from "node:path";
import { catalogPublicKey, currentRepositorySlug } from "./repository-config.mjs";
import { atomicWrite, isMain, repositoryRoot } from "./release-files.mjs";

/** Produce a single CommonJS payload with only Node builtins left external. */
export async function buildController({
  root = repositoryRoot,
  outfile = join(root, "build/controller.cjs"),
} = {}) {
  const { build } = await import("esbuild");
  const result = await build({
    absWorkingDir: resolve(root),
    entryPoints: ["controller/src/index.ts"],
    outfile,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "cjs",
    target: "node26",
    sourcemap: false,
    legalComments: "none",
    define: {
      __CHORD_CONTROL_REPOSITORY__: JSON.stringify(currentRepositorySlug(root) ?? ""),
      __CHORD_CONTROL_CATALOG_PUBLIC_KEY__: JSON.stringify(catalogPublicKey(root)),
    },
  });
  for (const output of Object.values(result.metafile.outputs))
    for (const dependency of output.imports)
      if (dependency.external && !isBuiltin(dependency.path))
        throw new Error(`Controller is not self-contained: ${dependency.path}`);
  if (result.outputFiles.length !== 1)
    throw new Error("Expected one self-contained controller payload");
  await atomicWrite(outfile, result.outputFiles[0].contents);
  return outfile;
}

if (isMain(import.meta.url)) await buildController();
