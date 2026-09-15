import type {
  ControllerCommand,
  ControllerEvent,
  ControllerSnapshot,
  PluginSummary,
} from "../../shared/protocol.ts";
import type { ControllerClient } from "./controller.ts";
import { desktop } from "./desktop.ts";

type Panel = { pluginId: string; name: string; url: string; revision: string };
export class ControllerSession {
  snapshot = $state.raw<ControllerSnapshot | null>(null);
  connected = $state(false);
  pending = $state<string | null>(null);
  error = $state("");
  notice = $state("");
  autostart = $state(false);
  panel = $state.raw<Panel | null>(null);
  canAct = $derived(this.connected && this.pending === null);
  private noticeTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly client: ControllerClient) {}
  private notify(text: string): void {
    this.notice = text;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = "";
    }, 4000);
  }
  private receive(event: ControllerEvent): void {
    if (event.type === "snapshot") {
      this.snapshot = event.snapshot;
      this.connected = true;
      if (this.panel) {
        const plugin = event.snapshot.plugins.find((item) => item.id === this.panel?.pluginId);
        if (!plugin?.running || plugin.revision !== this.panel.revision) {
          this.panel = null;
          this.notify("插件状态已变化，请重新打开");
        }
      }
    } else if (event.type === "error") this.error = event.message;
    else if (event.type === "disconnected") {
      this.connected = false;
      this.panel = null;
    }
  }
  start(): () => void {
    let disposed = false;
    let cleanup = () => {};
    void this.client
      .connect((event) => this.receive(event))
      .then((fn) => {
        if (disposed) fn();
        else cleanup = fn;
      })
      .catch((error) => {
        this.error = String(error);
      });
    if (desktop.available)
      void desktop
        .autostart()
        .then((enabled) => {
          if (!disposed) this.autostart = enabled;
        })
        .catch((error) => {
          this.error = String(error);
        });
    return () => {
      disposed = true;
      cleanup();
      clearTimeout(this.noticeTimer);
    };
  }
  async run(command: ControllerCommand, success = ""): Promise<boolean> {
    this.pending = command.type;
    this.error = "";
    this.notice = "";
    try {
      const result = await this.client.send(command);
      if (
        result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        typeof result.failures === "number" &&
        result.failures > 0
      )
        this.notify(`${result.failures} 项同步失败，可查看记录`);
      else if (success) this.notify(success);
      return true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      this.pending = null;
    }
  }
  async open(plugin: PluginSummary): Promise<void> {
    this.pending = "plugin_ui";
    this.error = "";
    try {
      const result = await this.client.send({ type: "plugin_ui", pluginId: plugin.id });
      if (
        !result ||
        Array.isArray(result) ||
        typeof result !== "object" ||
        typeof result.url !== "string" ||
        typeof result.revision !== "string"
      )
        throw new Error("无法打开插件界面");
      this.panel = {
        pluginId: plugin.id,
        name: plugin.name,
        url: result.url,
        revision: result.revision,
      };
    } catch (error) {
      this.error = String(error);
    } finally {
      this.pending = null;
    }
  }
  async toggleAutostart(): Promise<void> {
    this.pending = "autostart";
    this.error = "";
    try {
      this.autostart = await desktop.setAutostart(!this.autostart);
    } catch (error) {
      this.error = String(error);
    } finally {
      this.pending = null;
    }
  }
  async openDirectory(): Promise<void> {
    try {
      await desktop.openDataDirectory();
    } catch (error) {
      this.error = String(error);
    }
  }
}
