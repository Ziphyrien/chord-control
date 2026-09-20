import type { Json } from "../../../shared/protocol.ts";
const PROTECTED = new Set([
  "com.chord.password-pad",
  "com.chord.app-guard",
  "com.chord.study-guard",
]);
const TITLES = new Map([
  ["desktop.open", "打开控制中心"],
  ["desktop.quit", "退出 Chord Control"],
  ["set_settings", "修改设置"],
]);

/** Lifecycle topology stays in the controller; this hook only authorizes its proposed action. */
export function authorizationTitle(action: string, input: Json): string | undefined {
  const title = TITLES.get(action);
  if (title) return title;
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const affected = [
    input.pluginId,
    ...(Array.isArray(input.affectedPluginIds) ? input.affectedPluginIds : []),
  ];
  if (!affected.some((id) => typeof id === "string" && PROTECTED.has(id))) return;
  if (action === "remove_plugin") return "忽略保护插件";
  if (action === "set_enabled" && input.enabled === false) return "暂停保护插件";
}
