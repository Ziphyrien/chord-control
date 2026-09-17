import { randomUUID } from "node:crypto";
import type { Json } from "../../../shared/protocol.ts";
import { jsonValue, object, message } from "../../../shared/validation.ts";

const grants: Readonly<Record<string, string>> = {
  "registry.read": "registry-current-user",
  "registry.write": "registry-current-user",
  "wallpaper.get": "wallpaper",
  "wallpaper.set": "wallpaper",
  "process.list": "process-control",
  "process.spawn": "process-control",
  "process.terminate": "process-control",
};
interface Pending {
  settle(result: { ok: true; value: Json } | { ok: false; error: Error }): void;
}
/** Native responses bypass both command and lifecycle queues, including plugin disposal. */
export class NativeBridge {
  private readonly pending = new Map<string, Pending>();
  private readonly emit: (value: object) => void;
  private closed = false;
  constructor(emit: (value: object) => void) {
    this.emit = emit;
  }
  call(
    pluginId: string,
    permissions: readonly string[],
    operation: string,
    input: Json,
    signal?: AbortSignal,
  ): Promise<Json> {
    const permission = Object.hasOwn(grants, operation) ? grants[operation] : undefined;
    if (!permission || !permissions.includes(permission))
      return Promise.reject(new Error(`插件没有原生能力权限: ${operation}`));
    if (this.closed || signal?.aborted) return Promise.reject(new Error("原生请求已取消"));
    if (
      !jsonValue(input) ||
      Buffer.byteLength(JSON.stringify(input)) > 64 * 1024 ||
      this.pending.size >= 64
    )
      return Promise.reject(new Error("原生请求超出限制"));
    const id = `native-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const abort = () => settle({ ok: false, error: new Error("原生请求已取消") });
      const timeout = setTimeout(
        () => settle({ ok: false, error: new Error(`Windows 原生调用超时: ${operation}`) }),
        15_000,
      );
      const settle: Pending["settle"] = (result) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (result.ok) resolve(result.value);
        else reject(result.error);
      };
      this.pending.set(id, { settle });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.emit({ type: "native_request", id, pluginId, permission, operation, input });
      } catch (error) {
        settle({ ok: false, error: new Error(message(error)) });
      }
    });
  }
  receive(value: unknown): boolean {
    if (!object(value) || value.type !== "native_response") return false;
    const pending = typeof value.id === "string" ? this.pending.get(value.id) : undefined;
    if (pending) {
      if (value.ok === true && jsonValue(value.result))
        pending.settle({ ok: true, value: value.result });
      else
        pending.settle({
          ok: false,
          error: new Error(
            typeof value.message === "string" ? value.message : "原生宿主返回格式错误",
          ),
        });
    }
    return true;
  }
  close(): void {
    this.closed = true;
    for (const request of this.pending.values())
      request.settle({ ok: false, error: new Error("原生宿主已断开") });
  }
}
