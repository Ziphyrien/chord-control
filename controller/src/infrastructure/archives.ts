import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { readFacetBundleArtifact, readFacetBundleManifest } from "@earendil-works/chord/node";
import type { PluginManifest } from "../../../shared/protocol.ts";
import { safePath, assertId } from "../../../shared/plugin-format.ts";
import { atomicWrite } from "./files.ts";
import type { Archives } from "../domain/ports.ts";

export function verifyHash(manifest: PluginManifest, bytes: Uint8Array): void {
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.artifactSha256)
    throw new Error("artifact SHA-256 校验失败");
}
export async function unpack(
  root: string,
  manifest: PluginManifest,
  bytes: Uint8Array,
): Promise<string> {
  verifyHash(manifest, bytes);
  const directory = join(root, randomUUID()),
    seen = new Set<string>();
  let total = 0;
  try {
    const files = unzipSync(bytes, {
      filter(entry) {
        const name = entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
        safePath(directory, name);
        if (entry.name.endsWith("/")) return false;
        const key = name.toLowerCase();
        if (seen.has(key)) throw new Error("artifact 存在大小写冲突路径");
        seen.add(key);
        total += entry.originalSize;
        if (!Number.isSafeInteger(total) || total > 250 * 1024 * 1024 || seen.size > 2048)
          throw new Error("artifact 解压超过大小限制");
        return true;
      },
    });
    await mkdir(directory, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const path = safePath(directory, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    const bundle = await readFacetBundleManifest(join(directory, "chord-facets.json"));
    if (bundle.plugin.id !== manifest.id || bundle.plugin.version !== manifest.version)
      throw new Error("bundle 身份与发布 manifest 不一致");
    const entry = bundle.entries[manifest.entry ?? "worker"];
    if (!entry) throw new Error("bundle 缺少 worker 入口");
    if (entry.externalImports.some((name) => !isBuiltin(name)))
      throw new Error("插件必须打包全部 JS 依赖");
    safePath(directory, entry.file);
    await readFacetBundleArtifact({
      manifestPath: join(directory, "chord-facets.json"),
      entry: manifest.entry ?? "worker",
    });
    if (
      manifest.ui &&
      (await readFile(safePath(directory, manifest.ui))).byteLength > 2 * 1024 * 1024
    )
      throw new Error("插件 UI 超过 2 MiB 限制");
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export class ArchiveStore implements Archives {
  readonly directory: string;
  readonly staging: string;
  private readonly data: string;
  constructor(root: string) {
    this.directory = join(root, "artifacts");
    this.staging = join(root, "staging");
    this.data = join(root, "data");
  }
  async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await rm(this.staging, { recursive: true, force: true });
    await mkdir(this.staging, { recursive: true });
  }
  async purge(manifest: PluginManifest): Promise<void> {
    assertId(manifest.id);
    await rm(join(this.data, manifest.id), { recursive: true, force: true });
    await rm(join(this.directory, `${manifest.artifactSha256}.zip`), { force: true });
  }
  async read(manifest: PluginManifest): Promise<Uint8Array> {
    const bytes = await readFile(join(this.directory, `${manifest.artifactSha256}.zip`));
    verifyHash(manifest, bytes);
    return bytes;
  }
  async write(manifest: PluginManifest, bytes: Uint8Array): Promise<void> {
    verifyHash(manifest, bytes);
    await atomicWrite(join(this.directory, `${manifest.artifactSha256}.zip`), bytes);
  }
  async validate(manifest: PluginManifest, bytes: Uint8Array): Promise<void> {
    const directory = await unpack(this.staging, manifest, bytes);
    await rm(directory, { recursive: true, force: true });
  }
}
