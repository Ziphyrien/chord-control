import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { PluginNativeService } from "../../../sdk/index.ts";
import type { Json } from "../../../shared/protocol.ts";
import { jsonValue, object } from "../../../shared/validation.ts";

const ASSET = "native/chord-wallpaper.exe";
const OPERATIONS = new Set(["wallpaper.get", "wallpaper.set", "registry.read", "registry.write"]);

export interface WallpaperNative {
  native(operation: string, input: Json, context?: Context): Promise<Json>;
}

function decode(value: Json): Json {
  if (!object(value) || value.format !== 1 || typeof value.ok !== "boolean")
    throw new Error("壁纸原生 helper 返回格式无效");
  if (!value.ok) {
    const detail = typeof value.error === "string" ? value.error : "壁纸原生 helper 调用失败";
    throw new Error(detail);
  }
  if (!Object.hasOwn(value, "value") || !jsonValue(value.value))
    throw new Error("壁纸原生 helper 成功响应无效");
  return value.value;
}

export function createWallpaperNative(service: Pick<PluginNativeService, "call">): WallpaperNative {
  return {
    native(operation, input, context = BACKGROUND_CONTEXT) {
      if (!OPERATIONS.has(operation)) return Promise.reject(new Error("未知壁纸原生操作"));
      return service.call(ASSET, { format: 1, operation, input }, context).then(decode);
    },
  };
}
