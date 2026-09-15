import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultSettings,
  type ControllerSettings,
  type PluginManifest,
  type PluginCatalog,
} from "../../shared/protocol.ts";
import {
  assertCatalog,
  assertId,
  assertManifest,
  assertUrl,
  object,
} from "../../shared/plugin-format.ts";
import { normalizePublicKey, verifySigned } from "../../shared/signing.ts";
import { ALLOW_UNSIGNED } from "./policy.ts";
import { atomicWrite } from "./storage.ts";

export type Registration = {
  id: string;
  manifestUrl?: string;
  catalog?: boolean;
  publicKey: string;
  enabled: boolean;
  installed?: PluginManifest;
  latest?: PluginManifest;
  etag?: string;
  updatedAt?: string;
  error?: string;
};
export type Config = {
  settings: ControllerSettings;
  plugins: Registration[];
  ignoredCatalogIds: string[];
  catalogCache?: PluginCatalog;
  catalogEtag?: string;
};
export interface ConfigRepository {
  value: Config;
  save(): Promise<void>;
}

export function settingsFrom(value: unknown): ControllerSettings {
  if (
    !object(value) ||
    typeof value.autoUpdate !== "boolean" ||
    typeof value.checkIntervalMinutes !== "number" ||
    !Number.isInteger(value.checkIntervalMinutes) ||
    value.checkIntervalMinutes < 1 ||
    value.checkIntervalMinutes > 1440
  )
    throw new Error("检查间隔必须为 1–1440 分钟");
  if (typeof value.catalogUrl !== "string" || typeof value.catalogPublicKey !== "string")
    throw new Error("插件目录设置格式错误");
  if (value.catalogUrl) assertUrl(value.catalogUrl);
  const key = value.catalogPublicKey.trim();
  if (value.catalogUrl && !key && !ALLOW_UNSIGNED) throw new Error("请填写独立获取的发布者公钥");
  return {
    checkIntervalMinutes: value.checkIntervalMinutes,
    autoUpdate: value.autoUpdate,
    catalogUrl: value.catalogUrl.trim(),
    catalogPublicKey: key ? normalizePublicKey(key) : "",
  };
}

export class ConfigStore implements ConfigRepository {
  value: Config = { settings: defaultSettings(), plugins: [], ignoredCatalogIds: [] };
  private readonly file: string;
  constructor(private readonly root: string) {
    this.file = join(root, "config.json");
  }
  async save(): Promise<void> {
    await atomicWrite(this.file, `${JSON.stringify(this.value, null, 2)}\n`);
  }
  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    try {
      const value: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!object(value) || !Array.isArray(value.plugins))
        throw new Error("config.json 格式错误，请修复或备份后重新配置");
      // Migrate the earlier scaffold without silently trusting keys supplied by the network.
      const settings = settingsFrom(
        value.settings ?? {
          ...defaultSettings(),
          checkIntervalMinutes: value.checkIntervalMinutes ?? 30,
          autoUpdate: value.autoUpdate !== false,
        },
      );
      const plugins: Registration[] = value.plugins.map((item: unknown) => {
        if (!object(item)) throw new Error("插件配置格式错误");
        if (item.installed) assertManifest(item.installed);
        if (item.latest) assertManifest(item.latest);
        const id =
          item.id ??
          (object(item.installed) ? item.installed.id : undefined) ??
          (object(item.latest) ? item.latest.id : undefined);
        assertId(id);
        if (item.manifestUrl) assertUrl(item.manifestUrl);
        return {
          ...item,
          id,
          publicKey: typeof item.publicKey === "string" ? item.publicKey : "",
          enabled: item.enabled !== false,
          error: undefined,
        } as Registration;
      });
      if (new Set(plugins.map((p) => p.id.toLowerCase())).size !== plugins.length)
        throw new Error("插件配置包含重复 id");
      this.value = {
        settings,
        plugins,
        ignoredCatalogIds: Array.isArray(value.ignoredCatalogIds)
          ? value.ignoredCatalogIds.filter((id): id is string => typeof id === "string")
          : [],
      };
      if (value.catalogCache) {
        assertCatalog(value.catalogCache);
        verifySigned(value.catalogCache, settings.catalogPublicKey, ALLOW_UNSIGNED);
        this.value.catalogCache = value.catalogCache;
        this.value.catalogEtag =
          typeof value.catalogEtag === "string" ? value.catalogEtag : undefined;
      }
    } catch (error) {
      if (!object(error) || error.code !== "ENOENT") throw error;
      await this.save();
    }
  }
}
