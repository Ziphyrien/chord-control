import type { ControllerSnapshot, Json } from "../../../shared/protocol.ts";

/** Explicit projection keeps publisher credentials, paths and plugin content out of telemetry. */
export function operationalSnapshot(snapshot: ControllerSnapshot): Json {
  return {
    version: snapshot.controllerVersion,
    startedAt: snapshot.startedAt,
    checkedAt: snapshot.checkedAt,
    settings: {
      checkIntervalMinutes: snapshot.settings.checkIntervalMinutes,
      autoUpdate: snapshot.settings.autoUpdate,
      appCheckIntervalMinutes: snapshot.settings.appCheckIntervalMinutes,
      appAutoUpdate: snapshot.settings.appAutoUpdate,
    },
    plugins: snapshot.plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      latestVersion: plugin.latestVersion ?? null,
      revision: plugin.revision ?? null,
      status: plugin.status,
      installed: plugin.installed,
      enabled: plugin.enabled,
      running: plugin.running,
      hasUpdate: plugin.hasUpdate,
      hasUi: plugin.hasUi,
      sourceStatus: plugin.sourceStatus,
      updatedAt: plugin.updatedAt,
      blockedReason: plugin.blockedReason?.slice(0, 1000) ?? null,
      error: plugin.error?.slice(0, 1000) ?? null,
    })),
    activities: snapshot.activities.slice(0, 20).map((item) => ({
      id: item.id,
      time: item.time,
      title: item.title,
      tone: item.tone,
      detail: item.detail.slice(0, 1000),
    })),
  };
}
