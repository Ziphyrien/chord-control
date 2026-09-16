import { randomUUID } from "node:crypto";
import { isJsonValue } from "@earendil-works/chord";
import type { Json } from "../../shared/protocol.ts";

const permissions: Record<string, string> = {
  "registry.read": "registry-current-user",
  "registry.write": "registry-current-user",
  "wallpaper.get": "wallpaper",
  "wallpaper.set": "wallpaper",
  "process.list": "process-control",
  "process.terminate": "process-control",
  "process.spawn": "process-control",
};
type Pending = { finish(error?: Error, result?: Json): void };
/** Correlation is outside the application mutation queue, including activation and disposal. */
export class NativeBridge {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  constructor(private readonly send: (value: object) => void) {}
  call(
    pluginId: string,
    grants: string[],
    operation: string,
    input: Json,
    signal?: AbortSignal,
  ): Promise<Json> {
    const permission = Object.hasOwn(permissions, operation) ? permissions[operation] : undefined;
    if (!permission || !grants.includes(permission))
      return Promise.reject(new Error(`插件没有原生能力权限: ${operation}`));
    if (this.closed || signal?.aborted) return Promise.reject(new Error("原生请求已取消"));
    if (this.pending.size >= 64 || JSON.stringify(input).length > 65536)
      return Promise.reject(new Error("原生请求超出限制"));
    const id = `native-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const abort = () => finish(new Error("原生请求已取消"));
      const timer = setTimeout(
        () => finish(new Error(`Windows 原生调用超时: ${operation}`)),
        15000,
      );
      const finish = (error?: Error, result?: Json) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(result ?? null);
      };
      this.pending.set(id, { finish });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.send({ type: "native_request", id, pluginId, permission, operation, input });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  receive(value: Record<string, unknown>): boolean {
    if (value.type !== "native_response") return false;
    if (typeof value.id !== "string") return true;
    const request = this.pending.get(value.id);
    if (!request) return true;
    if (value.ok === true && isJsonValue(value.result)) request.finish(undefined, value.result);
    else
      request.finish(
        new Error(typeof value.message === "string" ? value.message : "Windows 原生调用失败"),
      );
    return true;
  }
  close(): void {
    this.closed = true;
    for (const request of this.pending.values()) request.finish(new Error("原生宿主已断开"));
  }
}
