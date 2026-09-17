import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { currentRepositorySlug, parseRepositorySlug } from "./repository-config.mjs";
import {
  isMain,
  jsonBytes,
  readJson,
  releaseTime,
  repositoryRoot,
  sha256,
  withDirectoryLock,
} from "./release-files.mjs";

export const appAssetNames = [
  "Chord.Control-setup.exe",
  "Chord.Control-setup.exe.sig",
  "plugin-controller-x86_64-pc-windows-msvc.exe",
  "latest.json",
  "SHA256SUMS.txt",
];

function base64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error("Malformed updater base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("Noncanonical updater base64");
  return bytes;
}

/** Verify both minisign signatures against the unchanged Tauri updater public key. */
export function verifyUpdaterSignature(bytes, signature, publicKey) {
  const keyLines = base64(publicKey.trim()).toString("utf8").trim().split(/\r?\n/);
  const lines = base64(signature.trim()).toString("utf8").trim().split(/\r?\n/);
  if (
    keyLines.length !== 2 ||
    !keyLines[0].startsWith("untrusted comment:") ||
    lines.length !== 4 ||
    !lines[0].startsWith("untrusted comment:") ||
    !lines[2].startsWith("trusted comment: ")
  )
    throw new Error("Malformed minisign envelope");
  const key = base64(keyLines[1]);
  const packet = base64(lines[1]);
  const global = base64(lines[3]);
  if (
    key.length !== 42 ||
    packet.length !== 74 ||
    global.length !== 64 ||
    key.subarray(0, 2).toString() !== "Ed" ||
    !key.subarray(2, 10).equals(packet.subarray(2, 10))
  )
    throw new Error("Updater signing key mismatch");
  const algorithm = packet.subarray(0, 2).toString();
  if (!["Ed", "ED"].includes(algorithm)) throw new Error("Unsupported updater signature algorithm");
  const pem = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const rawSignature = packet.subarray(10);
  const message = algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes;
  if (
    !verify(null, message, pem, rawSignature) ||
    !verify(
      null,
      Buffer.concat([rawSignature, Buffer.from(lines[2].slice("trusted comment: ".length))]),
      pem,
      global,
    )
  )
    throw new Error("Updater signature verification failed");
}

export async function prepareAppRelease({
  root = repositoryRoot,
  repository = currentRepositorySlug(root),
  generatedAt = releaseTime(),
  refType = process.env.GITHUB_REF_TYPE,
  refName = process.env.GITHUB_REF_NAME,
} = {}) {
  if (parseRepositorySlug(repository) !== repository || !repository)
    throw new Error("GitHub repository is required");
  const config = await readJson(join(root, "src-tauri/tauri.conf.json"));
  const project = await readJson(join(root, "package.json"));
  if (config.version !== project.version || !/^\d+\.\d+\.\d+$/.test(project.version))
    throw new Error("App versions differ or are invalid");
  const tag = `app-v${project.version}`;
  if (refType === "tag" && refName !== tag)
    throw new Error("Release tag does not match app version");
  const notes = (await readFile(join(root, `docs/releases/${project.version}.md`), "utf8")).trim();
  if (!notes) throw new Error("Release notes are empty");
  const bundle = join(root, "src-tauri/target/release/bundle/nsis");
  const installers = (await readdir(bundle, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".exe"),
  );
  if (installers.length !== 1) throw new Error("Expected one Windows installer");
  const installer = join(bundle, installers[0].name);
  const bytes = await readFile(installer);
  const signature = (await readFile(`${installer}.sig`, "utf8")).trim();
  verifyUpdaterSignature(bytes, signature, config.plugins.updater.pubkey);
  const sidecar = await readFile(join(root, "src-tauri/binaries", appAssetNames[2]));
  for (const binary of [bytes, sidecar])
    if (binary.length < 2 || binary.subarray(0, 2).toString() !== "MZ")
      throw new Error("Missing Windows executable");
  const latest = {
    version: project.version,
    notes,
    pub_date: generatedAt,
    platforms: {
      "windows-x86_64": {
        signature,
        url: `https://github.com/${repository}/releases/download/${tag}/${appAssetNames[0]}`,
      },
    },
  };
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("Invalid release date");
  const assets = new Map([
    [appAssetNames[0], bytes],
    [appAssetNames[1], Buffer.from(`${signature}\n`)],
    [appAssetNames[2], sidecar],
    [appAssetNames[3], jsonBytes(latest)],
  ]);
  assets.set(
    appAssetNames[4],
    Buffer.from([...assets].map(([name, data]) => `${sha256(data)}  ${name}`).join("\n") + "\n"),
  );
  const output = resolve(root, "release/app");
  await withDirectoryLock(output, async () => {
    await mkdir(join(root, "release"), { recursive: true });
    const stage = await mkdtemp(`${output}.stage-`);
    const backup = `${stage}.previous`;
    let moved = false;
    try {
      for (const [name, data] of assets) await writeFile(join(stage, name), data);
      try {
        await rename(output, backup);
        moved = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      try {
        await rename(stage, output);
      } catch (error) {
        if (moved) await rename(backup, output);
        throw error;
      }
      await rm(backup, { recursive: true, force: true });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });
  return { tag, notes, assets };
}

if (isMain(import.meta.url))
  console.log(`Prepared ${(await prepareAppRelease()).tag}: five verified assets`);
