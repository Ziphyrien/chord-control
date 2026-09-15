import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { readFacetBundleManifest } from "@earendil-works/chord/node";
import type { PluginManifest } from "../../shared/protocol.ts";
import { safePath } from "../../shared/plugin-format.ts";
const MAX_FILES = 2048;
const MAX_UNPACKED = 250 * 1024 * 1024;

export function verifyHash(manifest: PluginManifest, bytes: Uint8Array): void {
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.artifactSha256)
    throw new Error("artifact SHA-256 校验失败");
}
export async function unpack(
  stagingRoot: string,
  manifest: PluginManifest,
  bytes: Uint8Array,
): Promise<string> {
  const staging = join(stagingRoot, randomUUID());
  let size = 0,
    count = 0;
  const names = new Set<string>();
  try {
    const files = unzipSync(bytes, {
      filter(file) {
        const name = file.name.endsWith("/") ? file.name.slice(0, -1) : file.name;
        safePath(staging, name);
        if (file.name.endsWith("/")) return false;
        const folded = name.toLowerCase();
        if (names.has(folded)) throw new Error("artifact 存在大小写冲突路径");
        names.add(folded);
        size += file.originalSize;
        count++;
        if (size > MAX_UNPACKED || count > MAX_FILES) throw new Error("artifact 解压超过大小限制");
        return true;
      },
    });
    await mkdir(staging, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const path = safePath(staging, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    const bundle = await readFacetBundleManifest(join(staging, "chord-facets.json"));
    if (bundle.plugin.id !== manifest.id || bundle.plugin.version !== manifest.version)
      throw new Error("bundle 身份与发布 manifest 不一致");
    const entry = bundle.entries[manifest.entry ?? "worker"];
    if (!entry) throw new Error("bundle 缺少 worker 入口");
    if (entry.externalImports.some((name) => !isBuiltin(name)))
      throw new Error("插件必须在 CI 打包所有 JS 依赖，不能依赖宿主 node_modules");
    safePath(staging, entry.file);
    if (manifest.ui) {
      const html = await readFile(safePath(staging, manifest.ui));
      if (html.byteLength > 2 * 1024 * 1024) throw new Error("插件 UI 超过 2 MiB 限制");
    }
    return staging;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
