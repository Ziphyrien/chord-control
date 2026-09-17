import { defaultSettings, type ControllerCommand, type ControllerSettings } from "./protocol.ts";
import { jsonValue, object, strings, text } from "./validation.ts";

export function parseSettings(value: unknown): ControllerSettings {
  const defaults = defaultSettings();
  const appInterval =
    object(value) && value.appCheckIntervalMinutes !== undefined
      ? value.appCheckIntervalMinutes
      : defaults.appCheckIntervalMinutes;
  const appAutoUpdate =
    object(value) && value.appAutoUpdate !== undefined
      ? value.appAutoUpdate
      : defaults.appAutoUpdate;
  if (
    !object(value) ||
    typeof value.autoUpdate !== "boolean" ||
    !Number.isInteger(value.checkIntervalMinutes) ||
    Number(value.checkIntervalMinutes) < 1 ||
    Number(value.checkIntervalMinutes) > 1440 ||
    !Number.isInteger(appInterval) ||
    Number(appInterval) < 1 ||
    Number(appInterval) > 1440 ||
    typeof appAutoUpdate !== "boolean"
  )
    throw new Error("检查间隔必须为 1–1440 分钟，自动更新必须为布尔值");
  return {
    checkIntervalMinutes: Number(value.checkIntervalMinutes),
    autoUpdate: value.autoUpdate,
    appCheckIntervalMinutes: Number(appInterval),
    appAutoUpdate,
    catalogUrl: text(value.catalogUrl, "目录地址", 4096, true).trim(),
    catalogPublicKey: text(value.catalogPublicKey, "发布者公钥", 4096, true).trim(),
  };
}
/** Convert untrusted transport data into a fresh command; unknown fields do not cross the boundary. */
export function parseCommand(value: unknown): ControllerCommand {
  if (!object(value)) throw new Error("命令必须是对象");
  const kind = text(value.type, "命令类型", 64);
  if (kind === "snapshot" || kind === "check_updates") return { type: kind };
  if (kind === "set_settings") return { type: kind, settings: parseSettings(value.settings) };
  if (kind === "add_plugin")
    return {
      type: kind,
      manifestUrl: text(value.manifestUrl, "插件地址"),
      publicKey: text(value.publicKey, "发布者公钥", 4096, true),
    };
  if (kind === "desktop_action") {
    if (value.action !== "open" && value.action !== "quit") throw new Error("未知桌面操作");
    return { type: kind, action: value.action };
  }
  const pluginId = text(value.pluginId, "插件标识", 100);
  if (kind === "install" || kind === "plugin_ui" || kind === "plugin_window_closed")
    return { type: kind, pluginId };
  if (kind === "remove_plugin" || kind === "set_enabled") {
    const affectedPluginIds =
      value.affectedPluginIds === undefined
        ? undefined
        : strings(value.affectedPluginIds, "受影响插件");
    if (kind === "remove_plugin") return { type: kind, pluginId, affectedPluginIds };
    if (typeof value.enabled !== "boolean") throw new Error("启用状态必须为布尔值");
    return { type: kind, pluginId, enabled: value.enabled, affectedPluginIds };
  }
  if (kind === "plugin_call" && jsonValue(value.input))
    return {
      type: kind,
      pluginId,
      method: text(value.method, "插件方法", 100),
      input: value.input,
    };
  throw new Error("未知命令或插件参数格式错误");
}
