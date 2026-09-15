import { invoke } from "@tauri-apps/api/core";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { isDesktop } from "./controller.ts";

export const desktop = {
  available: isDesktop(),
  autostart: isEnabled,
  async setAutostart(enabled: boolean): Promise<boolean> {
    await (enabled ? enable() : disable());
    return isEnabled();
  },
  async openDataDirectory(): Promise<void> {
    await invoke("open_data_directory");
  },
};
