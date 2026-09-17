import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfiguration } from "../controller/src/domain/configuration.ts";
import { ConfigStore } from "../controller/src/infrastructure/config-store.ts";
import { manifest, publisher, signed } from "./helpers.mjs";

test("v0.2 configuration migrates installed and paused plugins, publisher pin and scoped removals", () => {
  const key = publisher(),
    release = signed(manifest("com.existing"), key.privateKey);
  const settings = {
    checkIntervalMinutes: 12,
    autoUpdate: false,
    catalogUrl: "https://example.test/catalog.json",
    catalogPublicKey: key.publicKey,
  };
  const migrated = readConfiguration({
    settings,
    plugins: [
      {
        id: release.id,
        catalog: true,
        publicKey: key.publicKey,
        installed: release,
        latest: release,
        enabled: false,
      },
    ],
    ignoredCatalogIds: ["com.removed"],
  });
  assert.equal(migrated.format, 2);
  assert.equal(migrated.plugins[0].enabled, false);
  assert.deepEqual(migrated.plugins[0].installed, release);
  assert.deepEqual(migrated.plugins[0].available, release);
  assert.equal(migrated.plugins[0].source.publicKey, key.publicKey);
  assert.deepEqual(migrated.suppressed, [
    { id: "com.removed", source: migrated.plugins[0].source },
  ]);
  assert.deepEqual(readConfiguration(migrated), migrated);
});
test("corrupt and unsupported configuration is never silently overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chord-config-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const store = new ConfigStore(root),
    path = join(root, "config.json");
  for (const content of ["broken JSON", JSON.stringify({ format: 99, plugins: [] })]) {
    await writeFile(path, content);
    await assert.rejects(store.load());
    assert.equal(await readFile(path, "utf8"), content);
  }
});
test("durable config snapshots are isolated and failed validation cannot mutate saved state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chord-config-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const store = new ConfigStore(root);
  await store.load();
  const initial = store.snapshot(),
    change = store.snapshot();
  change.settings.autoUpdate = false;
  assert.deepEqual(store.snapshot(), initial);
  await store.commit(change);
  change.settings.autoUpdate = true;
  assert.equal(store.snapshot().settings.autoUpdate, false);
  const bytes = await readFile(store.file, "utf8"),
    invalid = store.snapshot();
  invalid.settings.checkIntervalMinutes = 0;
  await assert.rejects(store.commit(invalid));
  assert.equal(await readFile(store.file, "utf8"), bytes);
  assert.equal(store.snapshot().settings.autoUpdate, false);
});
