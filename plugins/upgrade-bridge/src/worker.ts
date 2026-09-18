import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { ControlHost } from "../../../sdk/index.ts";
import { installedApplication } from "./installation.ts";
import { message } from "../../../shared/validation.ts";
import { latest, needed, prepare, launch, type UpdaterConfig } from "./upgrade.ts";

declare const __CHORD_APP_UPDATER__: UpdaterConfig;

export default defineFacet({
  id: "com.chord.upgrade-bridge.worker",
  setup(env) {
    const host = env.use(ControlHost);
    const lifetime = new AbortController();
    const context = withAbortSignal(lifetime.signal, BACKGROUND_CONTEXT);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<void> | undefined;
    let launched = false;
    let failures = 0;
    async function attempt(): Promise<void> {
      try {
        if (process.platform !== "win32" || process.arch !== "x64")
          throw new Error("升级助手仅支持 Windows x64");
        const installation = await installedApplication(process.execPath, lifetime.signal);
        const release = await latest(__CHORD_APP_UPDATER__, lifetime.signal);
        if (needed(installation.version, release)) {
          await host.log(`正在准备主程序 ${release.version}`, context);
          const installer = await prepare(
            release,
            __CHORD_APP_UPDATER__,
            join(tmpdir(), "ChordControl-updates"),
            lifetime.signal,
          );
          launched = true;
          try {
            await launch(installer, installation.directory, lifetime.signal, (error) => {
              launched = false;
              void host.log(message(error), context).catch(() => {});
              timer = setTimeout(start, 5 * 60_000);
            });
          } catch (error) {
            launched = false;
            throw error;
          }
        }
        failures = 0;
      } catch (error) {
        failures = Math.min(failures + 1, 4);
        if (!lifetime.signal.aborted)
          await host.log(`主程序升级: ${message(error)}`, context).catch(() => {});
      } finally {
        if (!lifetime.signal.aborted && !launched)
          timer = setTimeout(start, Math.min(5 * 60_000 * 2 ** failures, 60 * 60_000));
      }
    }
    function start() {
      pending = attempt();
    }
    env.onActivate(() => {
      timer = setTimeout(start, 1000);
    });
    env.own(async () => {
      lifetime.abort();
      clearTimeout(timer);
      await pending;
    });
  },
});
