import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { ControlHost, PluginUi } from "../../../sdk/index.ts";
import { HostDiagnostics, PluginDiagnostics } from "../../../sdk/diagnostics.ts";
import type { Json } from "../../../shared/protocol.ts";
import { message, object } from "../../../shared/validation.ts";
import { Reporter } from "./reporter.ts";
import { collectWindows } from "./windows.ts";

export default defineFacet({
  id: "com.chord.telemetry.worker",
  setup(env) {
    const host = env.use(ControlHost),
      diagnostics = env.use(HostDiagnostics);
    let reporter: Reporter | undefined;
    env.onActivate(async () => {
      const { dataDir, bundleDir } = await host.paths(BACKGROUND_CONTEXT);
      reporter = new Reporter(
        dataDir,
        async (signal) => {
          let snapshot: Json;
          try {
            snapshot = await diagnostics.snapshot(withAbortSignal(signal, BACKGROUND_CONTEXT));
          } catch (error) {
            snapshot = { error: message(error).slice(0, 1000) };
          }
          return {
            ...(object(snapshot) ? snapshot : { error: "宿主诊断未返回对象" }),
            windows: await collectWindows(bundleDir, snapshot, signal),
          };
        },
        (text) => host.log(text, BACKGROUND_CONTEXT),
      );
      await reporter.start();
    });
    env.own(() => reporter?.stop());
    env.provide(PluginDiagnostics, {
      snapshot: async () => {
        if (!reporter) throw new Error("尚未启动");
        return reporter.metrics();
      },
    });
    env.provide(PluginUi, {
      async call(method) {
        if (!reporter) throw new Error("遥测尚未启动");
        if (method === "send") void reporter.send();
        else if (method === "report") return reporter.report();
        else if (method !== "status") throw new Error("未知遥测操作");
        return reporter.status();
      },
    });
  },
});
