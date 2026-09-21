import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DesktopAdapter } from "./desktop.ts";
import type { ControllerTransport } from "./controller.ts";
import { decodeControllerEvent } from "./events.ts";

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createNativeTransport(): ControllerTransport {
  return {
    subscribe(receive) {
      return listen<string>("controller:event", ({ payload }) => {
        try {
          receive(decodeControllerEvent(payload));
        } catch {
          receive({ type: "error", message: "收到无法识别的数据，请重试连接" });
        }
      });
    },
    async dispatch(command) {
      await invoke("controller_command", { command: JSON.stringify(command) });
    },
  };
}

export function createDesktopAdapter(): DesktopAdapter {
  return {
    available: true,
    autostart: () => invoke<boolean>("startup_is_enabled"),
    setAutostart: (enabled) => invoke<boolean>("startup_set_enabled", { enabled }),
    async openDataDirectory() {
      await invoke("open_data_directory");
    },
  };
}
