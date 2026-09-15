import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { ControlHost, PluginUi } from "../../../sdk/index.ts";
import { PasswordPrompt } from "../../password-pad/contract.ts";
import { createPlatform, type StudyPlatform, type Browser } from "./native.ts";
export default defineFacet({
  id: "com.chord.study-guard.worker",
  setup(env) {
    const host = env.use(ControlHost),
      password = env.use(PasswordPrompt),
      lifetime = new AbortController();
    const pending = new Set<Browser>();
    let platform: StudyPlatform | undefined,
      last = "",
      active = false;
    const log = (message: string) => {
      last = message;
      void host.log(message, BACKGROUND_CONTEXT).catch(() => {});
    };
    function request(browser: Browser): void {
      if (!active || pending.has(browser)) return;
      pending.add(browser);
      void (async () => {
        try {
          const allowed = await password.authorize(
            browser === "edge" ? "打开 Microsoft Edge" : "打开 Google Chrome",
            withAbortSignal(lifetime.signal, BACKGROUND_CONTEXT),
          );
          if (allowed && active) {
            await platform!.launch(browser);
            last = "已允许打开浏览器";
          } else last = "已取消打开浏览器";
        } catch (error) {
          log(error instanceof Error ? error.message : String(error));
        } finally {
          pending.delete(browser);
        }
      })();
    }
    env.own(async () => {
      active = false;
      lifetime.abort();
      await platform?.dispose();
    });
    env.onActivate(async () => {
      const paths = await host.paths(BACKGROUND_CONTEXT);
      platform = createPlatform(paths.dataDir, paths.bundleDir, log);
      active = true;
      await platform.start(request);
    });
    env.provide(PluginUi, {
      async call(method, input) {
        if (method === "status") return { active, pending: [...pending], last, requested: false };
        if (method === "open_browser" && (input === "edge" || input === "chrome")) {
          request(input);
          return { active, pending: [...pending], last, requested: true };
        }
        throw new Error("未知的学习权限操作");
      },
    });
  },
});
