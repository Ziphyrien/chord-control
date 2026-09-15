import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createHarness, pluginId } from "./helpers.mjs";

test(
  "standalone Windows SEA loads a signed plugin and UI with no node_modules or Node on PATH",
  { skip: process.platform !== "win32", timeout: 60000 },
  async (t) => {
    const h = await createHarness({
      sea: resolve("src-tauri/binaries/plugin-controller-x86_64-pc-windows-msvc.exe"),
    });
    t.after(() => h.close());
    await h.buildExample();
    await h.start();
    await h.command({
      type: "add_plugin",
      manifestUrl: `${h.baseUrl}/manifest.json`,
      publicKey: h.publicPem,
    });
    assert.equal(h.snapshot.plugins[0].running, true);
    const info = await h.command({ type: "plugin_call", pluginId, method: "info", input: null });
    assert.equal(info.platform, "win32");
    const ui = await h.command({ type: "plugin_ui", pluginId });
    assert.equal((await fetch(ui.url)).status, 200);
    await h.stop();
    h.offline = true;
    await h.start();
    assert.equal(h.snapshot.plugins[0].running, true);
  },
);
