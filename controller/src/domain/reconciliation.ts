import { dependencyGraph, dependentClosure } from "../../../shared/dependencies.ts";
import type { PluginCatalog, PluginManifest, PluginSummary } from "../../../shared/protocol.ts";
import type { Configuration, Registration } from "./configuration.ts";
import { catalogSource, sourceKey } from "./configuration.ts";
import { completed, hasUpdate } from "./releases.ts";

export function installedGraph(config: Configuration, enabledOnly = false) {
  return dependencyGraph(
    config.plugins
      .filter((item) => item.installed && (!enabledOnly || item.enabled))
      .map((item) => item.installed!),
  );
}
function affectedPlugins(config: Configuration, id: string): Registration[] {
  const ids = new Set(dependentClosure(installedGraph(config), id));
  return config.plugins
    .filter((item) => item.enabled && ids.has(item.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}
export function confirmAffected(
  config: Configuration,
  id: string,
  approved: readonly string[] = [],
): Registration[] {
  const affected = affectedPlugins(config, id),
    actual = affected.map((item) => item.id).sort(),
    expected = [...approved].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `依赖关系已变化，请确认将停用: ${affected.map((item) => item.installed?.name ?? item.id).join("、") || "无"}`,
    );
  return affected;
}
/** Discovery only updates metadata; absence from a catalogue never means local deletion. */
export function reconcileCatalog(
  config: Configuration,
  catalog: PluginCatalog,
  etag?: string,
): Configuration {
  const next = structuredClone(config),
    source = catalogSource(next.settings),
    key = sourceKey(source);
  const releases = new Map(catalog.plugins.map((item) => [item.id, item]));
  for (const item of next.plugins) {
    if (item.source.kind !== "catalog") continue;
    if (sourceKey(item.source) !== key) {
      item.sourceStatus = "detached";
      continue;
    }
    item.available = releases.get(item.id);
    item.sourceStatus = item.available ? "available" : "missing";
  }
  for (const manifest of catalog.plugins) {
    if (completed(manifest)) continue;
    if (next.plugins.some((item) => item.id.toLowerCase() === manifest.id.toLowerCase())) continue;
    if (
      next.suppressed.some(
        (item) =>
          item.id.toLowerCase() === manifest.id.toLowerCase() && sourceKey(item.source) === key,
      )
    )
      continue;
    if (next.plugins.length >= 100) throw new Error("本地插件数量超过 100 项");
    next.plugins.push({
      id: manifest.id,
      source: { ...source },
      enabled: true,
      available: manifest,
      sourceStatus: "available",
    });
  }
  next.catalogCache = catalog;
  next.catalogEtag = etag;
  return next;
}
export function describePlugins(
  config: Configuration,
  running: (id: string) => boolean,
  errors: ReadonlyMap<string, string>,
): PluginSummary[] {
  const graph = dependencyGraph(
    config.plugins
      .filter((item) => item.enabled && (item.installed || item.available))
      .map((item) => (item.installed ?? item.available)!),
  );
  const installedIds = new Set(
    config.plugins.filter((item) => item.enabled && item.installed).map((item) => item.id),
  );
  return config.plugins.map((item) => {
    const manifest: PluginManifest | undefined = item.installed ?? item.available;
    const active = running(item.id),
      update = hasUpdate(item);
    const unavailable = (graph.dependencies.get(item.id) ?? []).find(
      (id) => !installedIds.has(id) || !running(id),
    );
    const blockedReason =
      item.enabled && !active
        ? (graph.blocked.get(item.id) ?? (unavailable ? `依赖未运行: ${unavailable}` : undefined))
        : undefined;
    const error = errors.get(item.id);
    return {
      id: item.id,
      name: manifest?.name ?? item.id,
      description: manifest?.description ?? "",
      version: item.installed?.version ?? "—",
      latestVersion: item.available?.version,
      revision: item.installed?.artifactSha256,
      status: !item.enabled
        ? "paused"
        : error
          ? "error"
          : blockedReason
            ? "blocked"
            : update
              ? "update"
              : active
                ? "active"
                : "idle",
      running: active,
      installed: Boolean(item.installed),
      enabled: item.enabled,
      hasUpdate: update,
      hasUi: Boolean(active && item.installed?.ui),
      source: item.source.url,
      sourceStatus: item.sourceStatus,
      blockedReason,
      dependents: affectedPlugins(config, item.id).map((dependent) => ({
        id: dependent.id,
        name: dependent.installed?.name ?? dependent.id,
      })),
      permissions: manifest?.permissions ?? [],
      updatedAt: item.updatedAt ?? "",
      icon: manifest?.icon ?? "◈",
      color: manifest?.color ?? "green",
      error,
    };
  });
}
