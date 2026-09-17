import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type {
  ControllerCommand,
  ControllerEvent,
  ControllerSnapshot,
  Json,
  PluginSummary,
} from "../../shared/protocol.ts";
import { CommandError, ConnectionError, createControllerClient } from "./controller.ts";
import { browserDesktop, type DesktopAdapter } from "./desktop.ts";
import { decodeControllerEvent } from "./events.ts";
import { ControllerSession } from "./session.ts";

// Native Node TypeScript execution: no bundler, Svelte transform or generated artifact.
function plugin(id: string, patch: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id,
    name: id,
    description: "",
    version: "1.0.0",
    revision: "r1",
    status: "active",
    running: true,
    installed: true,
    enabled: true,
    hasUpdate: false,
    hasUi: true,
    source: "manual",
    sourceStatus: "available",
    permissions: [],
    updatedAt: "",
    icon: "",
    color: "",
    ...patch,
  };
}
function snapshot(): ControllerSnapshot {
  return {
    plugins: [
      plugin("base", {
        dependents: [
          { id: "notes", name: "便笺" },
          { id: "daily", name: "日程" },
        ],
      }),
      plugin("notes"),
      plugin("daily"),
    ],
    activities: [],
    checkedAt: null,
    startedAt: "2026-01-01T00:00:00Z",
    controllerVersion: "test",
    dataDir: "test-data",
    settings: { checkIntervalMinutes: 30, autoUpdate: true, catalogUrl: "", catalogPublicKey: "" },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function sessionHarness(t: TestContext, desktop: DesktopAdapter = browserDesktop) {
  const callbacks: ((event: ControllerEvent) => void)[] = [];
  const commands: ControllerCommand[] = [];
  let disposed = 0;
  let handler: (command: ControllerCommand) => Promise<Json> = async () => null;
  const session = new ControllerSession(
    {
      async connect(receive) {
        callbacks.push(receive);
        receive({ type: "snapshot", snapshot: snapshot() });
        return () => {
          disposed++;
        };
      },
      send(command) {
        commands.push(command);
        return handler(command);
      },
    },
    desktop,
  );
  const stop = session.start();
  t.after(stop);
  await tick();
  return {
    session,
    stop,
    callbacks,
    commands,
    disposed: () => disposed,
    handle(next: typeof handler) {
      handler = next;
    },
    emit(event: ControllerEvent) {
      callbacks.at(-1)!(event);
    },
  };
}
async function clientHarness(t: TestContext, timeout = 1_000) {
  const commands: (ControllerCommand & { id: string })[] = [];
  const events: ControllerEvent[] = [];
  let receive!: (event: ControllerEvent) => void;
  let disposed = 0;
  let dispatch: (command: ControllerCommand & { id: string }) => Promise<void> = async () => {};
  const client = createControllerClient(
    {
      async subscribe(callback) {
        receive = callback;
        return () => {
          disposed++;
        };
      },
      async dispatch(command) {
        commands.push(command);
        if (command.type === "snapshot")
          receive({ type: "response", id: command.id, ok: true, result: null });
        else await dispatch(command);
      },
    },
    timeout,
  );
  const stop = await client.connect((event) => events.push(event));
  t.after(stop);
  await tick();
  return {
    client,
    commands,
    events,
    stop,
    disposed: () => disposed,
    emit(event: ControllerEvent) {
      receive(event);
    },
    dispatch(next: typeof dispatch) {
      dispatch = next;
    },
  };
}

test("decoder accepts source states and validates every rendered nested field", () => {
  for (const sourceStatus of ["available", "missing", "detached"] as const) {
    const value = snapshot();
    value.plugins[0] = plugin("base", {
      sourceStatus,
      status: "blocked",
      blockedReason: "依赖未启用",
    });
    const event = decodeControllerEvent(JSON.stringify({ type: "snapshot", snapshot: value }));
    assert.equal(event.type, "snapshot");
    if (event.type === "snapshot")
      assert.equal(event.snapshot.plugins[0].sourceStatus, sourceStatus);
  }
  const invalid = [
    { running: "yes" },
    { status: "unknown" },
    { sourceStatus: "unknown" },
    { sourceStatus: undefined },
    { permissions: [null] },
    { dependents: [{ id: "base", name: "self" }] },
    {
      dependents: [
        { id: "x", name: "one" },
        { id: "x", name: "two" },
      ],
    },
    { name: "bad\0name" },
  ];
  for (const patch of invalid)
    assert.throws(() =>
      decodeControllerEvent(
        JSON.stringify({
          type: "snapshot",
          snapshot: {
            ...snapshot(),
            plugins: [{ ...plugin("base"), ...patch }],
          },
        }),
      ),
    );
  assert.throws(() =>
    decodeControllerEvent(
      JSON.stringify({
        type: "snapshot",
        snapshot: { ...snapshot(), plugins: [plugin("x"), plugin("x")] },
      }),
    ),
  );
  assert.throws(() =>
    decodeControllerEvent('{"type":"response","id":"x","ok":"true","result":null}'),
  );
  assert.throws(() => decodeControllerEvent('{"type":"response","id":"x","ok":true}'));
  assert.throws(() => decodeControllerEvent('{"type":"unknown"}'));
  assert.throws(() => decodeControllerEvent("null"));
});

test("invoke business rejection leaves other requests and connection alive", async (t) => {
  const h = await clientHarness(t);
  h.dispatch(async (command) => {
    if (command.type === "install") throw new Error("控制中心尚未解锁");
  });
  const waiting = h.client.send({ type: "check_updates" });
  await assert.rejects(h.client.send({ type: "install", pluginId: "base" }), CommandError);
  assert.equal(h.disposed(), 0);
  assert.deepEqual(h.events, []);
  const request = h.commands.find((item) => item.type === "check_updates")!;
  h.emit({ type: "response", id: request.id, ok: true, result: { failures: 0 } });
  assert.deepEqual(await waiting, { failures: 0 });
});

test("wire business failure rejects only its request and ignores late duplicate responses", async (t) => {
  const h = await clientHarness(t);
  const pending = h.client.send({ type: "install", pluginId: "base" });
  const rejected = assert.rejects(pending, CommandError);
  await tick();
  const id = h.commands.at(-1)!.id;
  h.emit({ type: "response", id, ok: false, message: "依赖未启用" });
  await rejected;
  h.emit({ type: "response", id, ok: true, result: null });
  assert.deepEqual(h.events, []);
  assert.equal(h.disposed(), 0);
});

test("explicit transport failure rejects every pending request and disconnects once", async (t) => {
  const h = await clientHarness(t);
  h.dispatch(async (command) => {
    if (command.type === "install") throw new ConnectionError("pipe closed");
  });
  const first = assert.rejects(h.client.send({ type: "check_updates" }), ConnectionError);
  const second = assert.rejects(
    h.client.send({ type: "install", pluginId: "base" }),
    ConnectionError,
  );
  await Promise.all([first, second]);
  assert.equal(h.disposed(), 1);
  assert.deepEqual(h.events, [{ type: "disconnected", message: "pipe closed" }]);
  await assert.rejects(h.client.send({ type: "snapshot" }), ConnectionError);
});

test("client timeout is a command error and cleanup rejects pending work", async (t) => {
  const h = await clientHarness(t, 10);
  await assert.rejects(h.client.send({ type: "check_updates" }), CommandError);
  assert.equal(h.disposed(), 0);
  const rejection = assert.rejects(
    h.client.send({ type: "install", pluginId: "base" }),
    ConnectionError,
  );
  h.stop();
  await rejection;
  assert.equal(h.disposed(), 1);
  assert.deepEqual(h.events, []);
});

test("a late transport subscription cleans itself up after a newer connection", async (t) => {
  const subscription = deferred<() => void>();
  const callbacks: ((event: ControllerEvent) => void)[] = [];
  let disposed = 0;
  const client = createControllerClient({
    subscribe(receive) {
      callbacks.push(receive);
      return callbacks.length === 1
        ? subscription.promise
        : Promise.resolve(() => {
            disposed++;
          });
    },
    async dispatch(command) {
      callbacks.at(-1)!({ type: "response", id: command.id, ok: true, result: null });
    },
  });
  const oldEvents: ControllerEvent[] = [];
  const first = client.connect((event) => oldEvents.push(event));
  const stop = await client.connect(() => {});
  t.after(stop);
  subscription.resolve(() => {
    disposed++;
  });
  await first;
  callbacks[0]({ type: "snapshot", snapshot: snapshot() });
  assert.equal(disposed, 1);
  assert.deepEqual(oldEvents, []);
});

test("session disposes late connection setup and ignores callbacks after stop", async () => {
  const subscription = deferred<() => void>();
  let receive!: (event: ControllerEvent) => void;
  let disposed = 0;
  const session = new ControllerSession(
    {
      connect(callback) {
        receive = callback;
        return subscription.promise;
      },
      async send() {
        return null;
      },
    },
    browserDesktop,
  );
  const stop = session.start();
  await tick();
  stop();
  receive({ type: "snapshot", snapshot: snapshot() });
  subscription.resolve(() => {
    disposed++;
  });
  await tick();
  assert.equal(disposed, 1);
  assert.equal(session.state.snapshot, null);
});

test("independent desktop operations cannot clear controller pending state", async (t) => {
  const directory = deferred<void>();
  const autostart = deferred<boolean>();
  const mutation = deferred<Json>();
  const h = await sessionHarness(t, {
    available: true,
    async autostart() {
      return false;
    },
    setAutostart() {
      return autostart.promise;
    },
    openDataDirectory() {
      return directory.promise;
    },
  });
  h.handle(() => mutation.promise);
  const saving = h.session.run({ type: "set_settings", settings: snapshot().settings });
  const toggle = h.session.toggleAutostart();
  const opening = h.session.openDirectory();
  assert.deepEqual(h.session.state.pending, {
    mutation: "set_settings",
    autostart: "write",
    directory: "open",
  });
  assert.equal(await h.session.run({ type: "check_updates" }), false);
  directory.resolve();
  await opening;
  assert.deepEqual(h.session.state.pending, { mutation: "set_settings", autostart: "write" });
  autostart.resolve(true);
  await toggle;
  assert.equal(h.session.state.autostart, true);
  assert.deepEqual(h.session.state.pending, { mutation: "set_settings" });
  mutation.resolve(null);
  assert.equal(await saving, true);
  assert.deepEqual(h.session.state.pending, {});
});

test("reconnect ignores old mutation and desktop results and old events", async (t) => {
  const reads = [deferred<boolean>(), deferred<boolean>()];
  let read = 0;
  const mutation = deferred<Json>();
  const h = await sessionHarness(t, {
    available: true,
    autostart: () => reads[read++].promise,
    async setAutostart(value) {
      return value;
    },
    async openDataDirectory() {},
  });
  h.handle(() => mutation.promise);
  const running = h.session.run({ type: "check_updates" }, "old success");
  h.session.reconnect();
  await tick();
  const current = h.session.state.snapshot;
  h.callbacks[0]({ type: "snapshot", snapshot: { ...snapshot(), plugins: [] } });
  mutation.resolve(null);
  reads[0].resolve(true);
  assert.equal(await running, false);
  await tick();
  assert.equal(h.session.state.snapshot, current);
  assert.equal(h.session.state.autostart, null);
  assert.equal(h.session.state.notice, "");
  assert.equal(h.session.state.pending.autostart, "read");
  reads[1].resolve(false);
  await tick();
  assert.equal(h.session.state.autostart, false);
  assert.equal(h.disposed(), 1);
});

test("closed and replaced panel requests cannot change the current panel or pending token", async (t) => {
  const h = await sessionHarness(t);
  const old = deferred<Json>();
  const fresh = deferred<Json>();
  h.handle((command) =>
    command.type === "plugin_ui" && command.pluginId === "base" ? old.promise : fresh.promise,
  );
  const first = h.session.open(plugin("base"));
  h.session.closePanel();
  const second = h.session.open(plugin("notes"));
  old.resolve({ url: "https://plugins.test/old", revision: "r1" });
  await first;
  assert.deepEqual(h.session.state.panel, null);
  assert.equal(h.session.state.pending.panel, "notes");
  assert.equal(h.session.state.opening, "notes");
  fresh.resolve({ url: "https://plugins.test/new", revision: "r1" });
  await second;
  assert.deepEqual(h.session.state.panel, {
    pluginId: "notes",
    name: "notes",
    url: "https://plugins.test/new",
    revision: "r1",
  });
  assert.deepEqual(h.session.state.pending, {});
});

test("panel refuses unsafe addresses and stale revisions and closes on lost UI support", async (t) => {
  const h = await sessionHarness(t);
  const invalid: Json[] = [
    { url: "javascript:alert(1)", revision: "r1" },
    { url: "https://plugins.test/", revision: "old" },
    { url: "https://plugins.test/" },
  ];
  for (const result of invalid) {
    h.handle(async () => result);
    await h.session.open(plugin("base"));
    assert.equal(h.session.state.panel, null);
    assert.ok(h.session.state.errors.panel);
  }
  h.handle(async () => ({ url: "https://plugins.test/", revision: "r1" }));
  await h.session.open(plugin("base"));
  const next = snapshot();
  next.plugins[0].hasUi = false;
  h.emit({ type: "snapshot", snapshot: next });
  assert.equal(h.session.state.panel, null);
});

test("changed downstream set rejects the old approval before sending and requires another click", async (t) => {
  const h = await sessionHarness(t);
  h.session.requestChange(h.session.state.snapshot!.plugins[0], "disable");
  const next = snapshot();
  next.plugins[0].dependents = [{ id: "notes", name: "便笺" }];
  h.emit({ type: "snapshot", snapshot: next });
  await h.session.confirmChange();
  assert.equal(h.commands.length, 0);
  assert.match(h.session.state.errors.mutation, /重新确认/);
  assert.deepEqual(h.session.state.confirmation?.dependents, next.plugins[0].dependents);
  await h.session.confirmChange();
  assert.deepEqual(h.commands, [
    { type: "set_enabled", pluginId: "base", enabled: false, affectedPluginIds: ["notes"] },
  ]);
  assert.equal(h.session.state.confirmation, null);
});

test("remove sends exact approved IDs including transitive dependents, independent of snapshot order", async (t) => {
  const h = await sessionHarness(t);
  h.session.requestChange(h.session.state.snapshot!.plugins[0], "remove");
  const next = snapshot();
  next.plugins[0].dependents!.reverse();
  h.emit({ type: "snapshot", snapshot: next });
  await h.session.confirmChange();
  assert.deepEqual(h.commands, [
    { type: "remove_plugin", pluginId: "base", affectedPluginIds: ["notes", "daily"] },
  ]);
  assert.equal(h.session.state.confirmation, null);
});

test("failed group command and failed refresh cannot reuse approval or automatically mutate", async (t) => {
  const h = await sessionHarness(t);
  let rejectChange = true;
  let publish = false;
  h.handle(async (command) => {
    if (command.type === "snapshot") {
      if (publish) {
        const next = snapshot();
        next.plugins[0].dependents = [];
        h.emit({ type: "snapshot", snapshot: next });
      }
      return null;
    }
    if (rejectChange) throw new Error("依赖关系已变化");
    return null;
  });
  h.session.requestChange(h.session.state.snapshot!.plugins[0], "remove");
  await h.session.confirmChange();
  assert.equal(h.session.state.confirmation?.needsRefresh, true);
  assert.match(h.session.state.errors.refresh, /最新插件名单/);
  await h.session.confirmChange();
  assert.equal(h.commands.filter((command) => command.type === "remove_plugin").length, 1);
  publish = true;
  await h.session.confirmChange();
  assert.equal(h.session.state.confirmation?.needsRefresh, false);
  assert.deepEqual(h.session.state.confirmation?.dependents, []);
  assert.equal(h.commands.filter((command) => command.type === "remove_plugin").length, 1);
  rejectChange = false;
  await h.session.confirmChange();
  assert.deepEqual(h.commands.at(-1), {
    type: "remove_plugin",
    pluginId: "base",
    affectedPluginIds: [],
  });
  assert.equal(h.session.state.confirmation, null);
});

test("cancelled confirmation ignores late failures and does not refresh or reopen", async (t) => {
  const h = await sessionHarness(t);
  const mutation = deferred<Json>();
  h.handle(() => mutation.promise);
  h.session.requestChange(h.session.state.snapshot!.plugins[0], "remove");
  const confirming = h.session.confirmChange();
  h.session.closeConfirmation();
  mutation.reject(new Error("old rejection"));
  await confirming;
  assert.equal(h.session.state.confirmation, null);
  assert.deepEqual(h.session.state.errors, {});
  assert.deepEqual(h.session.state.pending, {});
  assert.equal(h.commands.length, 1);
});

test("enabling requests only the explicit target and reports dependency rejection without disconnect", async (t) => {
  const h = await sessionHarness(t);
  h.handle(async () => {
    throw new Error("请先启用依赖插件");
  });
  assert.equal(
    await h.session.run({ type: "set_enabled", pluginId: "notes", enabled: true }),
    false,
  );
  assert.deepEqual(h.commands, [{ type: "set_enabled", pluginId: "notes", enabled: true }]);
  assert.equal(h.session.state.connection, "online");
  assert.equal(h.session.state.errors.mutation, "请先启用依赖插件");
  assert.deepEqual(h.session.state.pending, {});
});

test("disconnect clears transient UI and startup never requests a guarded desktop action", async (t) => {
  const h = await sessionHarness(t);
  h.session.requestChange(h.session.state.snapshot!.plugins[0], "disable");
  h.emit({ type: "disconnected", message: "offline" });
  assert.equal(h.session.state.connection, "offline");
  assert.equal(h.session.state.confirmation, null);
  assert.equal(h.session.state.panel, null);
  assert.deepEqual(h.session.state.pending, {});
  assert.equal(await h.session.run({ type: "check_updates" }), false);
  h.session.requestChange(plugin("base"), "remove");
  assert.equal(h.session.state.confirmation, null);
  assert.deepEqual(h.commands, []);
});
