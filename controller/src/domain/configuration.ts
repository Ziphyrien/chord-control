import {
  defaultSettings,
  type ControllerSettings,
  type PluginManifest,
  type PluginCatalog,
  type SourceStatus,
} from "../../../shared/protocol.ts";
import {
  assertCatalog,
  assertId,
  assertManifest,
  assertUrl,
} from "../../../shared/plugin-format.ts";
import { parseSettings } from "../../../shared/commands.ts";
import { normalizePublicKey, verifySigned } from "../../../shared/signing.ts";
import { object, text } from "../../../shared/validation.ts";

export interface PluginSource {
  kind: "catalog" | "manifest";
  url: string;
  publicKey: string;
}
export interface Registration {
  id: string;
  source: PluginSource;
  enabled: boolean;
  installed?: PluginManifest;
  available?: PluginManifest;
  sourceStatus: SourceStatus;
  etag?: string;
  updatedAt?: string;
}
interface Suppression {
  id: string;
  source: PluginSource;
}
export interface Configuration {
  format: 3;
  settings: ControllerSettings;
  plugins: Registration[];
  suppressed: Suppression[];
  catalogCache?: PluginCatalog;
  catalogEtag?: string;
}
export function sourceKey(source: PluginSource): string {
  return JSON.stringify([source.kind, source.url, source.publicKey]);
}
export function catalogSource(settings: ControllerSettings): PluginSource {
  return { kind: "catalog", url: settings.catalogUrl, publicKey: settings.catalogPublicKey };
}
export function settingsFrom(value: unknown, allowUnsigned = false): ControllerSettings {
  const settings = parseSettings(value);
  if (settings.catalogUrl) assertUrl(settings.catalogUrl);
  if (settings.catalogUrl && !settings.catalogPublicKey && !allowUnsigned)
    throw new Error("请填写独立获取的发布者公钥");
  if (settings.catalogPublicKey)
    settings.catalogPublicKey = normalizePublicKey(settings.catalogPublicKey);
  return settings;
}
function readSource(value: unknown, allowUnsigned: boolean): PluginSource {
  if (!object(value) || (value.kind !== "catalog" && value.kind !== "manifest"))
    throw new Error("插件来源格式错误");
  const url = text(value.url, "来源地址", 4096, true);
  if (url) assertUrl(url);
  const rawKey = text(value.publicKey, "来源公钥", 4096, true).trim();
  if (!rawKey && !allowUnsigned) throw new Error("插件来源缺少公钥");
  return { kind: value.kind, url, publicKey: rawKey ? normalizePublicKey(rawKey) : "" };
}
export function emptyConfiguration(): Configuration {
  return { format: 3, settings: defaultSettings(), plugins: [], suppressed: [] };
}
/** Existing v0.1/0.2 config is migrated in memory and never replaced on parse failure. */
export function readConfiguration(input: unknown, allowUnsigned = false): Configuration {
  if (!object(input) || !Array.isArray(input.plugins) || input.plugins.length > 100)
    throw new Error("config.json 格式错误，请修复或备份后重新配置");
  if (input.format !== undefined && input.format !== 2 && input.format !== 3)
    throw new Error("不支持的配置版本");
  const settings = settingsFrom(
    input.settings ?? {
      ...defaultSettings(),
      checkIntervalMinutes: input.checkIntervalMinutes ?? defaultSettings().checkIntervalMinutes,
      autoUpdate: input.autoUpdate !== false,
    },
    allowUnsigned,
  );
  if (input.format !== 3 && settings.checkIntervalMinutes === 30)
    settings.checkIntervalMinutes = defaultSettings().checkIntervalMinutes;
  const current = catalogSource(settings);
  const plugins = input.plugins.map((value): Registration => {
    if (!object(value)) throw new Error("插件配置格式错误");
    const installed = value.installed,
      available = value.available ?? value.latest;
    if (installed !== undefined) assertManifest(installed);
    if (available !== undefined) assertManifest(available);
    const id =
      value.id ??
      (installed as PluginManifest | undefined)?.id ??
      (available as PluginManifest | undefined)?.id;
    assertId(id);
    if ((installed && installed.id !== id) || (available && available.id !== id))
      throw new Error("插件配置与发布身份不一致");
    if (value.enabled !== undefined && typeof value.enabled !== "boolean")
      throw new Error("插件启用状态无效");
    const source = readSource(
      value.source ?? {
        kind: value.catalog ? "catalog" : "manifest",
        url: value.catalog ? settings.catalogUrl : (value.manifestUrl ?? ""),
        publicKey: value.publicKey ?? settings.catalogPublicKey,
      },
      allowUnsigned,
    );
    const sourceStatus =
      source.kind === "catalog" && sourceKey(source) !== sourceKey(current)
        ? "detached"
        : value.sourceStatus === "missing"
          ? "missing"
          : "available";
    return {
      id,
      source,
      enabled: value.enabled !== false,
      installed,
      available,
      sourceStatus,
      etag: typeof value.etag === "string" ? value.etag : undefined,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
    };
  });
  if (new Set(plugins.map((item) => item.id.toLowerCase())).size !== plugins.length)
    throw new Error("插件配置包含重复 id");
  const rawSuppressed =
    input.suppressed ??
    (Array.isArray(input.ignoredCatalogIds)
      ? input.ignoredCatalogIds.map((id) => ({ id, source: current }))
      : []);
  if (!Array.isArray(rawSuppressed) || rawSuppressed.length > 10000)
    throw new Error("本地移除记录格式错误");
  const suppressed = rawSuppressed.map((item): Suppression => {
    if (!object(item)) throw new Error("本地移除记录格式错误");
    assertId(item.id);
    return { id: item.id, source: readSource(item.source, allowUnsigned) };
  });
  const result: Configuration = { format: 3, settings, plugins, suppressed };
  if (input.catalogCache !== undefined) {
    assertCatalog(input.catalogCache);
    verifySigned(input.catalogCache, settings.catalogPublicKey, allowUnsigned);
    result.catalogCache = input.catalogCache;
    if (typeof input.catalogEtag === "string") result.catalogEtag = input.catalogEtag;
  }
  return result;
}
