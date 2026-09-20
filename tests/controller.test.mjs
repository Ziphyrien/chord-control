import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { applicationFixture, manifest, registration, deferred } from "./helpers.mjs";
const provider = () => manifest("com.provider", { services: { provides: ["auth"], requires: [] } });
const consumer = () =>
  manifest("com.consumer", { services: { provides: ["feature"], requires: ["auth"] } });
const downstream = () =>
  manifest("com.downstream", { services: { provides: [], requires: ["feature"] } });

test("startup follows provider order even when persisted registrations are reversed", async () => {
  const h = await applicationFixture([
    registration(downstream()),
    registration(consumer()),
    registration(provider()),
  ]);
  assert(h.service.summaries().every((item) => item.running));
  await h.service.close();
  assert.deepEqual(h.calls, ["stop:com.downstream", "stop:com.consumer", "stop:com.provider"]);
});
test("pause and ignore preserve rows, dependent choices, and explicit reinstall", async () => {
  const h = await applicationFixture([
    registration(provider()),
    registration(consumer()),
    registration(downstream()),
  ]);
  await assert.rejects(h.service.setEnabled("com.provider", false), /确认/);
  assert.equal(h.calls.length, 0);
  const dependents = h.service
    .summaries()
    .find((item) => item.id === "com.provider")
    .dependents.map((item) => item.id);
  assert.deepEqual(dependents, ["com.consumer", "com.downstream"]);
  await h.service.setEnabled("com.provider", false, dependents);
  assert(h.service.summaries().every((item) => !item.enabled && !item.running && item.installed));
  assert.deepEqual(h.calls, ["stop:com.downstream", "stop:com.consumer", "stop:com.provider"]);
  await h.service.checkUpdates();
  assert(h.service.summaries().every((item) => !item.enabled));
  await assert.rejects(h.service.setEnabled("com.consumer", true), /依赖/);
  await h.service.setEnabled("com.provider", true);
  await h.service.setEnabled("com.consumer", true);
  await h.service.remove("com.provider", ["com.consumer"]);
  const ignored = () => h.service.summaries().find((item) => item.id === "com.provider");
  assert.equal(h.service.summaries().length, 3);
  assert.equal(ignored().status, "ignored");
  assert.equal(ignored().installed, false);
  assert(h.service.summaries().every((item) => !item.enabled && !item.running));
  assert(
    h.service
      .summaries()
      .filter((item) => item.id !== "com.provider")
      .every((item) => item.installed),
  );
  h.catalog = {
    format: 1,
    plugins: [
      consumer(),
      downstream(),
      { ...provider(), version: "2.0.0", artifactSha256: "b".repeat(64) },
    ],
  };
  h.calls.length = 0;
  await h.service.checkUpdates();
  await h.service.restore();
  assert.equal(ignored().status, "ignored");
  assert.equal(ignored().latestVersion, "2.0.0");
  assert.deepEqual(h.calls, [], "sync and restore must not reinstall ignored plugins");
  h.failActivate = ["com.provider@2.0.0"];
  await assert.rejects(h.service.install("com.provider"), /activation failed/);
  assert.equal(ignored().status, "ignored");
  assert.equal(ignored().running, false);
  assert.equal(h.repository.snapshot().suppressed.length, 1);
  h.failActivate = [];
  await h.service.install("com.provider");
  assert.equal(ignored().status, "active");
  assert.equal(ignored().version, "2.0.0");
  assert.equal(h.repository.snapshot().suppressed.length, 0);
  assert(
    h.service
      .summaries()
      .filter((item) => item.id !== "com.provider")
      .every((item) => item.installed && !item.enabled),
  );
  await h.service.close();
});
test("catalogue withdrawal retains running local installation and pause persists across rediscovery", async () => {
  const h = await applicationFixture([registration(provider())]);
  h.catalog = { format: 1, plugins: [] };
  await h.service.checkUpdates();
  const missing = h.service.summaries()[0];
  assert.equal(missing.sourceStatus, "missing");
  assert.equal(missing.running, true);
  assert.equal(missing.installed, true);
  await h.service.setEnabled("com.provider", false);
  h.catalog = { format: 1, plugins: [provider()] };
  await h.service.checkUpdates();
  assert.equal(h.service.summaries()[0].enabled, false);
  assert.equal(h.service.summaries()[0].sourceStatus, "available");
  await h.service.close();
});
test("switching repository detaches old source and cannot repin installed publisher implicitly", async () => {
  const h = await applicationFixture([registration(provider())]);
  await h.service.updateSettings({
    ...h.service.settings,
    catalogUrl: "https://other.test/catalog.json",
  });
  assert.equal(h.service.summaries()[0].sourceStatus, "detached");
  await h.service.checkUpdates();
  assert.equal(h.repository.snapshot().plugins[0].source.url, "https://example.test/catalog.json");
  assert.equal(h.service.summaries()[0].running, true);
  await h.service.close();
});
test("failed candidate restores stopped provider and consumers in dependency order", async () => {
  const h = await applicationFixture([registration(consumer()), registration(provider())]);
  h.catalog = {
    format: 1,
    plugins: [consumer(), provider()].map((item) =>
      item.id === "com.provider"
        ? { ...item, version: "2.0.0", artifactSha256: "b".repeat(64) }
        : item,
    ),
  };
  h.failActivate = ["com.provider@2.0.0"];
  const result = await h.service.checkUpdates();
  assert(result.failures > 0);
  assert(h.service.summaries().every((item) => item.running && item.version === "1.0.0"));
  assert.deepEqual(
    h.calls.filter((item) => !item.startsWith("download:")),
    [
      "stop:com.consumer",
      "stop:com.provider",
      "start:com.provider@2.0.0",
      "start:com.provider@1.0.0",
      "start:com.consumer@1.0.0",
    ],
  );
  await h.service.close();
});
for (const recoveryFails of [false, true]) {
  test(`failure attribution stays with the failed consumer when recovery ${recoveryFails ? "fails" : "succeeds"}`, async (t) => {
    const companion = manifest("com.companion", { services: { provides: [], requires: ["auth"] } });
    const releases = [provider(), companion, consumer(), manifest("com.independent")];
    const h = await applicationFixture(releases.map((item) => registration(item)));
    t.onTestFinished(() => h.service.close());
    h.catalog = {
      format: 1,
      plugins: releases.map((item) => ({
        ...item,
        version: "2.0.0",
        artifactSha256: "b".repeat(64),
      })),
    };
    h.failActivate = ["com.consumer@2.0.0", ...(recoveryFails ? ["com.consumer@1.0.0"] : [])];
    assert.equal((await h.service.checkUpdates()).failures, 1);
    const list = h.service.summaries();
    assert.deepEqual(
      list.filter((item) => item.error).map((item) => item.id),
      ["com.consumer"],
    );
    const failed = list.find((item) => item.id === "com.consumer");
    assert.equal(failed.running, !recoveryFails);
    assert.equal(failed.status, "error");
    assert.match(failed.error, /activation failed/);
    for (const id of ["com.provider", "com.companion"]) {
      const healthy = list.find((item) => item.id === id);
      assert.equal(healthy.running, true);
      assert.equal(healthy.version, "1.0.0");
      assert.equal(healthy.status, "update");
    }
    assert.equal(list.find((item) => item.id === "com.independent").version, "2.0.0");
    const rollback = h.events.find((event) => event[0] === "插件更新失败");
    assert.match(rollback[1], /com.consumer: activation failed/);
    h.failActivate = [];
    assert.equal((await h.service.checkUpdates()).failures, 0);
    assert(
      h.service
        .summaries()
        .every((item) => item.running && !item.error && item.version === "2.0.0"),
    );
  });
}

