import type {
  ControllerCommand,
  ControllerEvent,
  ControllerSnapshot,
  Json,
  PluginSummary,
} from "../../shared/protocol.ts";
import type { ControllerClient } from "./controller.ts";
import type { DesktopAdapter } from "./desktop.ts";
import { AdaptiveLoadingPolicy } from "./loading-policy.ts";

export type PluginPanel = { pluginId: string; name: string; url: string; revision: string };
export type GroupConfirmation = {
  pluginId: string;
  name: string;
  kind: "disable" | "remove";
  dependents: { id: string; name: string }[];
  needsRefresh: boolean;
};
export interface SessionState {
  connection: "loading" | "online" | "offline";
  /** Delayed/hysteretic visual feedback; fast connections never flash a loader. */
  loadingVisible: boolean;
  snapshot: ControllerSnapshot | null;
  /** Immediate operation locks keep controls safe without changing visible labels. */
  pending: Readonly<Record<string, string>>;
  /** Delayed visual feedback; fast operations never flash their loading text. */
  feedback: Readonly<Record<string, string>>;
  errors: Readonly<Record<string, string>>;
  notice: string;
  autostart: boolean | null;
  panel: PluginPanel | null;
  confirmation: GroupConfirmation | null;
}
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const objectResult = (value: Json): value is { [key: string]: Json } =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const feedbackLabels: Record<string, string> = {
  read: "正在读取启动设置…",
  write: "正在保存启动设置…",
  open: "正在打开数据目录…",
  snapshot: "正在刷新插件列表…",
  check_updates: "正在检查更新…",
  install: "正在安装插件…",
  add_plugin: "正在添加插件…",
  set_enabled: "正在更新插件状态…",
  remove_plugin: "正在移除插件…",
  set_settings: "正在保存设置…",
};
const operationFeedbackLabel = (key: string, label: string): string =>
  key === "panel" ? "正在打开插件…" : (feedbackLabels[label] ?? "正在处理…");

/** Application state is independent of Svelte and native APIs, so races can be probed directly. */
export class ControllerSession {
  state: SessionState = {
    connection: "loading",
    loadingVisible: false,
    snapshot: null,
    pending: {},
    feedback: {},
    errors: {},
    notice: "",
    autostart: null,
    panel: null,
    confirmation: null,
  };
  private listeners = new Set<(state: SessionState) => void>();
  private epoch = 0;
  private active = false;
  private cleanup?: () => void;
  private operations = new Map<string, symbol>();
  private panelEpoch = 0;
  private confirmationEpoch = 0;
  private snapshotRevision = 0;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private connectionTimer?: ReturnType<typeof setTimeout>;
  private loadingTimer?: ReturnType<typeof setTimeout>;
  private connectionStartedAt = 0;
  private loadingShownAt = 0;
  private readonly loadingPolicy: AdaptiveLoadingPolicy;
  private feedbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private feedbackShownAt = new Map<string, number>();
  private feedbackGeneration = new Map<string, number>();

  readonly client: ControllerClient;
  readonly desktop: DesktopAdapter;
  constructor(
    client: ControllerClient,
    desktop: DesktopAdapter,
    loadingPolicy = new AdaptiveLoadingPolicy(),
  ) {
    this.client = client;
    this.desktop = desktop;
    this.loadingPolicy = loadingPolicy;
  }

