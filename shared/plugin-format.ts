import { isAbsolute, relative, resolve } from "node:path";
import type { PluginCatalog, PluginManifest } from "./protocol.ts";
import { object, strings, text } from "./validation.ts";
export { object } from "./validation.ts";

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
// oxlint-disable-next-line no-control-regex -- Windows disallows these characters in path segments.
const ILLEGAL = /[<>:"|?*\x00-\x1f]/;
function version(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !VERSION.test(value) ||
    value.split(".").some((part) => !Number.isSafeInteger(Number(part)))
  )
    throw new Error("version 必须为 x.y.z 正式版本号");
}
export function assertId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value) ||
    value.endsWith(".") ||
    RESERVED.test(value)
  )
    throw new Error("插件 id 不是安全的 Windows 目录名");
}
export function assertUrl(value: unknown): asserts value is string {
  const address = text(value, "插件源地址", 4096);
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error("插件源必须是 HTTPS URL");
  }
  const local =
    process.env.CHORD_CONTROL_ALLOW_LOCAL_HTTP === "1" &&
    url.protocol === "http:" &&
    ["127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.username || url.password || url.hash)
    throw new Error("插件源必须是 HTTPS URL");
}
export function compareVersion(left: string, right: string): number {
  version(left);
  version(right);
  const a = left.split(".").map(Number),
    b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++)
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}
export function safePath(root: string, path: string): string {
  const segments = path.split("/");
  if (
    !path ||
    path.includes("\\") ||
    segments.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        ILLEGAL.test(part) ||
        /[. ]$/.test(part) ||
        RESERVED.test(part),
    )
  )
    throw new Error(`artifact 包含非法路径: ${path}`);
  const target = resolve(root, ...segments),
    inside = relative(resolve(root), target);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Error("artifact 路径越界");
  return target;
}
export function assertManifest(value: unknown): asserts value is PluginManifest {
  if (!object(value)) throw new Error("manifest 必须是 JSON 对象");
  assertId(value.id);
  text(value.name, "插件名称", 150);
  version(value.version);
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
  ] as const)
    if (value[key] !== undefined)
      text(value[key], `manifest.${key}`, key === "description" ? 4000 : 512, true);
  if (value.minHostVersion !== undefined) version(value.minHostVersion);
  if (value.retireAfterHostVersion !== undefined) {
    version(value.retireAfterHostVersion);
    if (
      (object(value.services) &&
        Array.isArray(value.services.provides) &&
        value.services.provides.length) ||
      (Array.isArray(value.hooks) && value.hooks.length)
    )
      throw new Error("一次性插件不能提供持久服务或策略");
  }
  if (value.permissions !== undefined) strings(value.permissions, "permissions");
  if (value.hooks !== undefined) strings(value.hooks, "hooks", 50);
  if (value.services !== undefined) {
    if (!object(value.services)) throw new Error("services 格式错误");
    strings(value.services.requires, "services.requires");
    const exports = strings(value.services.provides, "services.provides");
    if (exports.some((id) => id.startsWith("chord-control.") || id.startsWith("$chord.")))
      throw new Error("插件不能导出宿主服务");
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
  if (value.signature !== undefined) text(value.signature, "目录签名", 512);
  const ids = new Set<string>();
  for (const manifest of value.plugins) {
    assertManifest(manifest);
    const id = manifest.id.toLowerCase();
    if (ids.has(id)) throw new Error("插件目录包含重复 id（Windows 忽略大小写）");
    ids.add(id);
  }
}
