import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  assertCatalog,
  assertId,
  assertManifest,
  assertUrl,
  compareVersion,
  safePath,
} from "../shared/plugin-format.ts";
import { assertResolvable } from "../shared/dependencies.ts";
import { CHORD_VERSION, CHORD_MIN_HOST_VERSION } from "../shared/versions.ts";
import { catalogPublicKey, currentRepositorySlug, distributionFor } from "./repository-config.mjs";
import { normalizePublicKey } from "../shared/signing.ts";
import {
  atomicWrite,
  discoverPackages,
  isMain,
  jsonBytes,
  readJson,
  releaseTime,
  repositoryRoot,
  sha256,
  withDirectoryLock,
} from "./release-files.mjs";
import { buildPluginUi } from "./build-plugin-ui.mjs";
import { buildNativePlugin } from "./build-native-plugin.mjs";
import { publisherKey, signed, validatePluginZip, zipDirectory } from "./plugin-artifacts.mjs";

async function sourcePath(directory, name) {
  const root = await realpath(directory);
  const path = await realpath(safePath(root, name));
  const inside = relative(root, path);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Error(`Source escapes package: ${name}`);
  return path;
}

async function compilePlugin({ directory, bundleDir, scratch, pkg }) {
  const [{ build }, { bundleFacets }] = await Promise.all([
    import("esbuild"),
    import("@earendil-works/chord/bundler"),
  ]);
  const result = await build({
    entryPoints: [await sourcePath(directory, "src/worker.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node26",
    minify: true,
    legalComments: "none",
    define: {
      __CHORD_APP_UPDATER__: JSON.stringify(
        (await readJson(join(repositoryRoot, "src-tauri/tauri.conf.json"))).plugins.updater,
      ),
    },
  });
  const entry = join(scratch, "entry.mjs");
  await writeFile(entry, result.outputFiles[0].contents);
  const { manifest, manifestPath } = await bundleFacets({
    plugin: { id: pkg.name, version: pkg.version },
    entries: { worker: entry },
    outdir: bundleDir,
    workingDirectory: resolve(directory),
    platform: "node",
    target: "node26",
    sourceMap: false,
    minify: true,
  });
  // Chord/esbuild's output filename includes the temporary path in its hash.
  // Use the actual bytes so unchanged code produces identical signed archives.
  const worker = manifest.entries.worker;
  const original = safePath(bundleDir, worker.file);
  const file = `facet-${sha256(await readFile(original))}.cjs`;
  await rename(original, safePath(bundleDir, file));
  await writeFile(
    manifestPath,
    jsonBytes({ ...manifest, entries: { ...manifest.entries, worker: { ...worker, file } } }),
  );
  const control = pkg.control ?? {};
  if (control.native) {
    await buildNativePlugin({
      manifest: await sourcePath(directory, control.native.manifest),
      bundleDir,
      declaration: control.native,
      id: pkg.name,
    });
  }
  for (const asset of control.assets ?? []) {
    if (asset === "chord-facets.json" || asset === "ui.html")
      throw new Error(`Reserved asset: ${asset}`);
    const destination = safePath(bundleDir, asset);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(await sourcePath(directory, asset), destination, 1);
  }
  if (control.ui || control.uiScript || control.uiProject) {
    await buildPluginUi({
      directory,
      bundleDir,
      scratch,
      control,
      sourcePath,
      title: control.name ?? pkg.name,
    });
  }
}

/** Existing public build API; compiler injection permits packaging tests without compilation. */
export async function buildPlugin({
  directory,
  outdir,
  baseUrl,
  privateKey,
  compiler = compilePlugin,
}) {
  const pkg = await readJson(join(directory, "package.json"));
  assertId(pkg.name);
  const control = pkg.control ?? {};
  const base = new URL(baseUrl);
  assertUrl(baseUrl);
  if (base.search) throw new Error("Artifact base URL cannot contain a query");
  await mkdir(outdir, { recursive: true });
  const scratch = await mkdtemp(join(resolve(outdir), `.${pkg.name}-`));
  const bundleDir = join(scratch, "bundle");
  try {
    await mkdir(bundleDir);
    await compiler({ directory: resolve(directory), bundleDir, scratch, pkg });
    const zip = await zipDirectory(bundleDir);
    const hash = sha256(zip);
    const artifactName = `${pkg.name}-${hash}.zip`;
    const manifest = signed(
      {
        id: pkg.name,
        name: control.name ?? pkg.name,
        description: pkg.description ?? "",
        version: pkg.version,
        artifactUrl: `${baseUrl.replace(/\/$/, "")}/${artifactName}`,
        artifactSha256: hash,
        minHostVersion:
          compareVersion(control.minHostVersion ?? "0.1.0", CHORD_MIN_HOST_VERSION) > 0
            ? control.minHostVersion
            : CHORD_MIN_HOST_VERSION,
        chordVersion: CHORD_VERSION,
        entry: "worker",
        ...(control.ui || control.uiScript || control.uiProject ? { ui: "ui.html" } : {}),
        permissions: control.permissions ?? [],
        ...Object.fromEntries(
          ["services", "hooks", "icon", "color", "retireAfterHostVersion"]
            .filter((key) => control[key] !== undefined)
            .map((key) => [key, control[key]]),
        ),
      },
      privateKey,
    );
    assertManifest(manifest);
    validatePluginZip(zip, manifest);
    await atomicWrite(join(outdir, artifactName), zip);
    await atomicWrite(join(outdir, `${pkg.name}.json`), jsonBytes(manifest));
    return manifest;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function buildCatalog({
  pluginsRoot,
  outdir,
  baseUrl,
  privateKey,
  generatedAt = releaseTime(),
  compiler,
}) {
  return withDirectoryLock(outdir, async () => {
    const packages = await discoverPackages(pluginsRoot);
    if (!packages.length) throw new Error("No plugin packages found");
    const ids = new Set();
    for (const { manifest } of packages) {
      assertId(manifest.name);
      if (ids.has(manifest.name.toLowerCase()))
        throw new Error(`Duplicate package id: ${manifest.name}`);
      ids.add(manifest.name.toLowerCase());
    }
    const stage = await mkdtemp(`${resolve(outdir)}.stage-`);
    const backup = `${stage}.previous`;
    let moved = false;
    try {
      const plugins = [];
      for (const { directory } of packages)
        plugins.push(
          await buildPlugin({ directory, outdir: stage, baseUrl, privateKey, compiler }),
        );
      assertResolvable(plugins);
      const catalog = signed({ format: 1, generatedAt, plugins }, privateKey);
      assertCatalog(catalog);
      await writeFile(join(stage, "catalog.json"), jsonBytes(catalog));
      if (privateKey)
        await writeFile(join(stage, "publisher-public.pem"), publisherKey(privateKey));
      try {
        await rename(outdir, backup);
        moved = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      try {
        await rename(stage, outdir);
      } catch (error) {
        if (moved) await rename(backup, outdir);
        throw error;
      }
      await rm(backup, { recursive: true, force: true });
      return catalog;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });
}

if (isMain(import.meta.url)) {
  const privateKey = process.env.PLUGIN_SIGNING_PRIVATE_KEY;
  if (!privateKey && !process.argv.includes("--unsigned"))
    throw new Error("Set PLUGIN_SIGNING_PRIVATE_KEY or use --unsigned for local artifacts");
  if (privateKey && normalizePublicKey(catalogPublicKey()) !== publisherKey(privateKey))
    throw new Error("Signing key does not match the trusted publisher key");
  const tag = process.env.PLUGIN_RELEASE_TAG;
  const baseUrl =
    process.env.PLUGIN_RELEASE_BASE_URL ??
    (tag &&
      distributionFor(currentRepositorySlug())?.pluginReleaseBaseUrl.replace(
        "PLUGIN_RELEASE_TAG",
        tag,
      ));
  if (!baseUrl)
    throw new Error("Set PLUGIN_RELEASE_TAG and repository, or PLUGIN_RELEASE_BASE_URL");
  const catalog = await buildCatalog({
    pluginsRoot: join(repositoryRoot, "plugins"),
    outdir: join(repositoryRoot, "release/plugins"),
    baseUrl,
    privateKey,
  });
  console.log(
    `Built ${catalog.plugins.length} plugins and ${privateKey ? "signed" : "unsigned local"} catalogue`,
  );
}
