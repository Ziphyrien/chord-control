import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { HOST_VERSION } from "../shared/versions.ts";
import { createTransportHarness } from "./transport-harness.mjs";

test(
  "real Chord diagnostics preserves rollback error attribution",
  { timeout: 40_000 },
  async (t) => {
    const h = await createTransportHarness({ native: () => ({ version: HOST_VERSION }) });
    t.onTestFinished(() => h.close());
    await h.start();
    const observer = await h.fixture("1.0.0", {
      id: "test.observer",
      permissions: ["diagnostics"],
      source:
        'exports.default={id:"observer",setup(env){const diagnostics=env.use({id:"chord-control.diagnostics",local:false});env.provide({id:"chord-control.ui",local:false},{call:(_method,_input,context)=>diagnostics.snapshot(context)});}};',
    });
    await h.add(observer);
    const provider = { id: "test.provider", provideService: true };
    const peer = { id: "test.companion", requireService: true };
    const consumer = { id: "test.consumer", requireService: true };
    for (const options of [provider, peer, consumer])
      await h.add(await h.fixture("1.0.0", options));
    for (const options of [provider, peer]) await h.fixture("2.0.0", options);
    await h.fixture("2.0.0", {
      ...consumer,
      source:
        'exports.default={id:"consumer",setup(env){env.use({id:"fixture.auth",local:false});env.onActivate(()=>{throw new Error("Access denied (os error 5)")});}};',
    });
    assert.equal((await h.command({ type: "check_updates" })).failures, 1);
    const report = await h.command({
      type: "plugin_call",
      pluginId: observer.id,
      method: "snapshot",
      input: null,
    });
    assert.deepEqual(
      report.controller.plugins.filter((plugin) => plugin.error).map((plugin) => plugin.id),
      [consumer.id],
    );
    assert.match(
      report.controller.plugins.find((plugin) => plugin.id === consumer.id).error,
      /os error 5/,
    );
    for (const id of [provider.id, peer.id]) {
      const plugin = report.controller.plugins.find((plugin) => plugin.id === id);
      assert.equal(plugin.running, true);
      assert.equal(plugin.version, "1.0.0");
      assert.equal(plugin.status, "update");
      assert.equal(plugin.error, null);
    }
    assert.deepEqual(
      report.metrics
        .filter((metric) => metric.failed > 0)
        .map((metric) => [metric.pluginId, metric.operation]),
      [[consumer.id, "activate"]],
    );
    assert.match(
      report.controller.activities.find((activity) => activity.title === "插件更新失败").detail,
      /test.consumer:.*os error 5/,
    );
  },
);

// The host contract works for an arbitrary plugin and enforces its permission.
test(
  "generic diagnostics exposes observed state and rejects plugins without its grant",
  { timeout: 25000 },
  async (t) => {
    const h = await createTransportHarness({
      native: () => ({ version: "0.4.4", updater: { busy: false } }),
    });
    t.onTestFinished(() => h.close());
    const source =
      'exports.default={id:"observer",setup(env){const diagnostics=env.use({id:"chord-control.diagnostics",local:false});env.provide({id:"chord-control.ui",local:false},{call:(_method,_input,context)=>diagnostics.snapshot(context)});}};';
    await h.start();
    const allowed = await h.fixture("1.0.0", {
      id: "test.observer",
      permissions: ["diagnostics"],
      source,
    });
    await h.add(allowed);
    const report = await h.command({
      type: "plugin_call",
      pluginId: allowed.id,
      method: "snapshot",
      input: null,
    });
    assert.equal(report.controller.version, HOST_VERSION);
    assert.equal(
      report.controller.plugins.find((plugin) => plugin.id === allowed.id).running,
      true,
    );
    assert.equal(Object.hasOwn(report.controller, "dataDir"), false);
    assert.equal(Object.hasOwn(report.controller.settings, "catalogPublicKey"), false);
    const activation = report.metrics.find(
      (metric) => metric.pluginId === allowed.id && metric.operation === "activate",
    );
    assert.equal(activation.succeeded, 1);
    assert.equal(activation.successRatio, 1);
    assert(activation.meanMs >= 0);
    const denied = await h.fixture("1.0.0", { id: "test.denied", source });
    await h.add(denied);
    await assert.rejects(
      h.command({ type: "plugin_call", pluginId: denied.id, method: "snapshot", input: null }),
      /诊断读取权限/,
    );
  },
);