  subscribe(receive: (state: SessionState) => void): () => void {
    this.listeners.add(receive);
    receive(this.state);
    return () => {
      this.listeners.delete(receive);
    };
  }
  private patch(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const receive of this.listeners) receive(this.state);
  }
  clearError(key: string): void {
    const errors = { ...this.state.errors };
    delete errors[key];
    this.patch({ errors });
  }
  private fail(key: string, error: unknown): void {
    this.patch({ errors: { ...this.state.errors, [key]: messageOf(error) } });
  }
  private notify(notice: string): void {
    clearTimeout(this.noticeTimer);
    this.patch({ notice });
    const epoch = this.epoch;
    this.noticeTimer = setTimeout(() => {
      if (this.active && epoch === this.epoch) this.patch({ notice: "" });
    }, 5000);
  }
  private invalidate(): void {
    ++this.epoch;
    ++this.panelEpoch;
    ++this.confirmationEpoch;
    this.cleanup?.();
    this.cleanup = undefined;
    this.operations.clear();
    clearTimeout(this.noticeTimer);
    clearTimeout(this.connectionTimer);
    clearTimeout(this.loadingTimer);
    this.loadingTimer = undefined;
    for (const timer of this.feedbackTimers.values()) clearTimeout(timer);
    this.feedbackTimers.clear();
    this.feedbackShownAt.clear();
    this.feedbackGeneration.clear();
    this.connectionStartedAt = 0;
    this.loadingShownAt = 0;
  }
  private clearFeedbackTimer(key: string): void {
    const timer = this.feedbackTimers.get(key);
    if (timer) clearTimeout(timer);
    this.feedbackTimers.delete(key);
  }
  private clearFeedback(key: string): void {
    this.clearFeedbackTimer(key);
    this.feedbackShownAt.delete(key);
    if (!(key in this.state.feedback)) return;
    const feedback = { ...this.state.feedback };
    delete feedback[key];
    this.patch({ feedback });
  }
  start(): () => void {
    this.active = true;
    this.reconnect();
    return () => {
      this.active = false;
      this.invalidate();
    };
  }
  reconnect(): void {
    if (!this.active) return;
    this.invalidate();
    const epoch = this.epoch;
    const current = () => this.active && epoch === this.epoch;
    this.connectionStartedAt = Date.now();
    this.patch({
      connection: "loading",
      loadingVisible: false,
      pending: {},
      feedback: {},
      errors: {},
      notice: "",
      panel: null,
      confirmation: null,
      autostart: null,
    });
    this.loadingTimer = setTimeout(() => {
      if (!current() || this.state.connection !== "loading") return;
      this.loadingShownAt = Date.now();
      this.patch({ loadingVisible: true });
    }, this.loadingPolicy.revealDelay());
    this.connectionTimer = setTimeout(() => {
      if (!current() || this.state.connection !== "loading") return;
      this.receive({ type: "disconnected", message: "连接等待超时，请重试" });
    }, 20_000);
    void Promise.resolve()
      .then(() => {
        if (!current()) return () => {};
        return this.client.connect((event) => {
          if (current()) this.receive(event);
        });
      })
      .then((cleanup) => {
        if (current()) this.cleanup = cleanup;
        else cleanup();
      })
      .catch((error: unknown) => {
        if (current()) this.receive({ type: "disconnected", message: messageOf(error) });
      });
    if (this.desktop.available) {
      void this.perform(
        "autostart",
        "read",
        () => this.desktop.autostart(),
        (autostart) => this.patch({ autostart }),
      );
    }
  }
  private receive(event: ControllerEvent): void {
    if (event.type === "snapshot") {
      clearTimeout(this.connectionTimer);
      clearTimeout(this.loadingTimer);
      this.loadingTimer = undefined;
      const elapsed = this.connectionStartedAt
        ? Math.max(0, Date.now() - this.connectionStartedAt)
        : 0;
      if (elapsed) this.loadingPolicy.observe("connection", elapsed);
      this.connectionStartedAt = 0;
      const shownAt = this.loadingShownAt;
      this.loadingShownAt = 0;
      ++this.snapshotRevision;
      this.patch({ snapshot: event.snapshot, connection: "online" });
      if (!shownAt) this.patch({ loadingVisible: false });
      else {
        const remaining = Math.max(0, this.loadingPolicy.settleDelay() - (Date.now() - shownAt));
        if (remaining) {
          const epoch = this.epoch;
          this.loadingTimer = setTimeout(() => {
            if (!this.active || epoch !== this.epoch) return;
            this.loadingTimer = undefined;
            this.patch({ loadingVisible: false });
          }, remaining);
        } else this.patch({ loadingVisible: false });
      }
      this.clearError("connection");
      const panel = this.state.panel;
      if (panel) {
        const plugin = event.snapshot.plugins.find((item) => item.id === panel.pluginId);
        if (!plugin?.running || !plugin.hasUi || plugin.revision !== panel.revision) {
          this.closePanel();
          this.notify("插件状态已变化，请重新打开");
        }
      }
    } else if (event.type === "disconnected") {
      this.invalidate();
      this.patch({
        connection: "offline",
        loadingVisible: false,
        pending: {},
        feedback: {},
        panel: null,
        confirmation: null,
        notice: "",
      });
      this.fail("connection", event.message);
    } else if (event.type === "error") this.fail("connection", event.message);
  }

  private async perform<T>(
    key: string,
    label: string,
    task: () => Promise<T>,
    accept: (value: T) => void,
    valid: () => boolean = () => true,
  ): Promise<boolean> {
    if (!this.active || this.operations.has(key)) return false;
    const token = Symbol(key);
    const epoch = this.epoch;
    this.operations.set(key, token);
    this.clearError(key);
    this.clearFeedback(key);
    const generation = (this.feedbackGeneration.get(key) ?? 0) + 1;
    this.feedbackGeneration.set(key, generation);
    const startedAt = Date.now();
    const feedbackLabel = operationFeedbackLabel(key, label);
    const current = () => this.active && epoch === this.epoch && this.operations.get(key) === token;
    const revealTimer = setTimeout(() => {
      this.feedbackTimers.delete(key);
      if (!current() || this.feedbackGeneration.get(key) !== generation) return;
      this.feedbackShownAt.set(key, Date.now());
      this.patch({ feedback: { ...this.state.feedback, [key]: feedbackLabel } });
    }, this.loadingPolicy.revealDelay(key));
    this.feedbackTimers.set(key, revealTimer);
    this.patch({ pending: { ...this.state.pending, [key]: label } });
    try {
      const result = await task();
      if (!current() || !valid()) return false;
      accept(result);
      return true;
    } catch (error) {
      if (current() && valid()) this.fail(key, error);
      return false;
    } finally {
      this.clearFeedbackTimer(key);
      if (current()) {
        const shownAt = this.feedbackShownAt.get(key);
        this.feedbackShownAt.delete(key);
        this.operations.delete(key);
        const pending = { ...this.state.pending };
        delete pending[key];
        this.loadingPolicy.observe(key, Math.max(0, Date.now() - startedAt));
        this.patch({ pending });
        const remaining = shownAt
          ? Math.max(0, this.loadingPolicy.settleDelay(key) - (Date.now() - shownAt))
          : 0;
        if (remaining) {
          const hideTimer = setTimeout(() => {
            this.feedbackTimers.delete(key);
            if (
              !this.active ||
              epoch !== this.epoch ||
              this.feedbackGeneration.get(key) !== generation
            )
              return;
            this.clearFeedback(key);
          }, remaining);
          this.feedbackTimers.set(key, hideTimer);
        } else this.clearFeedback(key);
      }
    }
  }

  async run(command: ControllerCommand, success = ""): Promise<boolean> {
    if (this.state.connection !== "online" || this.operations.has("refresh")) return false;
    return this.perform(
      "mutation",
      command.type,
      () => this.client.send(command),
      (result) => {
        if (objectResult(result) && typeof result.failures === "number" && result.failures > 0)
          this.notify(`${result.failures} 项未完成，可查看活动记录`);
        else if (success) this.notify(success);
      },
    );
  }

  closePanel(): void {
    ++this.panelEpoch;
    // Closing is cancellation of presentation, not of a controller command already in flight.
    this.operations.delete("panel");
    const pending = { ...this.state.pending };
    delete pending.panel;
    this.patch({ panel: null, pending });
    this.clearFeedback("panel");
    this.clearError("panel");
  }
  async open(plugin: PluginSummary): Promise<void> {
    if (this.state.connection !== "online") return;
    this.closePanel();
    const panelEpoch = this.panelEpoch;
    await this.perform(
      "panel",
      plugin.id,
      () => this.client.send({ type: "plugin_ui", pluginId: plugin.id }),
      (result) => {
        if (
          !objectResult(result) ||
          typeof result.url !== "string" ||
          typeof result.revision !== "string"
        )
          throw new Error("无法打开插件界面");
        const url = new URL(result.url);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("插件界面地址不可用");
        const latest = this.state.snapshot?.plugins.find((item) => item.id === plugin.id);
        if (!latest?.running || !latest.hasUi || latest.revision !== result.revision)
          throw new Error("插件状态已变化，请重新打开");
        this.patch({
          panel: {
            pluginId: plugin.id,
            name: latest.name,
            url: url.href,
            revision: result.revision,
          },
        });
      },
      () => panelEpoch === this.panelEpoch,
    );
    if (panelEpoch === this.panelEpoch) this.clearFeedback("panel");
  }

  requestChange(plugin: PluginSummary, kind: GroupConfirmation["kind"]): void {
    if (
      this.state.connection !== "online" ||
      this.operations.has("mutation") ||
      this.operations.has("refresh")
    )
      return;
    ++this.confirmationEpoch;
    this.clearError("refresh");
    this.clearError("mutation");
    this.patch({
      confirmation: {
        pluginId: plugin.id,
        name: plugin.name,
        kind,
        dependents: (plugin.dependents ?? []).map(({ id, name }) => ({ id, name })),
        needsRefresh: false,
      },
    });
  }
  closeConfirmation(): void {
    ++this.confirmationEpoch;
    this.patch({ confirmation: null });
    this.clearError("mutation");
    this.clearError("refresh");
  }
  async confirmChange(): Promise<void> {
    const confirmation = this.state.confirmation;
    if (
      !confirmation ||
      this.state.connection !== "online" ||
      this.operations.has("mutation") ||
      this.operations.has("refresh")
    )
      return;
    if (confirmation.needsRefresh) {
      await this.refreshConfirmation(confirmation, this.confirmationEpoch);
      return;
    }
    const latest = this.state.snapshot?.plugins.find(
      (plugin) => plugin.id === confirmation.pluginId,
    );
    if (!latest) {
      this.closeConfirmation();
      return;
    }
    const ids = confirmation.dependents.map((item) => item.id);
    const freshIds = (latest.dependents ?? []).map((item) => item.id);
    if (JSON.stringify([...ids].sort()) !== JSON.stringify([...freshIds].sort())) {
      this.requestChange(latest, confirmation.kind);
      this.fail("mutation", "受影响的插件已变化，请重新确认名单");
      return;
    }
    const epoch = this.confirmationEpoch;
    const command: ControllerCommand =
      confirmation.kind === "disable"
        ? {
            type: "set_enabled",
            pluginId: confirmation.pluginId,
            enabled: false,
            affectedPluginIds: ids,
          }
        : { type: "remove_plugin", pluginId: confirmation.pluginId, affectedPluginIds: ids };
    const accepted = await this.perform(
      "mutation",
      command.type,
      () => this.client.send(command),
      () => {
        this.closeConfirmation();
        this.notify(confirmation.kind === "disable" ? "插件已暂停" : "插件已忽略");
      },
      () => epoch === this.confirmationEpoch,
    );
    if (!accepted && epoch === this.confirmationEpoch && this.state.connection === "online") {
      // A graph may change during a command. Refresh before allowing another explicit approval.
      this.patch({ confirmation: { ...confirmation, needsRefresh: true } });
      await this.refreshConfirmation(confirmation, epoch);
    }
  }
  private async refreshConfirmation(confirmation: GroupConfirmation, epoch: number): Promise<void> {
    const revision = this.snapshotRevision;
    await this.perform(
      "refresh",
      "snapshot",
      () => this.client.send({ type: "snapshot" }),
      () => {
        if (this.snapshotRevision === revision) throw new Error("未收到最新插件名单，请刷新后重试");
        const plugin = this.state.snapshot?.plugins.find(
          (item) => item.id === confirmation.pluginId,
        );
        if (!plugin) this.closeConfirmation();
        else
          this.patch({
            confirmation: {
              ...confirmation,
              name: plugin.name,
              dependents: (plugin.dependents ?? []).map(({ id, name }) => ({ id, name })),
              needsRefresh: false,
            },
          });
      },
      () => epoch === this.confirmationEpoch,
    );
  }
  async toggleAutostart(): Promise<void> {
    if (!this.desktop.available || this.state.autostart === null) return;
    const desired = !this.state.autostart;
    await this.perform(
      "autostart",
      "write",
      () => this.desktop.setAutostart(desired),
      (autostart) => this.patch({ autostart }),
    );
  }
  async openDirectory(): Promise<void> {
    if (!this.desktop.available) return;
    await this.perform(
      "directory",
      "open",
      () => this.desktop.openDataDirectory(),
      () => {},
    );
  }
}
