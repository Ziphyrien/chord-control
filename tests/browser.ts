import { createControllerClient, type ControllerTransport } from "../src/lib/controller.ts";
import type { DesktopAdapter } from "../src/lib/desktop.ts";
import { decodeControllerEvent } from "../src/lib/events.ts";
import type {
  ControllerCommand,
  ControllerEvent,
  ControllerSnapshot,
  Json,
} from "../shared/protocol.ts";

declare global {
  interface Window {
    controllerCommand(
      command: ControllerCommand,
    ): Promise<{ result: Json; snapshot?: ControllerSnapshot; message?: string }>;
    desktopCommand(command: "read" | "write" | "directory", enabled?: boolean): Promise<boolean>;
    testBridge: {
      emit(event: ControllerEvent): void;
      emitRaw(payload: string): void;
      subscriptions(): number;
    };
  }
}
const listeners = new Set<(event: ControllerEvent) => void>();
function emitRaw(payload: string) {
  let event: ControllerEvent;
  try {
    event = decodeControllerEvent(payload);
  } catch {
    event = { type: "error", message: "收到无法识别的数据，请重试连接" };
  }
  for (const receive of listeners) receive(event);
}
function emit(event: ControllerEvent) {
  emitRaw(JSON.stringify(event));
}
const transport: ControllerTransport = {
  async subscribe(receive) {
    listeners.add(receive);
    return () => {
      listeners.delete(receive);
    };
  },
  async dispatch(command) {
    const audience = [...listeners];
    const response = await window.controllerCommand(command);
    for (const receive of audience) {
      if (!listeners.has(receive)) continue;
      if (response.snapshot)
        receive(
          decodeControllerEvent(JSON.stringify({ type: "snapshot", snapshot: response.snapshot })),
        );
      receive(
        response.message
          ? { type: "response", id: command.id, ok: false, message: response.message }
          : { type: "response", id: command.id, ok: true, result: response.result },
      );
    }
  },
};
const desktop: DesktopAdapter = {
  available: true,
  autostart: () => window.desktopCommand("read"),
  setAutostart: (enabled) => window.desktopCommand("write", enabled),
  async openDataDirectory() {
    await window.desktopCommand("directory");
  },
};
export function createPlatform() {
  window.testBridge = { emit, emitRaw, subscriptions: () => listeners.size };
  return { client: createControllerClient(transport), desktop };
}
