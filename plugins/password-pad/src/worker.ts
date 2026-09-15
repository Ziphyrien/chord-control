import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ControlHost, PluginUi } from "../../../sdk/index.ts";
import { PasswordPrompt } from "../contract.ts";
import { Challenges } from "./challenges.ts";
export default defineFacet({
  id: "com.chord.password-pad.worker",
  setup(env) {
    const host = env.use(ControlHost);
    let disposed = false;
    const challenges = new Challenges(() => {
      if (!disposed)
        void host.present(Boolean(challenges.view()), BACKGROUND_CONTEXT).catch(async (error) => {
          challenges.dispose();
          await host.log(String(error), BACKGROUND_CONTEXT);
        });
    });
    env.own(() => {
      disposed = true;
      challenges.dispose();
    });
    env.provide(PasswordPrompt, {
      async authorize(title, context) {
        if (typeof title !== "string") throw new Error("验证请求格式错误");
        return challenges.request(title, context.abortSignal);
      },
    });
    env.provide(PluginUi, {
      async call(method, input) {
        if (method === "challenge") return challenges.view();
        if (method === "window_closed") {
          challenges.dispose();
          return null;
        }
        if (method === "practice") {
          void challenges.request("试用密保盘");
          return challenges.view();
        }
        if (
          input &&
          typeof input === "object" &&
          !Array.isArray(input) &&
          typeof input.id === "string"
        ) {
          if (method === "submit") return { approved: challenges.submit(input.id, input.path) };
          if (method === "cancel") {
            challenges.cancel(input.id);
            return null;
          }
        }
        throw new Error("无效的密保盘操作");
      },
    });
  },
});
