import { createPrivateKey, createPublicKey, KeyObject, sign } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { assertCatalog, assertManifest, safePath } from "../shared/plugin-format.ts";
import { assertResolvable } from "../shared/dependencies.ts";
import { signingBytes, verifySigned } from "../shared/signing.ts";
import { compareNames, readJson, sha256 } from "./release-files.mjs";

export function publisherKey(privateKey) {
  const key = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Publisher must use Ed25519");
  return createPublicKey(key).export({ format: "pem", type: "spki" }).toString();
}

export function signed(value, privateKey) {
  if (!privateKey) return value;
  publisherKey(privateKey);
  return { ...value, signature: sign(null, signingBytes(value), privateKey).toString("base64") };
}

export async function zipDirectory(directory) {
  const entries = Object.create(null);
  const names = new Set();
  async function walk(root, prefix = "") {
    for (const item of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
      compareNames(a.name, b.name),
    )) {
      const name = `${prefix}${item.name}`;
      safePath(directory, name);
      if (names.has(name.toLowerCase())) throw new Error(`Case collision: ${name}`);
      names.add(name.toLowerCase());
      if (item.isDirectory()) await walk(join(root, item.name), `${name}/`);
      else if (item.isFile())
        entries[name] = [
          await readFile(join(root, item.name)),
          { mtime: new Date(2020, 0, 1, 0, 0, 0), os: 0 },
        ];
      else throw new Error(`Unsupported artifact entry: ${name}`);
    }
  }
  await walk(directory);
  return zipSync(entries, { level: 6 });
}

/** Validate the actual archive, including the loader's identity and bundled dependencies. */
export function validatePluginZip(bytes, manifest) {
  assertManifest(manifest);
  if (bytes.length > 100 * 1024 * 1024 || sha256(bytes) !== manifest.artifactSha256)
    throw new Error("Artifact hash or size mismatch");
  const seen = new Set();
  let total = 0;
  const files = unzipSync(bytes, {
    filter(entry) {
      const name = entry.name.replace(/\/$/, "");
      safePath("/artifact", name);
      if (seen.has(name.toLowerCase())) throw new Error(`Duplicate archive path: ${name}`);
      seen.add(name.toLowerCase());
      total += entry.originalSize;
      if (!Number.isSafeInteger(total) || total > 250 * 1024 * 1024 || seen.size > 2048)
        throw new Error("Archive expansion limit exceeded");
      return !entry.name.endsWith("/");
    },
  });
  const bundle = JSON.parse(Buffer.from(files["chord-facets.json"] ?? []).toString("utf8"));
  if (bundle.format !== "chord.facet-bundle" || bundle.formatVersion !== 2)
    throw new Error("Unsupported Chord bundle format");
  if (bundle.plugin?.id !== manifest.id || bundle.plugin?.version !== manifest.version)
    throw new Error("Bundle identity mismatch");
  const worker = bundle.entries?.[manifest.entry ?? "worker"];
  if (!worker || !Array.isArray(worker.externalImports)) throw new Error("Missing worker metadata");
  for (const entry of Object.values(bundle.entries)) {
    safePath("/artifact", entry.file);
    if (!files[entry.file]?.length) throw new Error(`Missing bundle entry: ${entry.file}`);
    const integrity = `sha256-${Buffer.from(sha256(files[entry.file]), "hex").toString("base64")}`;
    if (entry.integrity !== integrity) throw new Error(`Entry integrity mismatch: ${entry.file}`);
    if (
      !Array.isArray(entry.externalImports) ||
      entry.externalImports.some((name) => !isBuiltin(name))
    )
      throw new Error("Plugin contains unbundled dependencies");
  }
  if (manifest.ui && (!files[manifest.ui]?.length || files[manifest.ui].length > 2 * 1024 * 1024))
    throw new Error("Missing or oversized plugin UI");
  return files;
}

export async function validatePluginRelease(directory, { publicKey, baseUrl } = {}) {
  const catalog = await readJson(join(directory, "catalog.json"));
  assertCatalog(catalog);
  assertResolvable(catalog.plugins);
  verifySigned(catalog, publicKey);
  const assets = new Map();
  for (const manifest of catalog.plugins) {
    verifySigned(manifest, publicKey);
    const name = `${manifest.id}-${manifest.artifactSha256}.zip`;
    if (baseUrl && manifest.artifactUrl !== `${baseUrl}/${name}`)
      throw new Error(`Wrong artifact URL: ${manifest.id}`);
    const metadataName = `${manifest.id}.json`;
    const metadata = await readFile(join(directory, metadataName));
    if (
      !signingBytes(JSON.parse(metadata)).equals(signingBytes(manifest)) ||
      JSON.parse(metadata).signature !== manifest.signature
    )
      throw new Error(`Metadata differs from catalogue: ${manifest.id}`);
    const bytes = await readFile(join(directory, name));
    validatePluginZip(bytes, manifest);
    assets.set(name, bytes);
    assets.set(metadataName, metadata);
  }
  assets.set("catalog.json", await readFile(join(directory, "catalog.json")));
  const advertisedKey = await readFile(join(directory, "publisher-public.pem"));
  if (advertisedKey.toString().trim() !== publicKey.trim())
    throw new Error("Release publisher key differs from trusted key");
  assets.set("publisher-public.pem", Buffer.from(publicKey));
  for (const entry of await readdir(directory)) {
    if (!assets.has(entry) || !(await lstat(join(directory, entry))).isFile())
      throw new Error(`Unexpected release file: ${entry}`);
  }
  return { catalog, assets };
}
