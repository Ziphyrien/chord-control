import { defineFacet, type JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { hostname, platform, arch, totalmem, uptime } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ControlHost, PluginUi } from "../../../sdk/index.ts";

export default defineFacet({
  id: "com.example.system-info.worker",
  setup(env) {
    const host = env.use(ControlHost);
    let dataDir = "";
    env.onActivate(async () => {
      dataDir = (await host.paths(BACKGROUND_CONTEXT)).dataDir;
      await host.log("系统信息插件已启动", BACKGROUND_CONTEXT);
    });
    env.provide(PluginUi, {
      async call(method, input): Promise<JsonValue> {
        if (method === "info")
          return {
            hostname: hostname(),
            platform: platform(),
            arch: arch(),
            memoryGiB: Math.round(totalmem() / 1024 ** 3),
            uptimeMinutes: Math.floor(uptime() / 60),
          };
        if (method === "read_note") {
          try {
            return await readFile(join(dataDir, "note.txt"), "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
            throw error;
          }
        }
        if (method === "save_note") {
          if (typeof input !== "string" || input.length > 10000)
            throw new Error("便笺最多 10000 个字符");
          await writeFile(join(dataDir, "note.txt"), input, "utf8");
          return { saved: true };
        }
        throw new Error(`未知方法: ${method}`);
      },
    });
  },
});
