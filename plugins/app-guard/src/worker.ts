import { defineFacet } from "@earendil-works/chord";
import { Lifecycle } from "../../../sdk/index.ts";
import { PasswordPrompt } from "../../password-pad/contract.ts";
export default defineFacet({
  id: "com.chord.app-guard.worker",
  setup(env) {
    const password = env.use(PasswordPrompt);
    env.provide(Lifecycle, {
      async before(action, input, context) {
        if (action === "desktop.open") return password.authorize("打开控制中心", context);
        if (action === "desktop.quit") return password.authorize("退出控制器", context);
        if (action === "set_settings") return password.authorize("修改控制器设置", context);
        if (
          input &&
          typeof input === "object" &&
          !Array.isArray(input) &&
          ["com.chord.password-pad", "com.chord.app-guard", "com.chord.study-guard"].includes(
            String(input.pluginId),
          ) &&
          (action === "remove_plugin" || (action === "set_enabled" && input.enabled === false))
        )
          return password.authorize(
            action === "remove_plugin" ? "移除保护插件" : "暂停保护插件",
            context,
          );
        return true;
      },
    });
  },
});
