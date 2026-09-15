import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createHarness } from "./helpers.mjs";

test("scheduled poll installs an update without a check command", { timeout: 80000 }, async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const first = await h.buildFixture("1.0.0");
  await h.start();
  await h.command({
    type: "add_plugin",
    manifestUrl: `${h.baseUrl}/manifest.json`,
    publicKey: h.publicPem,
  });
  await h.command({
    type: "set_settings",
    settings: { checkIntervalMinutes: 1, autoUpdate: true, catalogUrl: "", catalogPublicKey: "" },
  });
  await h.buildFixture("2.0.0");
  const deadline = Date.now() + 72000;
  while (Date.now() < deadline && h.snapshot.plugins[0]?.version !== "2.0.0") await delay(200);
  assert.equal(h.snapshot.plugins[0].version, "2.0.0");
  assert.equal(
    await h.command({ type: "plugin_call", pluginId: first.id, method: "version", input: null }),
    "2.0.0",
  );
});