test("failure attribution does not blame the manually updated provider for its consumer", async (t) => {
  const nextProvider = { ...provider(), version: "2.0.0", artifactSha256: "b".repeat(64) };
  const h = await applicationFixture([
    registration(provider(), { available: nextProvider }),
    registration(consumer()),
  ]);
  t.onTestFinished(() => h.service.close());
  h.failActivate = ["com.consumer@1.0.0"];
  await assert.rejects(h.service.install("com.provider"), /com.consumer: activation failed/);
  const list = h.service.summaries();
  assert.deepEqual(
    list.filter((item) => item.error).map((item) => item.id),
    ["com.consumer"],
  );
  assert.equal(list[0].running, true);
  assert.equal(list[0].status, "update");
  assert.equal(list[0].version, "1.0.0");
});

test("failure attribution preserves distinct candidate and recovery failures without blaming blocked peers", async (t) => {
  const h = await applicationFixture([
    registration(provider()),
    registration(consumer()),
    registration(downstream()),
  ]);
  t.onTestFinished(() => h.service.close());
  h.catalog = {
    format: 1,
    plugins: [provider(), consumer(), downstream()].map((item) => ({
      ...item,
      version: "2.0.0",
      artifactSha256: "b".repeat(64),
    })),
  };
  h.failActivate = ["com.consumer@2.0.0", "com.provider@1.0.0"];
  assert.equal((await h.service.checkUpdates()).failures, 1);
  const list = h.service.summaries();
  assert.deepEqual(
    list.filter((item) => item.error).map((item) => item.id),
    ["com.provider", "com.consumer"],
  );
  assert(list.filter((item) => item.error).every((item) => item.error === "activation failed"));
  assert.equal(list[2].status, "blocked");
  assert.match(list[2].blockedReason, /com.consumer/);
});

