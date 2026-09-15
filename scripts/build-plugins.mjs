import { createHash, createPublicKey, sign } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleFacets } from "@earendil-works/chord/bundler";
import { build } from "esbuild";
import { zipSync } from "fflate";
import { signingBytes } from "../shared/signing.ts";
import { assertId, assertManifest, safePath } from "../shared/plugin-format.ts";
import { HOST_VERSION, CHORD_VERSION } from "../shared/versions.ts";
import { currentRepositorySlug, distributionFor } from "./repository-config.mjs";

function signed(value, privateKey) {
  return privateKey
    ? { ...value, signature: sign(null, signingBytes(value), privateKey).toString("base64") }
    : value;
}
async function zipDirectory(directory) {
  const entries = {};
  async function walk(root, prefix = "") {
    for (const item of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = `${prefix}${item.name}`;
      if (item.isDirectory()) await walk(join(root, item.name), `${name}/`);
      else if (item.isFile())
        entries[name] = [
          await readFile(join(root, item.name)),
          { mtime: new Date("2020-01-01T00:00:00Z") },
        ];
      else throw new Error(`Unsupported artifact entry: ${name}`);
    }
  }
  await walk(directory);
  return zipSync(entries, { level: 6 });
}
export async function buildPlugin({ directory, outdir, baseUrl, privateKey }) {
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  assertId(pkg.name);
  const control = pkg.control ?? {};
  const bundleDir = join(outdir, `${pkg.name}.bundle`);
  await mkdir(outdir, { recursive: true });
  // Chord always externalizes its own package. Resolve dependencies in an ESM
  // prebundle first, then let the official bundler write its loader manifest.
  const prebundle = await build({
    entryPoints: [resolve(directory, "src/worker.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: true,
    legalComments: "none",
  });
  const entryPath = join(outdir, `${pkg.name}.entry.mjs`);
  await writeFile(entryPath, prebundle.outputFiles[0].text);
  try {
    await bundleFacets({
      plugin: { id: pkg.name, version: pkg.version },
      entries: { worker: resolve(entryPath) },
      outdir: bundleDir,
      workingDirectory: resolve(directory),
      platform: "node",
      target: "node22",
      sourceMap: false,
      minify: true,
    });
  } finally {
    await rm(entryPath, { force: true });
  }
  for (const asset of control.assets ?? []) {
    const dest = safePath(bundleDir, asset);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(safePath(directory, asset), dest);
  }
  if (control.ui) {
    let html = await readFile(safePath(directory, control.ui), "utf8");
    if (control.uiScript) {
      const result = await build({
        entryPoints: [safePath(directory, control.uiScript)],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "es2022",
        minify: true,
      });
      if (!html.includes("<!--PLUGIN_SCRIPT-->"))
        throw new Error("UI template must contain <!--PLUGIN_SCRIPT-->");
      html = html.replace(
        "<!--PLUGIN_SCRIPT-->",
        `<script>${result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script>`,
      );
    }
    await writeFile(join(bundleDir, "ui.html"), html);
  }
  const zip = await zipDirectory(bundleDir);
  const hash = createHash("sha256").update(zip).digest("hex");
  const artifactName = `${pkg.name}-${hash}.zip`;
  const manifest = signed(
    {
      id: pkg.name,
      name: control.name ?? pkg.name,
      description: pkg.description ?? "",
      version: pkg.version,
      artifactUrl: `${baseUrl.replace(/\/$/, "")}/${artifactName}`,
      artifactSha256: hash,
      minHostVersion: HOST_VERSION,
      chordVersion: CHORD_VERSION,
      entry: "worker",
      ...(control.ui ? { ui: "ui.html" } : {}),
      permissions: control.permissions ?? [],
      ...(control.services ? { services: control.services } : {}),
      ...(control.hooks ? { hooks: control.hooks } : {}),
    },
    privateKey,
  );
  assertManifest(manifest);
  await writeFile(join(outdir, artifactName), zip);
  await writeFile(join(outdir, `${pkg.name}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(bundleDir, { recursive: true, force: true });
  return manifest;
}
export async function buildCatalog({ pluginsRoot, outdir, baseUrl, privateKey }) {
  const plugins = [];
  for (const entry of (await readdir(pluginsRoot, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory())
      plugins.push(
        await buildPlugin({
          directory: join(pluginsRoot, entry.name),
          outdir,
          baseUrl,
          privateKey,
        }),
      );
  }
  const catalog = signed({ format: 1, generatedAt: new Date().toISOString(), plugins }, privateKey);
  await writeFile(join(outdir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  if (privateKey)
    await writeFile(
      join(outdir, "publisher-public.pem"),
      createPublicKey(privateKey).export({ format: "pem", type: "spki" }),
    );
  return catalog;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const privateKey = process.env.PLUGIN_SIGNING_PRIVATE_KEY;
  if (!privateKey && !process.argv.includes("--unsigned"))
    throw new Error(
      "Set PLUGIN_SIGNING_PRIVATE_KEY (Ed25519 PEM), or pass --unsigned for a local development artifact",
    );
  const outdir = resolve("release/plugins");
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  const repository = currentRepositorySlug();
  const distribution = distributionFor(repository);
  const releaseTag = process.env.PLUGIN_RELEASE_TAG ?? "plugin-channel";
  const baseUrl =
    process.env.PLUGIN_RELEASE_BASE_URL ??
    distribution?.pluginReleaseBaseUrl.replace("PLUGIN_RELEASE_TAG", releaseTag);
  if (!baseUrl)
    throw new Error("无法解析当前 GitHub 仓库，请设置 CHORD_CONTROL_REPOSITORY 或配置 origin");
  const catalog = await buildCatalog({
    pluginsRoot: resolve("plugins"),
    outdir,
    baseUrl,
    privateKey,
  });
  console.log(`Built ${catalog.plugins.length} plugin(s) and catalog.json in ${outdir}`);
}
