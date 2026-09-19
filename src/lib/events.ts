import type {
  ActivityItem,
  ControllerEvent,
  ControllerSnapshot,
  PluginSummary,
} from "../../shared/protocol.ts";
import { parseSettings } from "../../shared/commands.ts";
import { jsonValue, object, text } from "../../shared/validation.ts";

function record(value: unknown): Record<string, unknown> {
  if (!object(value)) throw new Error("事件对象无效");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("事件状态无效");
  return value;
}
function string(value: unknown): string {
  return text(value, "事件文本", 1_000_000, true);
}
function optional(value: unknown): string | undefined {
  return value === undefined ? undefined : string(value);
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  for (const option of choices) if (value === option) return option;
  throw new Error("事件类型无效");
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 100_000) throw new Error("事件列表无效");
  return value.map(parse);
}
function unique<T extends { id: string }>(items: T[]): T[] {
  if (items.some((item) => !item.id) || new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error("事件标识重复或为空");
  return items;
}
function plugin(value: unknown): PluginSummary {
  const item = record(value);
  const dependents =
    item.dependents === undefined
      ? undefined
      : unique(
          list(item.dependents, (value) => {
            const dependent = record(value);
            return { id: string(dependent.id), name: string(dependent.name) };
          }),
        );
  if (dependents?.some((dependent) => dependent.id === item.id))
    throw new Error("受影响插件包含自身");
  return {
    id: string(item.id),
    name: string(item.name),
    description: string(item.description),
    version: string(item.version),
    latestVersion: optional(item.latestVersion),
    revision: optional(item.revision),
    status: choice(item.status, [
      "active",
      "update",
      "paused",
      "blocked",
      "error",
      "idle",
      "ignored",
    ]),
    running: boolean(item.running),
    installed: boolean(item.installed),
    enabled: boolean(item.enabled),
    hasUpdate: boolean(item.hasUpdate),
    hasUi: boolean(item.hasUi),
    source: string(item.source),
    sourceStatus: choice(item.sourceStatus, ["available", "missing", "detached"] as const),
    blockedReason: optional(item.blockedReason),
    dependents,
    permissions: list(item.permissions, string),
    updatedAt: string(item.updatedAt),
    icon: string(item.icon),
    color: string(item.color),
    error: optional(item.error),
  };
}
function activity(value: unknown): ActivityItem {
  const item = record(value);
  return {
    id: string(item.id),
    title: string(item.title),
    detail: string(item.detail),
    time: string(item.time),
    tone: choice(item.tone, ["success", "info", "warning", "error"]),
  };
}
function snapshot(value: unknown): ControllerSnapshot {
  const item = record(value);
  return {
    plugins: unique(list(item.plugins, plugin)),
    activities: unique(list(item.activities, activity)),
    checkedAt: item.checkedAt === null ? null : string(item.checkedAt),
    startedAt: string(item.startedAt),
    controllerVersion: string(item.controllerVersion),
    settings: parseSettings(item.settings),
    dataDir: string(item.dataDir),
  };
}

/** Never assert parsed JSON as a wire event: validate every field rendered by the application. */
export function decodeControllerEvent(payload: string): ControllerEvent {
  const item = record(JSON.parse(payload));
  switch (item.type) {
    case "snapshot":
      return { type: "snapshot", snapshot: snapshot(item.snapshot) };
    case "response": {
      const id = text(item.id, "响应标识", 200);
      if (item.ok === false)
        return { type: "response", id, ok: false, message: string(item.message) };
      if (item.ok === true && jsonValue(item.result))
        return { type: "response", id, ok: true, result: item.result };
      throw new Error("响应格式无效");
    }
    case "disconnected":
    case "error":
      return { type: item.type, message: string(item.message) };
    case "plugin_window":
      return {
        type: "plugin_window",
        pluginId: string(item.pluginId),
        title: string(item.title),
        visible: boolean(item.visible),
        url: optional(item.url),
      };
    default:
      throw new Error("未知事件");
  }
}
