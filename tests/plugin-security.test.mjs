import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { passwordFor } from "../plugins/password-pad/src/board.ts";
import { createTransportHarness } from "./transport-harness.mjs";

test(
  "repeated pause cancellations revoke each prompt page and leave the plugin running",
  { skip: !process.env.CHORD_TEST_PLUGINS, timeout: 15000 },
  async (t) => {
    const h = await createTransportHarness();
    t.onTestFinished(() => h.close());
    await h.seed(resolve(process.env.CHORD_TEST_PLUGINS), [guardId, passwordId]);
    await h.start();
    const urls = new Set();
    for (let attempt = 0; attempt < 4; attempt++) {
      const opened = h.waitFor(
        (event) => event.type === "plugin_window" && event.pluginId === passwordId && event.visible,
      );
      const cancelled = assert.rejects(
        h.command({
          type: "set_enabled",
          pluginId: guardId,
          enabled: false,
          affectedPluginIds: [],
        }),
        /操作未获允许/,
      );
      const page = await opened;
      assert(!urls.has(page.url));
      urls.add(page.url);
      assert.equal((await fetch(page.url)).status, 200);
      const hidden = h.waitFor(
        (event) =>
          event.type === "plugin_window" && event.pluginId === passwordId && !event.visible,
      );
      // The desktop uses this same notification for X-close and presentation failure.
      await h.command({ type: "plugin_window_closed", pluginId: passwordId });
      await cancelled;
      await hidden;
      assert.equal((await fetch(page.url)).status, 404);
      assert(h.snapshot.plugins.find((plugin) => plugin.id === guardId).running);
    }
  },
);

const passwordId = "com.chord.password-pad",
  guardId = "com.chord.app-guard";
async function challenge(h) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await h.command({
      type: "plugin_call",
      pluginId: passwordId,
      method: "challenge",
      input: null,
    });
    if (value) return value;
    await delay(10);
  }
  throw new Error("password prompt did not appear");
}
async function submit(h, view, input) {
  const sequence = [...input].map((character) => view.cells.indexOf(character));
  sequence.push(view.cells.indexOf("＃"));
  assert(sequence.every((index) => index >= 0));
  return h.command({
    type: "plugin_call",
    pluginId: passwordId,
    method: "submit",
    input: { id: view.id, revision: view.revision, sequence },
  });
}
test(
  "cloud-built guard and password facets authorize desktop actions with clicks, decoys, revision checks and closure",
  {
    skip: !process.env.CHORD_TEST_PLUGINS,
    timeout: 40000,
  },
  async (t) => {
    const h = await createTransportHarness(
      process.env.CHORD_TEST_SEA ? { sea: resolve(process.env.CHORD_TEST_SEA) } : {},
    );
    t.onTestFinished(() => h.close());
    await h.seed(resolve(process.env.CHORD_TEST_PLUGINS), [guardId, passwordId]);
    await h.start();
    assert(h.snapshot.plugins.every((item) => item.running));
    assert.equal(
      await h.command({
        type: "plugin_call",
        pluginId: passwordId,
        method: "challenge",
        input: null,
      }),
      null,
      "startup must remain silent",
    );
    const opening = h.command({ type: "desktop_action", action: "open" });
    const first = await challenge(h);
    assert.equal(first.cells.filter((cell) => cell === "＃").length, 1);
    assert.equal((await submit(h, first, "")).approved, false);
    const renewed = await challenge(h);
    assert(renewed.revision > first.revision);
    assert.equal(
      (await submit(h, first, passwordFor(new Date()))).approved,
      false,
      "stale revision cannot authorize",
    );
    const decoy = renewed.cells.find((cell) => cell !== "＃");
    assert.equal(
      (await submit(h, renewed, `${decoy}${decoy}${passwordFor(new Date())}${decoy}`)).approved,
      true,
    );
    assert.equal(await opening, null);
    assert.equal(
      (await submit(h, renewed, passwordFor(new Date()))).approved,
      false,
      "resolved challenge cannot replay",
    );
    const rejected = assert.rejects(
      h.command({ type: "desktop_action", action: "quit" }),
      /未获允许/,
    );
    await challenge(h);
    await h.command({ type: "plugin_window_closed", pluginId: passwordId });
    await rejected;
    await assert.rejects(
      h.command({ type: "plugin_call", pluginId: passwordId, method: "practice", input: null }),
      /无效/,
    );
    await assert.rejects(
      h.command({ type: "plugin_call", pluginId: passwordId, method: "cancel", input: null }),
      /无效/,
    );
  },
);