test("failure attribution records the plugin whose cleanup failed even when only its provider updates", async (t) => {
  const h = await applicationFixture([registration(provider()), registration(consumer())]);
  t.onTestFinished(() => h.service.close());
  h.catalog = {
    format: 1,
    plugins: [{ ...provider(), version: "2.0.0", artifactSha256: "b".repeat(64) }, consumer()],
  };
  const deactivate = h.runtime.deactivate.bind(h.runtime);
  let failCleanup = true;
  h.runtime.deactivate = async (id) => {
    await deactivate(id);
    if (id === "com.consumer" && failCleanup) {
      failCleanup = false;
      throw new Error("cleanup failed");
    }
  };
  assert.equal((await h.service.checkUpdates()).failures, 1);
  const list = h.service.summaries();
  assert.deepEqual(
    list.filter((item) => item.error).map((item) => item.id),
    ["com.consumer"],
  );
  assert.equal(list[1].error, "cleanup failed");
  assert(list.every((item) => item.running && item.version === "1.0.0"));
  assert.match(
    h.events.find((event) => event[0] === "插件更新失败")[1],
    /com.consumer: cleanup failed/,
  );
});

test("failure attribution keeps persistence and validation errors at the operation level", async (t) => {
  const h = await applicationFixture([
    registration(provider(), {
      available: { ...provider(), version: "2.0.0", artifactSha256: "b".repeat(64) },
    }),
    registration(consumer()),
  ]);
  t.onTestFinished(() => h.service.close());
  h.failCommit = true;
  await assert.rejects(h.service.install("com.provider"), /disk full/);
  assert(
    h.service.summaries().every((item) => item.running && !item.error && item.version === "1.0.0"),
  );
  h.failCommit = false;
  let validations = 0;
  await assert.rejects(
    h.service.install("com.provider", () => {
      if (++validations === 2) throw new Error("authorization expired");
    }),
    /authorization expired/,
  );
  assert(h.service.summaries().every((item) => item.running && !item.error));
});

