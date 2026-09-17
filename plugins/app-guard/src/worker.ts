import { defineFacet } from "@earendil-works/chord";
import { Lifecycle } from "../../../sdk/index.ts";
import { PasswordPrompt } from "../../password-pad/contract.ts";
import { authorizationTitle } from "./policy.ts";

export default defineFacet({
  id: "com.chord.app-guard.worker",
  setup(env) {
    const password = env.use(PasswordPrompt);
    env.provide(Lifecycle, {
      async before(action, input, context) {
        const title = authorizationTitle(action, input);
        return title === undefined ? true : password.authorize(title, context);
      },
    });
  },
});
