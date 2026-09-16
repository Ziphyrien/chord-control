import { isJsonValue } from "@earendil-works/chord";
import type {
  ControllerCommand,
  ControllerEvent,
  ControllerSnapshot,
  Json,
} from "../../shared/protocol.ts";
import { HOST_VERSION } from "../../shared/versions.ts";
import type { PluginManager } from "./plugin-manager.ts";
import type { ActivityLog } from "./activity.ts";
import type { Enqueue, PluginUi } from "./ports.ts";

interface Dependencies {
  plugins: PluginManager;
  ui: PluginUi;
  openUi(id: string): Promise<Json>;
  activity: ActivityLog;
  enqueue: Enqueue;
  emit(event: ControllerEvent): void;
  dataDir: string;
}
/** Serial command dispatch and polling. Transport and plugin execution are adapters. */
export class ControllerApplication {
  private readonly startedAt = new Date().toISOString();
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  constructor(private readonly dependencies: Dependencies) {}
  snapshot(): ControllerSnapshot {
    const { plugins, activity, dataDir } = this.dependencies;
    return {
      plugins: plugins.summaries(),
      activities: activity.items,
      settings: plugins.settings,
      checkedAt: plugins.checkedAt,
      startedAt: this.startedAt,
      controllerVersion: HOST_VERSION,
      dataDir,
    };
  }
  private publish(): void {
    this.dependencies.emit({ type: "snapshot", snapshot: this.snapshot() });
  }
  report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.dependencies.activity.add("操作失败", message, "error");
    this.dependencies.emit({ type: "error", message });
  }
  submit(id: string, command: ControllerCommand): void {
    if (this.stopping) return;
    // Interactive hooks run outside the mutation queue so their plugin UI can answer.
    void (async () => {
      try {
        const action =
          command.type === "desktop_action" ? `desktop.${command.action}` : command.type;
        if (command.type === "desktop_action" && !["open", "quit"].includes(command.action))
          throw new Error("未知桌面操作");
        const validate = await this.dependencies.plugins.authorize(
          action,
          command as unknown as Json,
        );
        await this.dependencies.enqueue(async () => {
          if (this.stopping) throw new Error("控制器正在关闭");
          validate();
          const result = await this.handle(command);
          this.publish();
          this.dependencies.emit({ type: "response", id, ok: true, result });
        });
      } catch (error) {
        this.report(error);
        this.publish();
        this.dependencies.emit({
          type: "response",
          id,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }
  private async handle(command: ControllerCommand): Promise<Json> {
    const { plugins, ui, openUi } = this.dependencies;
    switch (command.type) {
      case "snapshot":
      case "desktop_action":
        return null;
      case "check_updates":
        return plugins.checkUpdates();
      case "set_settings":
        await plugins.updateSettings(command.settings);
        this.schedule();
        return plugins.checkUpdates();
      case "add_plugin":
        await plugins.add(command.manifestUrl, command.publicKey);
        return null;
      case "install":
        await plugins.install(command.pluginId);
        return null;
      case "set_enabled":
        await plugins.setEnabled(command.pluginId, command.enabled);
        return null;
      case "remove_plugin":
        await plugins.remove(command.pluginId);
        return null;
      case "plugin_ui":
        return openUi(command.pluginId);
      case "plugin_window_closed":
        return ui.call(command.pluginId, "window_closed", null);
      case "plugin_call":
        if (
          typeof command.method !== "string" ||
          command.method.length > 100 ||
          !isJsonValue(command.input)
        )
          throw new Error("插件调用格式错误");
        return ui.call(command.pluginId, command.method, command.input);
      default:
        throw new Error("未知控制器命令");
    }
  }
  start(restored = false): void {
    this.publish();
    // Cached plugins can serve desktop requests immediately, even when GitHub is offline.
    // A fresh installation still discovers its initial catalogue at startup.
    if (restored) this.schedule();
    else this.poll();
  }
  private poll(): void {
    if (this.stopping) return;
    void this.dependencies.enqueue(async () => {
      try {
        await this.dependencies.plugins.checkUpdates();
        this.publish();
      } catch (error) {
        this.report(error);
      } finally {
        this.schedule();
      }
    });
  }
  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.stopping)
      this.timer = setTimeout(
        () => this.poll(),
        this.dependencies.plugins.settings.checkIntervalMinutes * 60_000,
      );
  }
  stop(): void {
    this.stopping = true;
    clearTimeout(this.timer);
  }
}
