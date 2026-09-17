import type { ControllerSettings, Json, PluginManifest } from "../../../shared/protocol.ts";
import { assertUrl, compareVersion } from "../../../shared/plugin-format.ts";
import { normalizePublicKey } from "../../../shared/signing.ts";
import { message } from "../../../shared/validation.ts";
import {
  catalogSource,
  sourceKey,
  settingsFrom,
  type Configuration,
  type Registration,
  type PluginSource,
} from "../domain/configuration.ts";
import {
  confirmAffected,
  describePlugins,
  installedGraph,
  reconcileCatalog,
} from "../domain/reconciliation.ts";
import { hasUpdate, verifyRelease } from "../domain/releases.ts";
import type {
  Archives,
  ConfigRepository,
  ReleaseSource,
  PluginRuntime,
  Enqueue,
  Activity,
} from "../domain/ports.ts";
import { PluginLifecycle } from "./plugin-lifecycle.ts";
import { serialQueue } from "./execution.ts";
import { dependencyGraph } from "../../../shared/dependencies.ts";

interface Dependencies {
  repository: ConfigRepository;
  archives: Archives;
  source: ReleaseSource;
  runtime: PluginRuntime;
  gate: Enqueue;
  log: Activity;
  allowUnsigned: boolean;
}
export class PluginService {
  checkedAt: string | null = null;
  readonly lifecycle: PluginLifecycle;
  private readonly dependencies: Dependencies;
  private readonly operations = serialQueue();
  private stopping = false;
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    this.lifecycle = new PluginLifecycle(dependencies);
  }
  get settings(): ControllerSettings {
    return this.dependencies.repository.snapshot().settings;
  }
  summaries() {
    return describePlugins(
      this.dependencies.repository.snapshot(),
      (id) => this.dependencies.runtime.has(id),
      this.lifecycle.errors,
    );
  }
  restore(): Promise<void> {
    return this.lifecycle.restore();
  }
  private registration(config: Configuration, id: string): Registration {
    const found = config.plugins.find((item) => item.id === id);
    if (!found) throw new Error("找不到插件");
    return found;
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    return this.operations(async () => {
      if (this.stopping) throw new Error("控制器正在关闭");
      return operation();
    });
  }
  async authorize(action: string, input: Json): Promise<() => void> {
    const policies = () =>
      this.dependencies.repository
        .snapshot()
        .plugins.filter((item) => item.enabled && item.installed?.hooks?.includes(action));
    const fingerprint = () =>
      JSON.stringify(policies().map((item) => [item.id, item.installed!.artifactSha256]));
    const before = fingerprint();
    for (const item of policies())
      if (!(await this.dependencies.runtime.before(item.id, action, input)))
        throw new Error("操作未获允许");
    return () => {
      if (before !== fingerprint()) throw new Error("验证期间插件状态已变化，请重试");
    };
  }
  private updateGroups(
    before: Configuration,
    next: Configuration,
    ids: readonly string[],
  ): string[][] {
    const links = new Map<string, Set<string>>();
    for (const config of [before, next]) {
      const graph = dependencyGraph(
        config.plugins.filter((item) => item.installed).map((item) => item.installed!),
      );
      for (const [id, parents] of graph.dependencies)
        for (const parent of parents) {
          if (!links.has(id)) links.set(id, new Set());
          if (!links.has(parent)) links.set(parent, new Set());
          links.get(id)!.add(parent);
          links.get(parent)!.add(id);
        }
    }
    const remaining = new Set(ids),
      groups: string[][] = [];
    while (remaining.size) {
      const seed = remaining.values().next().value!,
        visited = new Set<string>();
      const visit = (id: string): void => {
        if (visited.has(id)) return;
        visited.add(id);
        for (const neighbor of links.get(id) ?? []) visit(neighbor);
      };
      visit(seed);
      const group = [...remaining].filter((id) => visited.has(id));
      for (const id of group) remaining.delete(id);
      groups.push(group);
    }
    return groups;
  }
  private async prepare(plugin: Registration): Promise<PluginManifest> {
    const release = plugin.available;
    if (!release || plugin.sourceStatus !== "available")
      throw new Error("插件来源已下架或分离，无法安装");
    verifyRelease(release, plugin.source.publicKey, this.dependencies.allowUnsigned);
    if (release.id !== plugin.id) throw new Error("插件身份与来源不一致");
    if (plugin.installed && compareVersion(release.version, plugin.installed.version) < 0)
      throw new Error("拒绝插件降级");
    const bytes = await this.dependencies.source.archive(release);
    await this.dependencies.archives.validate(release, bytes);
    await this.dependencies.archives.write(release, bytes);
    return release;
  }
  checkUpdates(validate: () => void = () => {}): Promise<{ failures: number }> {
    return this.run(async () => {
      validate();
      let failures = 0;
      const { repository, source, log } = this.dependencies;
      let config = repository.snapshot();
      if (config.settings.catalogUrl) {
        try {
          const result = await source.catalog(
            catalogSource(config.settings),
            config.catalogEtag,
            config.catalogCache,
          );
          config = reconcileCatalog(config, result.value, result.etag);
        } catch (error) {
          failures++;
          log("目录同步失败", message(error), "error");
        }
      }
      for (const plugin of config.plugins)
        if (plugin.source.kind === "manifest" && plugin.source.url) {
          try {
            const result = await source.manifest(plugin.source, plugin.etag, plugin.available);
            if (result.value.id !== plugin.id) throw new Error("插件身份与来源不一致");
            plugin.available = result.value;
            plugin.etag = result.etag;
            plugin.sourceStatus = "available";
            this.lifecycle.errors.delete(plugin.id);
          } catch (error) {
            failures++;
            this.lifecycle.errors.set(plugin.id, message(error));
            log("插件来源同步失败", `${plugin.id}: ${message(error)}`, "error");
          }
        }
      if (this.stopping) throw new Error("控制器正在关闭");
      validate();
      await repository.commit(config);
      const next = structuredClone(config),
        prepared: string[] = [];
      for (const plugin of next.plugins)
        if (plugin.enabled && next.settings.autoUpdate && hasUpdate(plugin)) {
          try {
            plugin.installed = await this.prepare(plugin);
            plugin.updatedAt = new Date().toISOString();
            prepared.push(plugin.id);
          } catch (error) {
            failures++;
            this.lifecycle.errors.set(plugin.id, message(error));
            log("插件准备失败", `${plugin.id}: ${message(error)}`, "error");
          }
        }
      if (!this.stopping) {
        // Unrelated plugin families must not fail together. Related candidates cut over together.
        for (const group of this.updateGroups(config, next, prepared)) {
          const transaction = repository.snapshot();
          for (const id of group) {
            const updated = this.registration(next, id),
              current = this.registration(transaction, id);
            current.installed = updated.installed;
            current.updatedAt = updated.updatedAt;
          }
          try {
            await this.lifecycle.commit(transaction, group, validate);
            for (const id of group) this.lifecycle.errors.delete(id);
          } catch (error) {
            failures++;
            for (const id of group) this.lifecycle.errors.set(id, message(error));
            log("插件更新已回退", message(error), "error");
          }
          if (this.stopping) break;
        }
        if (!prepared.length) await this.lifecycle.restore();
      }
      this.checkedAt = new Date().toISOString();
      log(
        "检查完成",
        `${next.plugins.length} 个插件，${failures} 项失败`,
        failures ? "warning" : "success",
      );
      return { failures };
    });
  }
  install(id: string, validate: () => void = () => {}): Promise<void> {
    return this.run(async () => {
      validate();
      const next = this.dependencies.repository.snapshot(),
        plugin = this.registration(next, id);
      try {
        plugin.installed = await this.prepare(plugin);
        plugin.updatedAt = new Date().toISOString();
        await this.lifecycle.commit(next, plugin.enabled ? [id] : [], validate);
        this.lifecycle.errors.delete(id);
        this.dependencies.log(
          "插件已安装",
          `${plugin.installed.name} ${plugin.installed.version}`,
          "success",
        );
      } catch (error) {
        this.lifecycle.errors.set(id, message(error));
        throw error;
      }
    });
  }
  add(url: string, key: string, validate: () => void = () => {}): Promise<void> {
    return this.run(async () => {
      validate();
      assertUrl(url);
      const source: PluginSource = {
        kind: "manifest",
        url,
        publicKey: key.trim() ? normalizePublicKey(key) : "",
      };
      const { value, etag } = await this.dependencies.source.manifest(source);
      const next = this.dependencies.repository.snapshot();
      if (next.plugins.some((item) => item.id.toLowerCase() === value.id.toLowerCase()))
        throw new Error("插件已存在");
      if (next.plugins.length >= 100) throw new Error("本地插件数量超过 100 项");
      const plugin: Registration = {
        id: value.id,
        source,
        available: value,
        etag,
        enabled: true,
        sourceStatus: "available",
      };
      plugin.installed = await this.prepare(plugin);
      plugin.updatedAt = new Date().toISOString();
      next.plugins.push(plugin);
      next.suppressed = next.suppressed.filter(
        (item) => item.id !== plugin.id || sourceKey(item.source) !== sourceKey(source),
      );
      await this.lifecycle.commit(next, [plugin.id], validate);
      this.dependencies.log("插件已添加", value.name, "success");
    });
  }
  setEnabled(
    id: string,
    enabled: boolean,
    approved: readonly string[] = [],
    validate: () => void = () => {},
  ): Promise<void> {
    return this.run(async () => {
      validate();
      const next = this.dependencies.repository.snapshot(),
        plugin = this.registration(next, id);
      if (!enabled) for (const item of confirmAffected(next, id, approved)) item.enabled = false;
      plugin.enabled = enabled;
      if (enabled && !plugin.installed) {
        plugin.installed = await this.prepare(plugin);
        plugin.updatedAt = new Date().toISOString();
      }
      if (enabled) {
        const graph = installedGraph(next, true);
        if (graph.blocked.has(id)) throw new Error(graph.blocked.get(id));
      }
      await this.lifecycle.commit(next, enabled ? [id] : [], validate);
      this.lifecycle.errors.delete(id);
      this.dependencies.log(enabled ? "插件已启动" : "插件已暂停", plugin.installed?.name ?? id);
    });
  }
  remove(
    id: string,
    approved: readonly string[] = [],
    validate: () => void = () => {},
  ): Promise<void> {
    return this.run(async () => {
      validate();
      const next = this.dependencies.repository.snapshot(),
        plugin = this.registration(next, id);
      for (const item of confirmAffected(next, id, approved)) item.enabled = false;
      next.plugins = next.plugins.filter((item) => item.id !== id);
      if (
        !next.suppressed.some(
          (item) => item.id === id && sourceKey(item.source) === sourceKey(plugin.source),
        )
      )
        next.suppressed.push({ id, source: plugin.source });
      await this.lifecycle.commit(next, [], validate);
      this.lifecycle.errors.delete(id);
      this.dependencies.log("插件已移除", `${plugin.installed?.name ?? id}；保留插件数据`);
    });
  }
  updateSettings(value: ControllerSettings, validate: () => void = () => {}): Promise<void> {
    return this.run(async () => {
      validate();
      const next = this.dependencies.repository.snapshot();
      const settings = settingsFrom(value, this.dependencies.allowUnsigned);
      const changed =
        sourceKey(catalogSource(settings)) !== sourceKey(catalogSource(next.settings));
      if (changed && settings.catalogUrl)
        await this.dependencies.source.catalog(catalogSource(settings));
      next.settings = settings;
      if (changed) {
        next.catalogCache = undefined;
        next.catalogEtag = undefined;
        for (const plugin of next.plugins)
          if (plugin.source.kind === "catalog")
            plugin.sourceStatus =
              sourceKey(plugin.source) === sourceKey(catalogSource(settings))
                ? "available"
                : "detached";
      }
      validate();
      await this.dependencies.repository.commit(next);
    });
  }
  async close(): Promise<void> {
    this.stopping = true;
    this.dependencies.source.close();
    await this.operations(() => this.lifecycle.shutdown());
  }
}
