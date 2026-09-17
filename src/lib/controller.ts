import type { ControllerCommand, ControllerEvent, Json } from "../../shared/protocol.ts";

export interface ControllerClient {
  connect(onEvent: (event: ControllerEvent) => void): Promise<() => void>;
  send(command: ControllerCommand): Promise<Json>;
}

/** Native IPC owns decoding. Only ConnectionError denotes transport loss;
 * ordinary dispatch rejections are command failures (for example a locked desktop). */
export interface ControllerTransport {
  subscribe(receive: (event: ControllerEvent) => void): Promise<() => void>;
  dispatch(command: ControllerCommand & { id: string }): Promise<void>;
}

export class ConnectionError extends Error {}
export class CommandError extends Error {}

export const unavailableClient: ControllerClient = {
  async connect(receive) {
    receive({ type: "disconnected", message: "无法连接控制器" });
    return () => {};
  },
  async send() {
    throw new ConnectionError("无法连接控制器");
  },
};

export function createControllerClient(
  transport: ControllerTransport,
  timeoutMs = 300_000,
): ControllerClient {
  type Request = {
    resolve(value: Json): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  };
  type Connection = {
    active: boolean;
    emit(event: ControllerEvent): void;
    unsubscribe?: () => void;
    requests: Map<string, Request>;
  };
  let current: Connection | undefined;

  function close(connection: Connection, message: string): void {
    if (!connection.active) return;
    connection.active = false;
    connection.unsubscribe?.();
    for (const request of connection.requests.values()) {
      clearTimeout(request.timer);
      request.reject(new ConnectionError(message));
    }
    connection.requests.clear();
    if (current === connection) current = undefined;
  }

  async function send(command: ControllerCommand): Promise<Json> {
    const connection = current;
    if (!connection?.active || !connection.unsubscribe) throw new ConnectionError("控制器尚未连接");
    const id = crypto.randomUUID();
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.requests.delete(id);
        reject(new CommandError("操作等待超时，请检查记录后重试"));
      }, timeoutMs);
      connection.requests.set(id, { resolve, reject, timer });
      void Promise.resolve()
        .then(() => {
          if (connection.active && connection.requests.has(id))
            return transport.dispatch({ ...command, id });
        })
        .catch((error: unknown) => {
          if (!connection.active || !connection.requests.has(id)) return;
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof ConnectionError) {
            close(connection, message);
            connection.emit({ type: "disconnected", message });
          } else {
            const request = connection.requests.get(id)!;
            connection.requests.delete(id);
            clearTimeout(request.timer);
            request.reject(new CommandError(message));
          }
        });
    });
  }

  return {
    send,
    async connect(emit) {
      if (current) close(current, "连接已更新");
      const connection: Connection = { active: true, emit, requests: new Map() };
      current = connection;
      try {
        const unsubscribe = await transport.subscribe((event) => {
          if (!connection.active || current !== connection) return;
          if (event.type === "response") {
            const request = connection.requests.get(event.id);
            if (!request) return;
            connection.requests.delete(event.id);
            clearTimeout(request.timer);
            if (event.ok) request.resolve(event.result ?? null);
            else request.reject(new CommandError(event.message || "操作未完成"));
          } else {
            if (event.type === "disconnected") close(connection, event.message);
            emit(event);
          }
        });
        if (!connection.active || current !== connection) {
          unsubscribe();
          return () => {};
        }
        connection.unsubscribe = unsubscribe;
        // Return cleanup immediately; a slow initial snapshot must not hold the listener open.
        void send({ type: "snapshot" }).catch((error: unknown) => {
          if (connection.active)
            emit({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
        });
        return () => close(connection, "连接已关闭");
      } catch (error) {
        close(connection, "连接失败");
        throw error;
      }
    },
  };
}
