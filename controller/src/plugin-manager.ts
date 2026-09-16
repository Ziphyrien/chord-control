import type {
  ActivityTone,
  ControllerSettings,
  PluginCatalog,
  PluginSummary,
  PluginManifest,
  Json,
} from "../../shared/protocol.ts";
import {
  assertCatalog,
  assertManifest,
  assertUrl,
  compareVersion,
} from "../../shared/plugin-format.ts";
import { normalizePublicKey, verifySigned } from "../../shared/signing.ts";
import { settingsFrom, type ConfigRepository, type Registration } from "./config.ts";
import { ALLOW_UNSIGNED, verifyManifest } from "./policy.ts";
import { download, fetchJson } from "./sources.ts";
import type { PluginLifecycle } from "./ports.ts";
import type { ArchiveStore } from "./storage.ts";

type Log = (title: string, detail: string, tone?: ActivityTone) => void;
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
function hasUpdate(plugin: Registration): boolean {
  return Boolean(
    plugin.latest &&
    (!plugin.installed ||
      (compareVersion(plugin.latest.version, plugin.installed.version) >= 0 &&
        plugin.latest.artifactSha256 !== plugin.installed.artifactSha256)),
  );
}

/** Owns plugin registration and update transactions; knows neither Tauri nor stdio. */
export class PluginManager {
  checkedAt: string | null = null;
  constructor(
    private readonly repository: ConfigRepository,
    private readonly archives: Pick<ArchiveStore, "read" | "write" | "validate">,
    private readonly runtime: PluginLifecycle,
    private readonly log: Log,
  ) {}
  private get config() {
    return this.repository.value;
  }
  get settings(): ControllerSettings {
    return this.config.settings;
  }
  summaries(): PluginSummary[] {
    return this.config.plugins.map((plugin) => {
      const manifest = plugin.installed ?? plugin.latest;
      const running = this.runtime.has(plugin.id);
      return {
        id: plugin.id,
        name: manifest?.name ?? plugin.id,
        description: manifest?.description ?? "",
        version: manifest?.version ?? "—",
        latestVersion: plugin.latest?.version,
        revision: plugin.installed?.artifactSha256,
        status: plugin.error
          ? "error"
          : !plugin.enabled
            ? "paused"
            : hasUpdate(plugin)
              ? "update"
              : running
                ? "active"
                : "idle",
        running,
        installed: Boolean(plugin.installed),
        enabled: plugin.enabled,
        hasUpdate: hasUpdate(plugin),
        hasUi: Boolean(plugin.installed?.ui && running),
        source: plugin.catalog ? this.settings.catalogUrl : (plugin.manifestUrl ?? ""),
        permissions: manifest?.permissions ?? [],
        updatedAt: plugin.updatedAt ?? "",
        icon: manifest?.icon ?? "◈",
        color: manifest?.color ?? "green",
        error: plugin.error,
      };
    });
  }
  async restoreAll(): Promise<void> {
    for (const plugin of this.config.plugins) {
      try {
        await this.restore(plugin);
      } catch (error) {
        plugin.error = message(error);
        this.log("插件启动失败", `${plugin.id}: ${plugin.error}`, "error");
      }
    }
  }
  async authorize(action: string, input: Json): Promise<() => void> {
    const policies = () =>
      this.config.plugins.filter(
        (plugin) => plugin.enabled && plugin.installed?.hooks?.includes(action),
      );
    const fingerprint = () =>
      JSON.stringify(policies().map((plugin) => [plugin.id, plugin.installed!.artifactSha256]));
    const version = fingerprint();
    for (const plugin of policies())
      if (!(await this.runtime.before(plugin.id, action, input))) throw new Error("操作未获允许");
    return () => {
      if (version !== fingerprint()) throw new Error("插件状态已变化，请重试");
    };
  }
  private find(id: string): Registration {
    const plugin = this.config.plugins.find((item) => item.id === id);
    if (!plugin) throw new Error("找不到插件");
    return plugin;
  }
  private async restore(plugin: Registration): Promise<void> {
    if (!plugin.enabled || !plugin.installed) return;
    verifyManifest(plugin.installed, plugin.publicKey);
    if (plugin.installed.id !== plugin.id) throw new Error("本地插件身份与配置不一致");
    await this.runtime.activate(plugin.installed, await this.archives.read(plugin.installed));
  }
  private async installRegistration(plugin: Registration): Promise<void> {
    const manifest = plugin.latest;
    if (!manifest) throw new Error("插件没有可安装版本");
    verifyManifest(manifest, plugin.publicKey);
    if (manifest.id !== plugin.id) throw new Error("插件身份与来源不一致");
    if (plugin.installed && compareVersion(manifest.version, plugin.installed.version) < 0)
      throw new Error("拒绝插件降级");
    const bytes = await download(manifest);
    if (!plugin.enabled) await this.archives.validate(manifest, bytes);
    await this.archives.write(manifest, bytes);
    const previous = plugin.installed,
      previousTime = plugin.updatedAt;
    if (plugin.enabled) await this.runtime.activate(manifest, bytes);
    plugin.installed = manifest;
    plugin.updatedAt = new Date().toISOString();
    plugin.error = undefined;
    try {
      await this.repository.save();
    } catch (error) {
      plugin.installed = previous;
      plugin.updatedAt = previousTime;
      if (previous) await this.restore(plugin);
      else await this.runtime.deactivate(plugin.id);
      throw error;
    }
    this.log("插件已更新", `${manifest.name} ${manifest.version}`, "success");
  }
  async install(id: string): Promise<void> {
    const plugin = this.find(id);
    try {
      await this.installRegistration(plugin);
    } catch (error) {
      plugin.error = message(error);
      throw error;
    }
  }
  private fetchManifest(
    url: string,
    key: string,
    etag?: string,
    cached?: PluginManifest,
    id?: string,
    installed?: PluginManifest,
  ) {
    return fetchJson(url, {
      etag,
      cached,
      validate(value) {
        assertManifest(value);
        verifyManifest(value, key, false);
        if (id && value.id !== id) throw new Error("插件身份与来源不一致");
        if (installed && compareVersion(value.version, installed.version) < 0)
          throw new Error("远端版本低于本地版本");
        return value;
      },
    });
  }
  private async fetchCatalog(
    settings: ControllerSettings,
    etag?: string,
  ): Promise<{ catalog: PluginCatalog; etag?: string }> {
    const cached =
      settings.catalogUrl === this.settings.catalogUrl &&
      settings.catalogPublicKey === this.settings.catalogPublicKey
        ? this.config.catalogCache
        : undefined;
    const fetched = await fetchJson(settings.catalogUrl, {
      etag,
      cached,
      validate(value) {
        assertCatalog(value);
        verifySigned(value, settings.catalogPublicKey, ALLOW_UNSIGNED);
        for (const manifest of value.plugins)
          verifyManifest(manifest, settings.catalogPublicKey, false);
        if (
          cached?.generatedAt &&
          (!value.generatedAt || Date.parse(value.generatedAt) < Date.parse(cached.generatedAt))
        )
          throw new Error("来源返回了较旧的插件目录");
        return value;
      },
    });
    return { catalog: fetched.value, etag: fetched.etag };
  }
  private async syncCatalog(): Promise<void> {
    if (!this.settings.catalogUrl) return;
    const { catalog, etag } = await this.fetchCatalog(this.settings, this.config.catalogEtag);
    const ids = new Set(catalog.plugins.map((plugin) => plugin.id));
    for (const plugin of this.config.plugins) {
      if (plugin.catalog && !ids.has(plugin.id)) {
        await this.runtime.deactivate(plugin.id);
        this.config.plugins = this.config.plugins.filter((item) => item !== plugin);
        this.log("目录已移除插件", plugin.id);
      }
    }
    for (const manifest of catalog.plugins) {
      if (this.config.ignoredCatalogIds.includes(manifest.id)) continue;
      const existing = this.config.plugins.find(
        (plugin) => plugin.id.toLowerCase() === manifest.id.toLowerCase(),
      );
      if (existing && (!existing.catalog || existing.id !== manifest.id)) continue;
      if (existing) {
        existing.latest = manifest;
        existing.publicKey = this.settings.catalogPublicKey;
      } else
        this.config.plugins.push({
          id: manifest.id,
          catalog: true,
          publicKey: this.settings.catalogPublicKey,
          enabled: true,
          latest: manifest,
        });
    }
    this.config.catalogCache = catalog;
    this.config.catalogEtag = etag;
  }
  async checkUpdates(): Promise<{ failures: number }> {
    let failures = 0;
    try {
      await this.syncCatalog();
    } catch (error) {
      failures++;
      this.log("目录同步失败", message(error), "error");
    }
    for (const plugin of this.config.plugins) {
      try {
        if (plugin.manifestUrl) {
          const fetched = await this.fetchManifest(
            plugin.manifestUrl,
            plugin.publicKey,
            plugin.etag,
            plugin.latest,
            plugin.id,
            plugin.installed,
          );
          const manifest = fetched.value;
          plugin.latest = manifest;
          plugin.etag = fetched.etag;
        }
        if (
          plugin.latest &&
          plugin.installed &&
          compareVersion(plugin.latest.version, plugin.installed.version) < 0
        )
          throw new Error("远端版本低于本地版本");
        if (plugin.enabled && this.settings.autoUpdate && hasUpdate(plugin))
          await this.installRegistration(plugin);
        else if (plugin.enabled && plugin.installed && !this.runtime.has(plugin.id))
          await this.restore(plugin);
        plugin.error = undefined;
      } catch (error) {
        plugin.error = message(error);
        failures++;
        this.log("插件同步失败", `${plugin.id}: ${plugin.error}`, "error");
      }
    }
    this.checkedAt = new Date().toISOString();
    this.log(
      "检查完成",
      `${this.config.plugins.length} 个插件，${failures} 项失败`,
      failures ? "warning" : "success",
    );
    await this.repository.save();
    return { failures };
  }
  async updateSettings(value: ControllerSettings): Promise<void> {
    const settings = settingsFrom(value);
    if (settings.catalogUrl) await this.fetchCatalog(settings);
    if (
      settings.catalogUrl !== this.settings.catalogUrl ||
      settings.catalogPublicKey !== this.settings.catalogPublicKey
    ) {
      for (const plugin of this.config.plugins.filter((item) => item.catalog))
        await this.runtime.deactivate(plugin.id);
      this.config.plugins = this.config.plugins.filter((plugin) => !plugin.catalog);
      this.config.catalogCache = undefined;
      this.config.catalogEtag = undefined;
      this.config.ignoredCatalogIds = [];
    }
    this.config.settings = settings;
    await this.repository.save();
  }
  async add(manifestUrl: string, publicKey: string): Promise<void> {
    assertUrl(manifestUrl);
    const key = publicKey.trim() ? normalizePublicKey(publicKey) : "";
    const fetched = await this.fetchManifest(manifestUrl, key);
    const manifest = fetched.value;
    if (this.config.plugins.some((plugin) => plugin.id.toLowerCase() === manifest.id.toLowerCase()))
      throw new Error("插件已存在");
    const plugin: Registration = {
      id: manifest.id,
      manifestUrl,
      publicKey: key,
      latest: manifest,
      etag: fetched.etag,
      enabled: true,
    };
    this.config.plugins.push(plugin);
    await this.repository.save();
    try {
      await this.installRegistration(plugin);
    } catch (error) {
      plugin.error = message(error);
      await this.repository.save();
      throw error;
    }
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const plugin = this.find(id);
    if (typeof enabled !== "boolean") throw new Error("启用状态格式错误");
    if (!enabled) await this.runtime.deactivate(id);
    plugin.enabled = enabled;
    try {
      if (enabled) {
        if (hasUpdate(plugin)) await this.installRegistration(plugin);
        else await this.restore(plugin);
      }
      plugin.error = undefined;
    } catch (error) {
      plugin.error = message(error);
      await this.repository.save();
      throw error;
    }
    await this.repository.save();
    this.log(enabled ? "插件已启动" : "插件已暂停", plugin.id);
  }
  async remove(id: string): Promise<void> {
    const plugin = this.find(id);
    await this.runtime.deactivate(id);
    this.config.plugins = this.config.plugins.filter((item) => item !== plugin);
    if (plugin.catalog) this.config.ignoredCatalogIds.push(id);
    await this.repository.save();
    this.log("插件已移除", id);
  }
}
