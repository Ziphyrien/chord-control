import { test, vi } from "vite-plus/test";
import { createPlatform } from "../plugins/study-guard/src/native.ts";
import { deferred } from "./helpers.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserGate, identity, snapshot } from "../plugins/study-guard/src/browsers.ts";
import { authorizationTitle } from "../plugins/app-guard/src/policy.ts";
import { Notes } from "../plugins/system-info/src/notes.ts";
const browser = (pid, createdAt = `time-${pid}`, parentPid = 0) => ({
  pid,
  createdAt,
  parentPid,
  name: "chrome.exe",
  executable: "C:\\Chrome\\chrome.exe",
});

test("browser snapshots preserve baseline processes and require exact new identities", () => {
  const gate = new BrowserGate();
  const initial = browser(1);
  gate.initialize([initial]);
  assert.deepEqual(gate.blocked([initial, browser(2, "child", 1)]), []);
  assert.deepEqual(gate.blocked([initial, browser(3)]), [browser(3)]);
  assert.deepEqual(gate.blocked([browser(1, "reused-pid")]), [browser(1, "reused-pid")]);
  assert.deepEqual(
    gate.blocked([browser(1, "reused-pid")]),
    [browser(1, "reused-pid")],
    "failed termination must retry",
  );
});

test("one authorized browser spawn never exempts another concurrent browser", () => {
  const gate = new BrowserGate();
  gate.initialize([]);
  gate.authorize(identity(browser(10)));
  assert.deepEqual(gate.blocked([browser(10), browser(11, "child", 10), browser(20)]), [
    browser(20),
  ]);
  assert.deepEqual(
    gate.blocked([browser(11, "child", 10)]),
    [],
    "an approved child survives parent exit",
  );
  assert.deepEqual(gate.blocked([browser(10, "different-time")]), [browser(10, "different-time")]);
  gate.authorize(identity(browser(30)));
  gate.blocked([]);
  assert.deepEqual(gate.blocked([browser(30)]), [browser(30)], "unused grants do not linger");
});

test("native snapshot validation rejects malformed or unrelated processes", () => {
  assert.deepEqual(snapshot([browser(7)]), [browser(7)]);
  for (const row of [
    null,
    { ...browser(1), pid: -1 },
    { ...browser(1), createdAt: "" },
    { ...browser(1), name: "cmd.exe" },
    { ...browser(1), parentPid: "1" },
  ])
    assert.throws(() => snapshot([row]));
});

test("generic guard hooks authorize desktop/settings and affected protected plugins", () => {
  for (const action of ["desktop.open", "desktop.quit", "set_settings"])
    assert.equal(typeof authorizationTitle(action, null), "string");
  for (const pluginId of [
    "com.chord.password-pad",
    "com.chord.app-guard",
    "com.chord.study-guard",
  ]) {
    assert.equal(typeof authorizationTitle("set_enabled", { pluginId, enabled: false }), "string");
    assert.equal(typeof authorizationTitle("remove_plugin", { pluginId }), "string");
    assert.equal(authorizationTitle("set_enabled", { pluginId, enabled: true }), undefined);
    assert.equal(
      typeof authorizationTitle("remove_plugin", {
        pluginId: "other.provider",
        affectedPluginIds: [pluginId],
      }),
      "string",
    );
  }
  for (const input of [null, [], "x", { pluginId: "other" }, { pluginId: "toString" }])
    assert.equal(authorizationTitle("remove_plugin", input), undefined);
  assert.equal(authorizationTitle("window_closed", null), undefined);
});

