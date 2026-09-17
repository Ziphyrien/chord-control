import { defineFacet, type JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { hostname, platform, arch, totalmem, uptime } from "node:os";
import { ControlHost, PluginUi } from "../../../sdk/index.ts";
import { Notes } from "./notes.ts";

export default defineFacet({
  id: "com.example.system-info.worker",
  setup(env) {
    const host = env.use(ControlHost);
    let notes: Notes | undefined;
    let stopped = false;
    env.onActivate(async () => {
      const { dataDir } = await host.paths(BACKGROUND_CONTEXT);
      notes = new Notes(dataDir);
      await host.log("系统信息插件已启动", BACKGROUND_CONTEXT).catch(() => {});
    });
    env.own(async () => {
      stopped = true;
      await notes?.drain();
    });
    env.provide(PluginUi, {
      async call(method, input): Promise<JsonValue> {
        if (stopped || !notes) throw new Error("系统信息尚未就绪");
        switch (method) {
          case "info":
            return {
              hostname: hostname(),
              platform: platform(),
              arch: arch(),
              memoryGiB: Math.round(totalmem() / 1024 ** 3),
              uptimeMinutes: Math.floor(uptime() / 60),
            };
          case "read_note":
            return notes.read();
          case "save_note":
            await notes.save(input);
            return { saved: true };
          default:
            throw new Error(`未知方法: ${method}`);
        }
      },
    });
  },
});
