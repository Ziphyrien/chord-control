import test from "node:test";
import assert from "node:assert/strict";
import { createTransportHarness, fixtureId } from "./transport-harness.mjs";

test(
  "real Chord loads a signed archive, invokes UI RPC, restores offline and cleans native resources on shutdown",
  { timeout: 40000 },
  async (t) => {
    const h = await createTransportHarness();
    t.after(() => h.close());
    const release = await h.fixture("1.0.0", { native: true, cleanup: true });
    await h.start();
    await h.add(release);
    assert.equal(h.snapshot.plugins[0].running, true);
    assert.equal(
      await h.command({ type: "plugin_call", pluginId: fixtureId, method: "version", input: null }),
      "1.0.0",
    );
    const page = await h.command({ type: "plugin_ui", pluginId: fixtureId });
    const html = await fetch(page.url);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Fixture UI/);
    const result = await fetch(page.url.replace(/ui$/, "rpc"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "null" },
      body: JSON.stringify({ method: "echo", input: { hello: "世界" } }),
    });
    assert.deepEqual(await result.json(), { ok: true, result: { hello: "世界" } });
    assert.equal(result.headers.get("access-control-allow-origin"), "null");
    assert.equal(
      (await fetch(page.url, { headers: { Origin: "https://untrusted.test" } })).status,
      403,
    );
    await h.stop();
    assert.equal(h.native.length, 1, "native response still received during plugin dispose");
    h.offline = true;
    await h.start();
    assert.equal(h.snapshot.plugins[0].running, true);
  },
);
test(
  "runtime generation replacement revokes stale UI and activation failure restores callable previous generation",
  { timeout: 40000 },
  async (t) => {
    const h = await createTransportHarness();
    t.after(() => h.close());
    await h.start();
    await h.add(await h.fixture());
    const old = await h.command({ type: "plugin_ui", pluginId: fixtureId });
    await h.fixture("2.0.0");
    await h.command({ type: "check_updates" });
    assert.equal(h.snapshot.plugins[0].version, "2.0.0");
    assert.equal((await fetch(old.url)).status, 404);
    await h.fixture("3.0.0", { fail: true });
    assert.equal((await h.command({ type: "check_updates" })).failures, 1);
    assert.equal(
      await h.command({ type: "plugin_call", pluginId: fixtureId, method: "version", input: null }),
      "2.0.0",
    );
    assert.match(h.snapshot.plugins[0].error, /fixture activation failed/);
  },
);
test(
  "real cross-plugin service routes bind providers before consumers and keep desktop authorization responsive",
  { timeout: 40000 },
  async (t) => {
    const h = await createTransportHarness();
    t.after(() => h.close());
    const provider = await h.fixture("1.0.0", { id: "com.test.provider", provideService: true });
    const consumer = await h.fixture("1.0.0", {
      id: "com.test.consumer",
      requireService: true,
      hooks: true,
    });
    h.catalogue([consumer, provider]);
    await h.start();
    await h.command({
      type: "set_settings",
      settings: {
        autoUpdate: true,
        checkIntervalMinutes: 30,
        catalogUrl: `${h.baseUrl}/catalog.json`,
        catalogPublicKey: h.publicKey,
      },
    });
    assert.equal(h.snapshot.plugins.length, 2);
    assert(h.snapshot.plugins.every((plugin) => plugin.running));
    assert.equal(await h.command({ type: "desktop_action", action: "open" }), null);
    assert.equal(
      await h.command({
        type: "plugin_call",
        pluginId: consumer.id,
        method: "authorize",
        input: null,
      }),
      true,
    );
    await assert.rejects(
      h.command({ type: "set_enabled", pluginId: provider.id, enabled: false }),
      /确认/,
    );
    await h.command({
      type: "set_enabled",
      pluginId: provider.id,
      enabled: false,
      affectedPluginIds: [consumer.id],
    });
    assert(h.snapshot.plugins.every((plugin) => !plugin.running && !plugin.enabled));
  },
);
