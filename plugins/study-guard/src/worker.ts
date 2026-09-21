import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { PluginDiagnostics } from "../../../sdk/diagnostics.ts";
import { ControlHost, PluginUi } from "../../../sdk/index.ts";
import { message } from "../../../shared/validation.ts";
import { PasswordPrompt } from "@chord-control/contracts/password";
import { createPlatform, type StudyPlatform, type Browser } from "./native.ts";

export default defineFacet({
  id: "com.chord.study-guard.worker",
  setup(env) {
    const host = env.use(ControlHost);
    const password = env.use(PasswordPrompt);
    const lifetime = new AbortController();
    const pending = new Map<Browser, Promise<void>>();
    let platform: StudyPlatform | undefined;
    let active = false;
    let last = "";
    let lastError: string | null = null;
    const since = new Date().toISOString();
    const status = () => ({ active, pending: [...pending.keys()], last });
    const log = (message: string) => {
      last = message;
      lastError = message;
      void host.log(message, BACKGROUND_CONTEXT).catch(() => {});
    };
    function request(browser: Browser): boolean {
      if (!active || pending.has(browser)) return false;
      const task = (async () => {
        try {
          const approved = await password.authorize(
            browser === "edge" ? "打开 Microsoft Edge" : "打开 Google Chrome",
            withAbortSignal(lifetime.signal, BACKGROUND_CONTEXT),
          );
          if (approved && active && !lifetime.signal.aborted) {
            await platform!.launch(browser);
            last = "已允许打开浏览器";
          } else if (active) last = "未通过浏览器验证";
        } catch (error) {
          log(message(error));
        } finally {
          pending.delete(browser);
        }
      })();
      pending.set(browser, task);
      return true;
    }
    env.own(async () => {
      active = false;
      lifetime.abort();
      // Stop monitoring immediately; authorization replies cannot restart the platform.
      await platform?.dispose();
    });
    env.onActivate(async () => {
      platform = createPlatform(host, log);
      try {
        await platform.start((browser) => {
          request(browser);
        });
        active = !lifetime.signal.aborted;
      } catch (error) {
        active = false;
        throw error;
      }
    });
    env.provide(PluginDiagnostics, {
      async snapshot() {
        if (!platform) throw new Error("浏览器保护尚未启动");
        return {
          since,
          observedAt: new Date().toISOString(),
          lastError,
          metrics: [
            { name: "browser.monitoring", kind: "gauge", value: active ? 1 : 0, unit: "boolean" },
            { name: "authorization.pending", kind: "gauge", value: pending.size, unit: "count" },
          ],
        };
      },
    });
    env.provide(PluginUi, {
      async call(method, input) {
        if (method === "status") return { ...status(), requested: false };
        if (method === "open_browser" && (input === "edge" || input === "chrome")) {
          const requested = request(input);
          return { ...status(), requested };
        }
        throw new Error("未知的浏览器保护操作");
      },
    });
  },
});
