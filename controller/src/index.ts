import { join } from "node:path";
import { homedir } from "node:os";
import { Console } from "node:console";
import { ConfigStore } from "./config.ts";
import { ArchiveStore } from "./storage.ts";
import { PluginRuntime } from "./runtime.ts";
import { PluginUiServer } from "./ui-server.ts";
import { PluginManager } from "./plugin-manager.ts";
import { ActivityLog } from "./activity.ts";
import { ControllerApplication } from "./application.ts";
import { createSerialQueue } from "./queue.ts";
import { bindStdio } from "./stdio.ts";

// Keep plugin console output separate from the control protocol.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
const root =
  process.env.CHORD_CONTROL_DATA_DIR ??
  (process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "ChordControl")
    : join(homedir(), ".chord-control"));
const activity = new ActivityLog();
const repository = new ConfigStore(root);
const archives = new ArchiveStore(join(root, "artifacts"), join(root, "staging"));
const runtime = new PluginRuntime(
  archives.staging,
  join(root, "data"),
  (id, message) => activity.add("插件日志", `${id}: ${message}`),
  async (id, visible) => {
    const plugin = repository.value.plugins.find((entry) => entry.id === id);
    const title = plugin?.installed?.name ?? plugin?.latest?.name ?? id;
    if (!visible) {
      process.stdout.write(
        `${JSON.stringify({ type: "plugin_window", pluginId: id, title, visible })}\n`,
      );
      return;
    }
    const page = await ui.open(id);
    if (page && typeof page === "object" && !Array.isArray(page) && typeof page.url === "string")
      process.stdout.write(
        `${JSON.stringify({ type: "plugin_window", pluginId: id, title, visible, url: page.url })}\n`,
      );
  },
);
const enqueue = createSerialQueue();
const ui = new PluginUiServer(runtime, enqueue);
const plugins = new PluginManager(repository, archives, runtime, (title, detail, tone) =>
  activity.add(title, detail, tone),
);
const app = new ControllerApplication({
  plugins,
  ui: runtime,
  openUi: (id) => ui.open(id),
  activity,
  enqueue,
  dataDir: root,
  emit: (event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  },
});
let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  app.stop();
  ui.close();
  const deadline = setTimeout(() => process.exit(0), 5000);
  void enqueue(() => runtime.dispose()).finally(() => {
    clearTimeout(deadline);
    process.exit(0);
  });
}
async function main(): Promise<void> {
  await repository.load();
  await archives.prepare();
  await ui.start();
  await plugins.restoreAll();
  await plugins.checkUpdates();
  activity.add(
    "已启动",
    `${plugins.summaries().filter((plugin) => plugin.running).length} 个插件运行中`,
  );
  bindStdio(app, stop);
  app.start();
}
void main().catch((error) => {
  app.report(error);
  ui.close();
  process.exitCode = 1;
});
