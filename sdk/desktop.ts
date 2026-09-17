import type { Context, JsonValue } from "@earendil-works/chord";
import type { KernelService } from "./kernel.ts";

/** Desktop helpers bundled into the calling plugin. */
export function createDesktop(kernel: KernelService) {
  async function action(operation: string, input: JsonValue, context: Context): Promise<void> {
    await kernel.call(operation, input, context);
  }
  function visible(value: boolean): boolean {
    if (typeof value !== "boolean") throw new Error("可见状态必须是布尔值");
    return value;
  }
  return {
    info: (context: Context) => kernel.call("info", null, context),
    windowState: (context: Context) => kernel.call("window.state", null, context),
    open: (context: Context) => action("window.open", null, context),
    hide: (context: Context) => action("window.hide", null, context),
    minimize: (context: Context) => action("window.minimize", null, context),
    setTaskbarVisible: async (value: boolean, context: Context) =>
      action("window.taskbar", visible(value), context),
    setTrayVisible: async (value: boolean, context: Context) =>
      action("tray.visible", visible(value), context),
    updateStatus: (context: Context) => kernel.call("updates.status", null, context),
    checkForUpdate: (context: Context) => kernel.call("updates.check", null, context),
    installUpdate: (context: Context) => kernel.call("updates.install", null, context),
    quit: (context: Context) => action("app.quit", null, context),
  };
}
