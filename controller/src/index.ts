import { join } from "node:path";
import { homedir } from "node:os";
import { Console } from "node:console";
import { ConfigStore } from "./infrastructure/config-store.ts";
import { ArchiveStore } from "./infrastructure/archives.ts";
import { SignedReleaseSource } from "./infrastructure/release-source.ts";
import { ChordRuntime } from "./runtime/chord-runtime.ts";
import { NativeBridge } from "./transport/native-bridge.ts";
import { PluginHttpServer } from "./transport/plugin-http.ts";
import { StdioTransport } from "./transport/stdio.ts";
import { ActivityLog, serialQueue } from "./application/execution.ts";
import { PluginService } from "./application/plugin-service.ts";
import { ControllerApplication } from "./application/controller.ts";
import { object } from "../../shared/validation.ts";

// The executable entry is the only module that owns process globals and transport wiring.
console = new Console({ stdout: process.stderr, stderr: process.stderr });
const root =
  process.env.CHORD_CONTROL_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? homedir(), "ChordControl");
const allowUnsigned = process.env.CHORD_CONTROL_ALLOW_UNSIGNED === "1";
const repository = new ConfigStore(root, allowUnsigned),
  archives = new ArchiveStore(root),
  source = new SignedReleaseSource(allowUnsigned);
const activity = new ActivityLog(),
  gate = serialQueue();
const native = new NativeBridge((value) => transport.emit(value));
const runtime = new ChordRuntime({
  staging: archives.staging,
  data: join(root, "data"),
  native,
  log: (id, detail) => activity.add("插件日志", `${id}: ${detail}`),
  present: async (id, visible) => {
    const plugin = repository.snapshot().plugins.find((item) => item.id === id);
    const title = plugin?.installed?.name ?? plugin?.available?.name ?? id;
    if (!visible) {
      ui.revoke(id);
      transport.emit({ type: "plugin_window", pluginId: id, title, visible });
      return;
    }
    const page = await ui.open(id);
    if (!object(page) || typeof page.url !== "string") throw new Error("插件 UI 地址无效");
    transport.emit({ type: "plugin_window", pluginId: id, title, visible, url: page.url });
  },
});
const ui = new PluginHttpServer(runtime, gate);
const plugins = new PluginService({
  repository,
  archives,
  source,
  runtime,
  gate,
  log: activity.add,
  allowUnsigned,
});
const app = new ControllerApplication({
  plugins,
  runtime,
  gate,
  activity,
  dataDir: root,
  openUi: (id) => ui.open(id),
  emit: (event) => transport.emit(event),
});
let closing: Promise<void> | undefined;
let ready: Promise<void> = Promise.resolve();
function stop(): void {
  if (closing) return;
  app.stop();
  source.close();
  const deadline = setTimeout(() => process.exit(1), 20_000);
  closing = (async () => {
    try {
      await ready.catch(() => undefined);
      await ui.close();
      await plugins.close();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      native.close();
      transport.close();
      clearTimeout(deadline);
      process.exit(process.exitCode ?? 0);
    }
  })();
}
const transport = new StdioTransport(process.stdin, process.stdout, {
  submit: async (id, command) => {
    await ready;
    await app.submit(id, command);
  },
  internal: (value) => native.receive(value),
  stop,
});
async function start(): Promise<void> {
  await repository.load();
  await archives.prepare();
  await ui.start();
  await plugins.restore();
  if (!repository.snapshot().plugins.some((item) => item.installed)) await plugins.checkUpdates();
  if (!closing) app.start();
}
transport.start();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
ready = start();
void ready.catch((error) => {
  console.error(error);
  process.exitCode = 1;
  stop();
});
