import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ControlHost, PluginUi } from "../../../sdk/index.ts";
import { PasswordPrompt } from "../contract.ts";
import { Challenges } from "./challenges.ts";

export default defineFacet({
  id: "com.chord.password-pad.worker",
  setup(env) {
    const host = env.use(ControlHost);
    let stopped = false;
    let shown: boolean | undefined;
    let presentation: Promise<void> = Promise.resolve();
    const challenges = new Challenges(() => {
      presentation = presentation.then(async () => {
        const visible = challenges.pending;
        if (stopped || shown === visible) return;
        try {
          await host.present(visible, BACKGROUND_CONTEXT);
          shown = visible;
        } catch (error) {
          shown = undefined;
          challenges.close();
          await host.log(`密保盘窗口: ${String(error)}`, BACKGROUND_CONTEXT).catch(() => {});
        }
      });
    });
    env.own(async () => {
      stopped = true;
      challenges.dispose();
      await presentation;
    });
    env.provide(PasswordPrompt, {
      authorize(title, context) {
        if (typeof title !== "string") return Promise.reject(new Error("验证请求格式错误"));
        return challenges.request(title, context.abortSignal);
      },
    });
    env.provide(PluginUi, {
      async call(method, input) {
        switch (method) {
          case "challenge":
            return challenges.view();
          case "window_closed":
            challenges.close();
            return null;
          case "submit": {
            if (
              !input ||
              typeof input !== "object" ||
              Array.isArray(input) ||
              typeof input.id !== "string"
            )
              throw new Error("验证提交格式错误");
            return { approved: challenges.submit(input.id, input.revision, input.sequence) };
          }
          default:
            throw new Error("无效的密保盘操作");
        }
      },
    });
  },
});
