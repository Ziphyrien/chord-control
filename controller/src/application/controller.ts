import type {
  ControllerCommand,
  ControllerEvent,
  ControllerSnapshot,
  Json,
} from "../../../shared/protocol.ts";
import { HOST_VERSION } from "../../../shared/versions.ts";
import { message } from "../../../shared/validation.ts";
import type { Enqueue, PluginRuntime } from "../domain/ports.ts";
import type { PluginService } from "./plugin-service.ts";
import type { ActivityLog } from "./execution.ts";

interface Dependencies {
  plugins: PluginService;
  runtime: PluginRuntime;
  gate: Enqueue;
  activity: ActivityLog;
  dataDir: string;
  openUi: (id: string) => Promise<Json>;
  emit(event: ControllerEvent): void;
}
/** App command semantics and scheduling. Authorization never holds the plugin execution gate. */
export class ControllerApplication {
  private readonly options: Dependencies;
  private readonly startedAt = new Date().toISOString();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private failures = 0;
  private checking?: Promise<{ failures: number }>;
  constructor(options: Dependencies) {
    this.options = options;
  }
  snapshot(): ControllerSnapshot {
    const { plugins, activity, dataDir } = this.options;
    return {
      plugins: plugins.summaries(),
      activities: activity.snapshot(),
      settings: plugins.settings,
      checkedAt: plugins.checkedAt,
      startedAt: this.startedAt,
      controllerVersion: HOST_VERSION,
      dataDir,
    };
  }
  publish(): void {
    this.options.emit({ type: "snapshot", snapshot: this.snapshot() });
  }
  report(error: unknown): void {
    const detail = message(error);
    this.options.activity.add("操作失败", detail, "error");
    this.options.emit({ type: "error", message: detail });
  }
  async submit(id: string, command: ControllerCommand): Promise<void> {
    try {
      if (this.stopped) throw new Error("控制器正在关闭");
      const action = command.type === "desktop_action" ? `desktop.${command.action}` : command.type;
      const validate = await this.options.plugins.authorize(action, command as unknown as Json);
      const result = await this.handle(command, () => {
        if (this.stopped) throw new Error("控制器正在关闭");
        validate();
      });
      this.publish();
      this.options.emit({ type: "response", id, ok: true, result });
    } catch (error) {
      this.report(error);
      this.publish();
      this.options.emit({ type: "response", id, ok: false, message: message(error) });
    }
  }
  private async handle(command: ControllerCommand, validate: () => void): Promise<Json> {
    const { plugins, runtime, gate, openUi } = this.options;
    switch (command.type) {
      case "snapshot":
        return null;
      case "desktop_action":
        validate();
        return null;
      case "plugin_ui":
        return gate(async () => {
          validate();
          return openUi(command.pluginId);
        });
      case "plugin_call":
        return gate(() => {
          validate();
          return runtime.call(command.pluginId, command.method, command.input);
        });
      case "plugin_window_closed":
        return gate(() => runtime.call(command.pluginId, "window_closed", null));
      case "check_updates":
        return this.checkUpdates(validate);
      case "set_settings":
        await plugins.updateSettings(command.settings, validate);
        this.failures = 0;
        this.publish();
        return this.checkUpdates();
      case "add_plugin":
        await plugins.add(command.manifestUrl, command.publicKey, validate);
        return null;
      case "install":
        await plugins.install(command.pluginId, validate);
        return null;
      case "set_enabled":
        await plugins.setEnabled(
          command.pluginId,
          command.enabled,
          command.affectedPluginIds,
          validate,
        );
        return null;
      case "remove_plugin":
        await plugins.remove(command.pluginId, command.affectedPluginIds, validate);
        return null;
    }
  }
  start(): void {
    this.publish();
    this.schedule(this.options.plugins.needsStartupCheck ? 0 : undefined);
  }
  private schedule(delay?: number): void {
    clearTimeout(this.timer);
    if (!this.stopped && !this.checking)
      this.timer = setTimeout(
        () => {
          void this.poll();
        },
        delay ??
          Math.min(
            this.options.plugins.settings.checkIntervalMinutes * 60_000 * 2 ** this.failures,
            Math.max(this.options.plugins.settings.checkIntervalMinutes * 60_000, 60 * 60_000),
          ),
      );
  }
  private checkUpdates(validate: () => void = () => {}): Promise<{ failures: number }> {
    validate();
    if (this.checking)
      return this.checking.then((result) => {
        validate();
        return result;
      });
    clearTimeout(this.timer);
    this.checking = this.options.plugins
      .checkUpdates(validate)
      .then(
        (result) => {
          this.failures = result.failures ? Math.min(this.failures + 1, 6) : 0;
          return result;
        },
        (error: unknown) => {
          this.failures = Math.min(this.failures + 1, 6);
          throw error;
        },
      )
      .finally(() => {
        this.checking = undefined;
        this.schedule();
      });
    return this.checking;
  }
  private async poll(): Promise<void> {
    try {
      await this.checkUpdates();
      this.publish();
    } catch (error) {
      if (!this.stopped) this.report(error);
    }
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
