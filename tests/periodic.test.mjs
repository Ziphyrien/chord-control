import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { ControllerApplication } from "../controller/src/application/controller.ts";
import { ActivityLog } from "../controller/src/application/execution.ts";
import { applicationFixture, deferred, manifest, registration } from "./helpers.mjs";

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
  vi.advanceTimersByTime(5 * 60_000);
  await setImmediate();
  assert.equal(h.service.summaries()[0].version, "2.0.0");
  assert(
    events.some(
      (event) => event.type === "snapshot" && event.snapshot.plugins[0]?.version === "2.0.0",
    ),
  );
  const checks = () => h.events.filter((event) => event[0] === "检查完成").length;
  assert.equal(checks(), 1);
  vi.advanceTimersByTime(5 * 60_000);
  await setImmediate();
  assert.equal(checks(), 2);
  app.stop();
  vi.advanceTimersByTime(60 * 60_000);
  await setImmediate();
  assert.equal(checks(), 2);
});

async function scheduledFixture(t) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  t.onTestFinished(() => vi.useRealTimers());
  const h = await applicationFixture([registration(manifest("scheduled.plugin"))]);
  const app = new ControllerApplication({
    plugins: h.service,
    runtime: h.runtime,
    gate: h.gate,
    activity: new ActivityLog(),
    dataDir: "fixture",
    openUi: async () => null,
    emit: () => {},
  });
  t.onTestFinished(async () => {
    app.stop();
    await h.service.close();
  });
  h.catalog = {
    format: 1,
    plugins: [
      manifest("scheduled.plugin", {
        version: "2.0.0",
        artifactSha256: "b".repeat(64),
      }),
    ],
  };
  const checks = () => h.events.filter((event) => event[0] === "检查完成").length;
  const advance = async (milliseconds) => {
    vi.advanceTimersByTime(milliseconds);
    await setImmediate();
  };
  return { h, app, checks, advance };
}

test("slow scheduled download and concurrent manual check share one operation", async (t) => {
  const { h, app, checks, advance } = await scheduledFixture(t);
  const download = deferred();
  h.blockDownload = download;
  app.start();
  await advance(5 * 60_000);
  assert.equal(h.calls.filter((call) => call.startsWith("download:")).length, 1);
  await advance(60 * 60_000);
  assert.equal(checks(), 0);
  const manual = app.submit("overlap", { type: "check_updates" });
  await setImmediate();
  download.resolve();
  await manual;
  assert.equal(checks(), 1);
  assert.equal(h.calls.filter((call) => call.startsWith("download:")).length, 1);
  await advance(5 * 60_000 - 1);
  assert.equal(checks(), 1);
  await advance(1);
  assert.equal(checks(), 2);
});

test("failed scheduled updates back off to one hour and reset after success", async (t) => {
  const { h, app, checks, advance } = await scheduledFixture(t);
  h.failActivate = ["scheduled.plugin@2.0.0"];
  app.start();
  for (const minutes of [5, 10, 20, 40, 60, 60]) {
    const before = checks();
    await advance(minutes * 60_000 - 1);
    assert.equal(checks(), before);
    await advance(1);
    assert.equal(checks(), before + 1);
    assert.equal(h.service.summaries()[0].version, "1.0.0");
  }
  h.failActivate = [];
  await advance(60 * 60_000);
  assert.equal(h.service.summaries()[0].version, "2.0.0");
  const successful = checks();
  await advance(5 * 60_000);
  assert.equal(checks(), successful + 1);
});

test("plugin automatic-install opt-out still discovers updates without downloading", async (t) => {
  const { h, app, advance } = await scheduledFixture(t);
  await h.service.updateSettings({ ...h.service.settings, autoUpdate: false });
  app.start();
  await advance(5 * 60_000);
  assert.equal(h.service.summaries()[0].version, "1.0.0");
  assert.equal(h.service.summaries()[0].hasUpdate, true);
  assert.equal(
    h.calls.some((call) => call.startsWith("download:")),
    false,
  );
});