async function notesFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "chord-notes-test-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return { directory, notes: new Notes(directory) };
}
test("notes preserve plain text, order writes, and reject invalid writes without data loss", async (t) => {
  const { directory, notes } = await notesFixture(t);
  assert.equal(await notes.read(), "");
  await Promise.all([
    notes.save("first"),
    notes.save("第二行\n<html>text</html>"),
    notes.save("last\n"),
  ]);
  assert.equal(await notes.read(), "last\n");
  assert.equal(await readFile(join(directory, "note.txt"), "utf8"), "last\n");
  for (const value of [null, {}, "x".repeat(10001)])
    await assert.rejects(notes.save(value), /10000/);
  assert.equal(await notes.read(), "last\n");
  await notes.save("x".repeat(10000));
  assert.equal((await notes.read()).length, 10000);
  assert.deepEqual(await readdir(directory), ["note.txt"]);
});
test("failed atomic note replacement does not poison subsequent saves", async (t) => {
  const { directory, notes } = await notesFixture(t);
  await mkdir(join(directory, "note.txt"));
  await assert.rejects(notes.save("cannot replace directory"));
  assert.deepEqual(await readdir(directory), ["note.txt"]);
  await rm(join(directory, "note.txt"), { recursive: true });
  await notes.save("recovered");
  await notes.drain();
  assert.equal(await notes.read(), "recovered");
});

test("browser platform monitors and launches with no registry, wallpaper, filesystem or lease access", async (t) => {
  vi.useFakeTimers();
  t.onTestFinished(() => vi.useRealTimers());
  let processes = [browser(1)];
  const calls = [];
  const prompts = [];
  const platform = createPlatform(
    {
      async native(operation, input) {
        calls.push({ operation, input });
        if (operation === "process.list") return processes;
        if (operation === "process.terminate") {
          processes = processes.filter((item) => item.pid !== input.pid);
          return null;
        }
        if (operation === "process.spawn") return identity(browser(9));
        throw new Error(`RegCreateKey denied: ${operation}`);
      },
    },
    () => {},
  );
  t.onTestFinished(() => platform.dispose());
  await platform.start((value) => prompts.push(value));
  processes = [browser(1), browser(2)];
  await vi.advanceTimersByTimeAsync(350);
  assert.deepEqual(prompts, ["chrome"]);
  assert.equal(calls.filter((item) => item.operation === "process.terminate").length, 1);
  await platform.launch("chrome");
  processes = [browser(1), browser(9), browser(10, "child", 9), browser(20)];
  await vi.advanceTimersByTimeAsync(350);
  assert.deepEqual(
    calls.filter((item) => item.operation === "process.terminate").map((item) => item.input.pid),
    [2, 20],
  );
  assert(calls.every((item) => item.operation.startsWith("process.")));
  await platform.dispose();
  const count = calls.length;
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(calls.length, count);
  await assert.rejects(platform.launch("chrome"), /已停止/);
});

test("dispose during browser startup prevents monitoring from restarting", async (t) => {
  vi.useFakeTimers();
  t.onTestFinished(() => vi.useRealTimers());
  const entered = deferred(),
    release = deferred();
  let calls = 0;
  const platform = createPlatform(
    {
      async native(operation) {
        assert.equal(operation, "process.list");
        calls++;
        entered.resolve();
        await release.promise;
        return [];
      },
    },
    () => {},
  );
  const starting = platform.start(() => assert.fail("disposed platform prompted"));
  await entered.promise;
  const stopping = platform.dispose();
  release.resolve();
  await Promise.all([starting, stopping]);
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(calls, 1);
  await assert.rejects(
    platform.start(() => {}),
    /已停止/,
  );
});

test("dispose during a browser snapshot drains work without terminating or prompting", async (t) => {
  vi.useFakeTimers();
  t.onTestFinished(() => vi.useRealTimers());
  const entered = deferred(),
    release = deferred();
  let lists = 0;
  const platform = createPlatform(
    {
      async native(operation) {
        assert.equal(operation, "process.list");
        if (++lists === 1) return [];
        entered.resolve();
        await release.promise;
        return [browser(5)];
      },
    },
    () => {},
  );
  await platform.start(() => assert.fail("disposed platform prompted"));
  const ticking = vi.advanceTimersByTimeAsync(350);
  await entered.promise;
  const stopping = platform.dispose();
  release.resolve();
  await Promise.all([stopping, ticking]);
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(lists, 2);
});
