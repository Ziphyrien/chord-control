import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PluginDiagnostics } from "../../../sdk/diagnostics.ts";
import { ControlHost } from "../../../sdk/index.ts";
import { WallpaperPolicy } from "./wallpaper.ts";

export default defineFacet({
  id: "com.chord.wallpaper-policy.worker",
  setup(env) {
    const host = env.use(ControlHost);
    const lifetime = new AbortController();
    let policy: WallpaperPolicy | undefined;
    let active = false;
    const since = new Date().toISOString();
    env.own(async () => {
      active = false;
      lifetime.abort();
      await policy?.restore();
    });
    env.onActivate(async () => {
      const paths = await host.paths(BACKGROUND_CONTEXT);
      policy = new WallpaperPolicy(host, paths.dataDir);
      try {
        await policy.apply();
        if (lifetime.signal.aborted) {
          await policy.restore();
          return;
        }
        active = true;
      } catch (error) {
        active = false;
        throw error;
      }
    });
    env.provide(PluginDiagnostics, {
      async snapshot() {
        if (!policy || !active) throw new Error("壁纸策略尚未启动");
        const result = await policy.measure();
        return {
          since,
          observedAt: new Date().toISOString(),
          lastError: result.errors.join("; ") || null,
          metrics: [
            { name: "policy.checks", kind: "gauge", value: result.checks, unit: "count" },
            { name: "policy.passed", kind: "gauge", value: result.passed, unit: "count" },
            {
              name: "policy.complianceRatio",
              kind: "gauge",
              value: result.checks ? result.passed / result.checks : null,
              unit: "ratio",
            },
            { name: "policy.owned", kind: "gauge", value: result.owned ? 1 : 0, unit: "boolean" },
          ],
        };
      },
    });
  },
});
