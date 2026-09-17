import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { ControllerApplication } from "../controller/src/application/controller.ts";
import { ActivityLog } from "../controller/src/application/execution.ts";
import { applicationFixture, manifest, registration } from "./helpers.mjs";

test("scheduled poll updates plugins, reschedules after completion, and stops cleanly", async (t) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  t.onTestFinished(() => vi.useRealTimers());
  const h = await applicationFixture([registration(manifest("scheduled.plugin"))]),
    events = [];
  const app = new ControllerApplication({
    plugins: h.service,
    runtime: h.runtime,
    gate: h.gate,
    activity: new ActivityLog(),
    dataDir: "fixture",
    openUi: async () => null,
    emit: (event) => events.push(event),
  });
  t.onTestFinished(async () => {
    app.stop();
    await h.service.close();
  });
  h.catalog = {
    format: 1,
    plugins: [manifest("scheduled.plugin", { version: "2.0.0", artifactSha256: "b".repeat(64) })],
  };
  app.start();
  vi.advanceTimersByTime(30 * 60_000);
  await setImmediate();
  assert.equal(h.service.summaries()[0].version, "2.0.0");
  assert(
    events.some(
      (event) => event.type === "snapshot" && event.snapshot.plugins[0]?.version === "2.0.0",
    ),
  );
  const checks = () => h.events.filter((event) => event[0] === "检查完成").length;
  assert.equal(checks(), 1);
  vi.advanceTimersByTime(30 * 60_000);
  await setImmediate();
  assert.equal(checks(), 2);
  app.stop();
  vi.advanceTimersByTime(60 * 60_000);
  await setImmediate();
  assert.equal(checks(), 2);
});
