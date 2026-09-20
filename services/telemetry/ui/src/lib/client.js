import { createSession } from "./session.js";

// Routing is supplied by the shell; transport and timers remain injectable.
export function createClient({ onState = () => {}, ...transport } = {}) {
  let state;
  let destination = { id: null, query: "" };
  let credentials = 0;
  const session = createSession({
    ...transport,
    onState(next, previous) {
      state = next;
      onState(next, previous);
    },
  });
  function load() {
    return destination.id ? session.detail(destination.id) : session.list(destination.query);
  }
  return {
    session,
    route(next) {
      destination = next;
      if (state.authenticated) return load();
    },
    cancel() {
      if (state.authenticated) session.cancel();
    },
    async login(token) {
      const generation = ++credentials;
      const query = destination.query;
      await session.login(token, query);
      if (generation !== credentials || !state.authenticated) return;
      if (destination.id || destination.query !== query) await load();
    },
    logout() {
      credentials++;
      session.logout();
    },
    dispose() {
      credentials++;
      session.dispose();
    },
  };
}
