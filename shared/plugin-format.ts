import { resolve, relative, isAbsolute } from "node:path";
import type { PluginManifest, PluginCatalog } from "./protocol.ts";

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
// oxlint-disable-next-line no-control-regex -- Windows filenames cannot contain ASCII control characters.
const INVALID_PATH_CHARACTERS = /[<>:"|?*\x00-\x1f]/;
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function assertUrl(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new Error("插件源必须是 HTTPS URL");
  const url = new URL(value);
  const localDev =
    process.env.CHORD_CONTROL_ALLOW_LOCAL_HTTP === "1" &&
    url.protocol === "http:" &&
    ["127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localDev) || url.username || url.password)
    throw new Error("插件源必须是 HTTPS URL");
}
export function assertId(id: unknown): asserts id is string {
  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id) ||
    id.endsWith(".") ||
    RESERVED.test(id)
  ) {
    throw new Error("插件 id 不是安全的 Windows 目录名");
  }
}
export function compareVersion(left: string, right: string): number {
  const a = left.split(".").map(Number),
    b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
export function safePath(root: string, path: string): string {
  const parts = path.split("/");
  if (
    !path ||
    path.includes("\\") ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        INVALID_PATH_CHARACTERS.test(part) ||
        /[. ]$/.test(part) ||
        RESERVED.test(part),
    )
  ) {
    throw new Error(`artifact 包含非法路径: ${path}`);
  }
  const target = resolve(root, ...parts);
  const rel = relative(resolve(root), target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("artifact 路径越界");
  return target;
}
export function assertManifest(value: unknown): asserts value is PluginManifest {
  if (!object(value)) throw new Error("manifest 必须是 JSON 对象");
  assertId(value.id);
  if (typeof value.name !== "string" || !value.name || value.name.length > 150)
    throw new Error("manifest 缺少有效 name");
  if (typeof value.version !== "string" || !VERSION.test(value.version))
    throw new Error("version 必须为 x.y.z 正式版本号");
  assertUrl(value.artifactUrl);
  if (typeof value.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.artifactSha256))
    throw new Error("artifactSha256 必须为 64 位小写十六进制");
  for (const key of [
    "description",
    "signature",
    "entry",
    "ui",
    "icon",
    "color",
    "chordVersion",
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string")
      throw new Error(`manifest.${key} 必须是字符串`);
  }
  if (
    value.minHostVersion !== undefined &&
    (typeof value.minHostVersion !== "string" || !VERSION.test(value.minHostVersion))
  )
    throw new Error("minHostVersion 格式错误");
  if (
    value.permissions !== undefined &&
    (!Array.isArray(value.permissions) || value.permissions.some((p) => typeof p !== "string"))
  )
    throw new Error("permissions 必须是字符串数组");
  for (const key of ["hooks"] as const)
    if (
      value[key] !== undefined &&
      (!Array.isArray(value[key]) ||
        value[key].length > 50 ||
        value[key].some((item) => typeof item !== "string" || !item || item.length > 150))
    )
      throw new Error(`${key} 必须是有效字符串数组`);
  if (value.services !== undefined) {
    if (!object(value.services)) throw new Error("services 格式错误");
    for (const key of ["provides", "requires"]) {
      const ids = value.services[key];
      if (
        !Array.isArray(ids) ||
        ids.length > 100 ||
        ids.some((id) => typeof id !== "string" || !id || id.length > 150) ||
        new Set(ids).size !== ids.length
      )
        throw new Error(`services.${key} 格式错误`);
    }
  }
  if (typeof value.ui === "string") safePath(resolve("."), value.ui);
}
export function assertCatalog(value: unknown): asserts value is PluginCatalog {
  if (
    !object(value) ||
    value.format !== 1 ||
    !Array.isArray(value.plugins) ||
    value.plugins.length > 100
  )
    throw new Error("插件目录格式错误或超过 100 项");
  if (
    value.generatedAt !== undefined &&
    (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt)))
  )
    throw new Error("插件目录时间格式错误");
  const ids = new Set<string>();
  for (const item of value.plugins) {
    assertManifest(item);
    if (ids.has(item.id)) throw new Error("插件目录包含重复 id");
    ids.add(item.id);
  }
}
