import { defaultCatalogPublicKey, defaultCatalogUrl } from "./distribution.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type PluginStatus = "active" | "update" | "paused" | "blocked" | "error" | "idle";
export type ActivityTone = "success" | "info" | "warning" | "error";
export type SourceStatus = "available" | "missing" | "detached";
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  artifactUrl: string;
  artifactSha256: string;
  signature?: string;
  description?: string;
  minHostVersion?: string;
  chordVersion?: string;
  entry?: string;
  ui?: string;
  permissions?: string[];
  services?: { provides: string[]; requires: string[] };
  hooks?: string[];
  icon?: string;
  color?: string;
}
export interface PluginCatalog {
  format: 1;
  generatedAt?: string;
  plugins: PluginManifest[];
  signature?: string;
}
export interface ControllerSettings {
  checkIntervalMinutes: number;
  autoUpdate: boolean;
  appCheckIntervalMinutes: number;
  appAutoUpdate: boolean;
  catalogUrl: string;
  catalogPublicKey: string;
}
export interface PluginSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  latestVersion?: string;
  revision?: string;
  status: PluginStatus;
  running: boolean;
  installed: boolean;
  enabled: boolean;
  hasUpdate: boolean;
  hasUi: boolean;
  source: string;
  sourceStatus: SourceStatus;
  blockedReason?: string;
  dependents?: { id: string; name: string }[];
  permissions: string[];
  updatedAt: string;
  icon: string;
  color: string;
  error?: string;
}
export interface ActivityItem {
  id: string;
  time: string;
  title: string;
  detail: string;
  tone: ActivityTone;
}
export interface ControllerSnapshot {
  plugins: PluginSummary[];
  activities: ActivityItem[];
  checkedAt: string | null;
  startedAt: string;
  controllerVersion: string;
  settings: ControllerSettings;
  dataDir: string;
}
export type ControllerCommand =
  | { type: "snapshot" | "check_updates" }
  | { type: "desktop_action"; action: "open" | "quit" }
  | { type: "plugin_window_closed"; pluginId: string }
  | { type: "add_plugin"; manifestUrl: string; publicKey: string }
  | { type: "install" | "plugin_ui"; pluginId: string }
  | { type: "remove_plugin"; pluginId: string; affectedPluginIds?: string[] }
  | { type: "set_enabled"; pluginId: string; enabled: boolean; affectedPluginIds?: string[] }
  | { type: "set_settings"; settings: ControllerSettings }
  | { type: "plugin_call"; pluginId: string; method: string; input: Json };
export type ControllerEvent =
  | { type: "snapshot"; snapshot: ControllerSnapshot }
  | { type: "response"; id: string; ok: true; result: Json }
  | { type: "response"; id: string; ok: false; message: string }
  | { type: "error"; message: string }
  | { type: "plugin_window"; pluginId: string; title: string; url?: string; visible: boolean }
  | { type: "disconnected"; message: string };
export function defaultSettings(): ControllerSettings {
  return {
    checkIntervalMinutes: 5,
    autoUpdate: true,
    appCheckIntervalMinutes: 5,
    appAutoUpdate: true,
    catalogUrl: defaultCatalogUrl,
    catalogPublicKey: defaultCatalogPublicKey,
  };
}
