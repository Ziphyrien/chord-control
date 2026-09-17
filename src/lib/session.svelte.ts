import { ControllerSession, type SessionState } from "./session.ts";

/** Only this bridge knows about Svelte reactivity; application transitions stay plain TypeScript. */
export class SessionView {
  state: SessionState;
  readonly session: ControllerSession;
  constructor(session: ControllerSession) {
    this.session = session;
    this.state = $state.raw(session.state);
  }
  start(): () => void {
    const unsubscribe = this.session.subscribe((state) => {
      this.state = state;
    });
    const stop = this.session.start();
    return () => {
      unsubscribe();
      stop();
    };
  }
}
