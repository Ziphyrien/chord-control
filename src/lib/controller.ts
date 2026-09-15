import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ControllerCommand, ControllerEvent, Json } from "../../shared/protocol.ts";
export const isDesktop = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export interface ControllerClient {
  connect(onEvent: (event: ControllerEvent) => void): Promise<() => void>;
  send(command: ControllerCommand): Promise<Json>;
}
export function createControllerClient(): ControllerClient {
  let emit: (event: ControllerEvent) => void = () => {};
  let unlisten: UnlistenFn | undefined;
  const pending = new Map<
    string,
    {
      resolve: (value: Json) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  function cancel(message: string): void {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    pending.clear();
  }
  function receive(event: ControllerEvent): void {
    if (event.type === "response") {
      const request = pending.get(event.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(event.id);
      if (event.ok) request.resolve(event.result ?? null);
      else request.reject(new Error(event.message ?? "操作失败"));
    } else {
      if (event.type === "disconnected") cancel(event.message);
      emit(event);
    }
  }
  async function send(command: ControllerCommand): Promise<Json> {
    if (!isDesktop()) throw new Error("无法连接控制器");
    if (!unlisten) throw new Error("控制器尚未连接");
    const id = crypto.randomUUID();
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("控制器响应超时，请查看运行日志"));
      }, 5 * 60_000);
      pending.set(id, { resolve, reject, timer });
      void invoke("controller_command", { command: JSON.stringify({ ...command, id }) }).catch(
        (error) => {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error(String(error)));
          receive({ type: "disconnected", message: String(error) });
        },
      );
    });
  }
  return {
    async connect(onEvent) {
      emit = onEvent;
      unlisten?.();
      if (!isDesktop()) {
        receive({ type: "disconnected", message: "无法连接控制器" });
        return () => {};
      }
      unlisten = await listen<string>("controller:event", ({ payload }) => {
        try {
          receive(JSON.parse(payload) as ControllerEvent);
        } catch {
          receive({ type: "error", message: "控制器返回了无效事件" });
        }
      });
      try {
        await send({ type: "snapshot" });
      } catch (error) {
        receive({ type: "disconnected", message: String(error) });
      }
      return () => {
        unlisten?.();
        unlisten = undefined;
        cancel("控制台已关闭");
      };
    },
    send,
  };
}
