// All credentials, request lifetimes, and polling belong to this in-memory session.
export function createSession({
  request = globalThis.fetch.bind(globalThis),
  onState = () => {},
  timers = { setTimeout, clearTimeout },
} = {}) {
  let token = "";
  let epoch = 0;
  let revision = 0;
  let disposed = false;
  let lifetime = new AbortController();
  let navigation = new AbortController();
  let pollTimer;
  let query = "";
  const empty = () => ({
    authenticated: false,
    view: "login",
    selected: null,
    list: null,
    detail: null,
    busy: false,
    error: "",
    requestStatus: "",
  });
  let state = empty();

  function publish(patch) {
    const previous = state;
    state = { ...state, ...patch };
    onState(state, previous);
  }
  function cancelNavigation() {
    revision++;
    navigation.abort();
    navigation = new AbortController();
    if (pollTimer !== undefined) timers.clearTimeout(pollTimer);
    pollTimer = undefined;
  }
  function reset() {
    epoch++;
    lifetime.abort();
    lifetime = new AbortController();
    cancelNavigation();
    token = "";
    query = "";
  }
  function begin(patch) {
    cancelNavigation();
    const scope = {
      epoch,
      revision,
      signal: AbortSignal.any([lifetime.signal, navigation.signal]),
    };
    publish({ error: "", busy: true, requestStatus: "", ...patch });
    return scope;
  }
  function current(scope) {
    return (
      !disposed && scope.epoch === epoch && scope.revision === revision && !scope.signal.aborted
    );
  }
  async function api(scope, path, options = {}) {
    const response = await request(path, {
      ...options,
      signal: scope.signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!current(scope)) return;
    const result = await response.json();
    if (!current(scope)) return;
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
  }
  async function run(scope, task, collecting = false) {
    try {
      await task();
    } catch (error) {
      if (current(scope)) {
        publish({
          error: error instanceof TypeError ? "连接已断开" : String(error.message ?? error),
          ...(collecting ? { requestStatus: "稍后刷新查看结果" } : {}),
        });
      }
    } finally {
      if (current(scope)) publish({ busy: false });
    }
  }
  const devicePath = (id) => `/api/devices/${encodeURIComponent(id)}`;
  async function loadList(scope) {
    const result = await api(scope, `/api/devices?q=${encodeURIComponent(query)}`);
    if (current(scope)) publish({ authenticated: true, view: "list", list: result });
  }
  function list(nextQuery = query) {
    if (disposed || !token) return Promise.resolve();
    query = nextQuery;
    const scope = begin({
      selected: null,
      detail: null,
      list: null,
      view: state.authenticated ? "list" : "login",
    });
    return run(scope, () => loadList(scope));
  }
  function login(nextToken, nextQuery = "") {
    if (disposed) return Promise.resolve();
    reset();
    publish(empty());
    token = nextToken;
    return list(nextQuery);
  }
  function detail(id) {
    if (disposed || !token || !state.authenticated) return Promise.resolve();
    const scope = begin({ selected: id, view: "detail", detail: null, list: null });
    return run(scope, async () => {
      const result = await api(scope, devicePath(id));
      if (current(scope)) publish({ detail: result });
    });
  }
  function setTrust(id, trusted, label) {
    if (disposed || !token || !state.authenticated) return Promise.resolve();
    const scope = begin({ selected: null, detail: null, view: "list" });
    return run(scope, async () => {
      await api(scope, `${devicePath(id)}/trust`, {
        method: "POST",
        body: JSON.stringify({ trusted, label }),
      });
      if (current(scope)) await loadList(scope);
    });
  }
  function requestReport() {
    const id = state.selected;
    if (disposed || !token || !id || !state.detail) return Promise.resolve();
    const scope = begin({ requestStatus: "正在采集…" });
    let attempts = 0;
    function schedule(delay) {
      if (!current(scope)) return;
      pollTimer = timers.setTimeout(() => {
        if (!current(scope)) return;
        pollTimer = undefined;
        return run(scope, poll, true);
      }, delay);
    }
    async function poll() {
      const next = await api(scope, `${devicePath(id)}/live`);
      if (!current(scope)) return;
      attempts++;
      if (!next.pending) {
        const result = await api(scope, devicePath(id));
        if (current(scope)) publish({ detail: result, requestStatus: "采集完成" });
      } else if (attempts < 15) {
        publish({ requestStatus: next.connected ? "正在采集…" : "等待设备连接" });
        schedule(2000);
      } else {
        publish({ requestStatus: "稍后刷新查看结果" });
      }
    }
    return run(
      scope,
      async () => {
        const result = await api(scope, `${devicePath(id)}/request-report`, { method: "POST" });
        if (!current(scope)) return;
        publish({ requestStatus: result.connected ? "正在采集…" : "等待设备连接" });
        schedule(1500);
      },
      true,
    );
  }
  function cancel() {
    if (disposed) return;
    cancelNavigation();
    publish({
      selected: null,
      detail: null,
      list: null,
      busy: false,
      requestStatus: "",
      error: "",
    });
  }
  function logout() {
    if (disposed) return;
    reset();
    publish(empty());
  }
  function dispose() {
    if (disposed) return;
    reset();
    disposed = true;
    publish(empty());
  }
  onState(state, state);
  return { login, list, detail, setTrust, requestReport, cancel, logout, dispose };
}
