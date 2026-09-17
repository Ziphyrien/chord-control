import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createTransportHarness, fixtureId } from "./transport-harness.mjs";

test(
  "cloud-built Windows SEA loads signed plugins without Node or node_modules",
  {
    skip: process.platform !== "win32" || !process.env.CHORD_TEST_SEA,
    timeout: 40000,
  },
  async (t) => {
    const h = await createTransportHarness({ sea: resolve(process.env.CHORD_TEST_SEA) });
    t.onTestFinished(() => h.close());
    const release = await h.fixture();
    await h.start();
    await h.add(release);
    assert.equal(h.snapshot.plugins[0].running, true);
    assert.equal(
      await h.command({ type: "plugin_call", pluginId: fixtureId, method: "version", input: null }),
      "1.0.0",
    );
    const page = await h.command({ type: "plugin_ui", pluginId: fixtureId });
    assert.equal((await fetch(page.url)).status, 200);
    await h.stop();
    h.offline = true;
    await h.start();
    assert.equal(h.snapshot.plugins[0].running, true);
  },
);
