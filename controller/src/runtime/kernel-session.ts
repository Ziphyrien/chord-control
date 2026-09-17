import { randomUUID } from "node:crypto";
import type { Context, ContextKey } from "@earendil-works/chord";
import type { Json } from "../../../shared/protocol.ts";
import type { NativeBridge } from "../transport/native-bridge.ts";

/** Kept inside the runtime; service hops preserve the original generation's resource owner. */
export const KernelCaller: ContextKey<KernelSession> = { token: Symbol("kernel-caller") };

export class KernelSession {
  private readonly id = randomUUID();
  private opening?: Promise<Json>;
  private closing?: Promise<void>;
  private closed = false;
  private readonly native: NativeBridge;
  private readonly pluginId: string;
  private readonly permissions: readonly string[];
  constructor(native: NativeBridge, pluginId: string, permissions: readonly string[]) {
    this.native = native;
    this.pluginId = pluginId;
    this.permissions = permissions;
  }
  async call(operation: string, input: Json, context: Context): Promise<Json> {
    if (this.closed) throw new Error("插件 API 会话已停止");
    if (!this.permissions.includes("host-control")) throw new Error("插件未声明 host-control 权限");
    if (typeof operation !== "string" || !operation || operation.length > 100)
      throw new Error("无效宿主操作");
    context.abortSignal?.throwIfAborted();
    // Acquisition cannot be cancelled by one caller; close always follows it, even after timeout.
    this.opening ??= this.native.call(this.pluginId, this.permissions, "host.open", {
      session: this.id,
    });
    await this.opening;
    if (this.closed) throw new Error("插件 API 会话已停止");
    context.abortSignal?.throwIfAborted();
    return this.native.call(
      this.pluginId,
      this.permissions,
      "host.call",
      {
        session: this.id,
        operation,
        input,
      },
      context.abortSignal,
    );
  }
  stop(): void {
    this.closed = true;
  }
  close(): Promise<void> {
    this.stop();
    this.closing ??= (async () => {
      if (!this.opening) return;
      await this.opening.catch(() => undefined);
      await this.native.call(this.pluginId, this.permissions, "host.close", { session: this.id });
    })();
    return this.closing;
  }
}