test("persistence failure rolls back runtime instead of leaving disabled/removed state half applied", async () => {
  const h = await applicationFixture([registration(provider()), registration(consumer())]);
  h.failCommit = true;
  await assert.rejects(h.service.remove("com.provider", ["com.consumer"]), /disk full/);
  assert(h.service.summaries().every((item) => item.enabled && item.installed && item.running));
  assert.equal(h.repository.snapshot().suppressed.length, 0);
  h.failCommit = false;
  await h.service.close();
});
test("blocked dependency has an explicit cause, independent plugins can still run", async () => {
  const h = await applicationFixture([
    registration(consumer()),
    registration(manifest("com.independent")),
  ]);
  const blocked = h.service.summaries().find((item) => item.id === "com.consumer");
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.blockedReason, /auth/);
  assert.equal(h.service.summaries().find((item) => item.id === "com.independent").running, true);
  await h.service.close();
});
test("network preparation does not monopolize plugin execution gate", async () => {
  const h = await applicationFixture([registration(provider())]);
  h.catalog = {
    format: 1,
    plugins: [{ ...provider(), version: "2.0.0", artifactSha256: "b".repeat(64) }],
  };
  const download = deferred();
  h.blockDownload = download;
  const updating = h.service.checkUpdates();
  while (!h.calls.some((item) => item.startsWith("download:")))
    await new Promise((resolve) => setImmediate(resolve));
  const result = await h.gate(() => h.runtime.call("com.provider", "ping", null));
  assert.equal(result, "responsive");
  download.resolve();
  await updating;
  await h.service.close();
});
test("one invalid plugin family cannot block unrelated successful updates", async () => {
  const h = await applicationFixture([]);
  h.catalog = { format: 1, plugins: [consumer(), manifest("com.independent")] };
  const result = await h.service.checkUpdates();
  assert.equal(result.failures, 1);
  const list = h.service.summaries();
  assert.equal(list.find((item) => item.id === "com.independent").running, true);
  assert.match(list.find((item) => item.id === "com.consumer").blockedReason, /auth/);
  await h.service.close();
});
test("dependent graph changes in a release roll back the entire related family", async () => {
  const h = await applicationFixture([registration(provider()), registration(consumer())]);
  h.catalog = {
    format: 1,
    plugins: [
      {
        ...provider(),
        version: "2.0.0",
        artifactSha256: "b".repeat(64),
        services: { provides: ["other"], requires: [] },
      },
      consumer(),
    ],
  };
  assert.equal((await h.service.checkUpdates()).failures, 1);
  assert(h.service.summaries().every((item) => item.running && item.version === "1.0.0"));
  await h.service.close();
});

test("graph changes after confirmation reject stale affected ids before any stop", async () => {
  const h = await applicationFixture([
    registration(provider()),
    registration(consumer()),
    registration(downstream(), { enabled: false }),
  ]);
  const accepted = ["com.consumer"];
  await h.service.setEnabled("com.downstream", true);
  h.calls.length = 0;
  await assert.rejects(h.service.remove("com.provider", accepted), /依赖关系已变化/);
  assert.equal(h.calls.length, 0);
  await h.service.close();
});

test("completed one-shot plugins retire before activation and cannot return through catalogue sync", async () => {
  const release = manifest("upgrade.bridge", { retireAfterHostVersion: "0.4.2" });
  const h = await applicationFixture([registration(release)]);
  try {
    assert.equal(h.runtime.has(release.id), false);
    assert.equal(h.service.summaries().length, 0);
    assert.equal(h.repository.snapshot().suppressed[0].id, release.id);
    await h.service.checkUpdates();
    assert.equal(h.service.summaries().length, 0);
    assert.equal(
      h.calls.some((call) => call.startsWith("download:")),
      false,
    );
    assert(h.events.some((event) => event[0] === "一次性插件已移除"));
  } finally {
    await h.service.close();
  }
});

test("future one-shot target keeps the plugin installed and active", async () => {
  const h = await applicationFixture([
    registration(manifest("future.bridge", { retireAfterHostVersion: "999.0.0" })),
  ]);
  try {
    assert.equal(h.service.summaries()[0].running, true);
  } finally {
    await h.service.close();
  }
});
