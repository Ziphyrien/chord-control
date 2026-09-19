import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { HOST_VERSION } from "../shared/versions.ts";
import { createTransportHarness } from "./transport-harness.mjs";

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
