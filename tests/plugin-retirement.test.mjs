import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HOST_VERSION } from "../shared/versions.ts";
import { ArchiveStore } from "../controller/src/infrastructure/archives.ts";
import { assertCatalog } from "../shared/plugin-format.ts";
import { applicationFixture, manifest, registration, publisher, signed } from "./helpers.mjs";

const id = "com.retired";
const retirement = { id, maxVersion: "1.3.2", minHostVersion: HOST_VERSION, reason: "功能已退役" };
async function fixture(t, options = {}) {
  const key = publisher(),
    owner = options.foreignPublisher ? publisher() : key;
  const release = signed(
    manifest(id, {
      version: options.version ?? "1.3.2",
      services: { provides: ["retired.feature"], requires: [] },
    }),
    owner.privateKey,
  );
  const origin = {
    kind: options.kind ?? "catalog",
    url: options.url ?? "https://example.test/catalog.json",
    publicKey: owner.publicKey,
  };
  const plugins = [registration(release, { source: origin })];
  const consumer = signed(
    manifest("com.consumer", {
      artifactSha256: "b".repeat(64),
      services: { provides: [], requires: ["retired.feature"] },
    }),
    key.privateKey,
  );
  if (options.dependent)
    plugins.push(registration(consumer, { source: { ...origin, publicKey: key.publicKey } }));
  const h = await applicationFixture(plugins);
  t.onTestFinished(() => h.service.close());
  const config = h.repository.snapshot();
  config.settings.catalogPublicKey = key.publicKey;
  config.settings.autoUpdate = false;
  await h.repository.commit(config);
  const catalog = signed(
    {
      format: 1,
      plugins: options.dependent ? [consumer] : [],
      retiredPlugins: [{ ...retirement, ...options.retirement }],
    },
    key.privateKey,
  );
  h.catalog = catalog;
  return { h, catalog };
}

test("signed retirement removes the owned installation and pauses dependent plugins even with auto-update off", async (t) => {
  const { h } = await fixture(t, { dependent: true });
  assert.equal((await h.service.checkUpdates()).failures, 0);
  assert.equal(h.runtime.has(id), false);
  assert.equal(
    h.service.summaries().some((plugin) => plugin.id === id),
    false,
  );
  const consumer = h.service.summaries().find((plugin) => plugin.id === "com.consumer");
  assert.equal(consumer.installed, true);
  assert.equal(consumer.enabled, false);
  assert.equal(consumer.running, false);
  assert.equal(
    h.repository.snapshot().suppressed.some((item) => item.id === id),
    true,
  );
  assert(h.calls.indexOf("stop:com.consumer") < h.calls.indexOf(`stop:${id}`));
  assert(h.calls.includes(`purge:${id}`));
  assert.equal(
    h.calls.some((call) => call.startsWith("download:")),
    false,
  );
  const stopped = h.calls.filter((call) => call === `stop:${id}`).length;
  await h.service.checkUpdates();
  assert.equal(h.calls.filter((call) => call === `stop:${id}`).length, stopped);
});

test("retirement respects host/version cutoffs and cannot remove another catalogue, publisher or manual source", async (t) => {
  for (const options of [
    { retirement: { minHostVersion: "999.0.0" } },
    { version: "2.0.0" },
    { url: "https://other.test/catalog.json" },
    { foreignPublisher: true },
    { kind: "manifest", url: "https://example.test/plugin.json" },
  ]) {
    const { h } = await fixture(t, options);
    await h.service.checkUpdates();
    assert.equal(h.runtime.has(id), true, JSON.stringify(options));
    assert.equal(h.repository.snapshot().plugins[0].installed.version, options.version ?? "1.3.2");
    assert.equal(h.calls.includes(`purge:${id}`), false);
  }
});

test("unsigned, tampered and wrong-key retirements leave the current plugin running", async (t) => {
  for (const mode of ["unsigned", "tampered", "wrong-key"]) {
    const { h, catalog } = await fixture(t);
    const untrusted = structuredClone(catalog);
    if (mode === "unsigned") delete untrusted.signature;
    if (mode === "tampered") untrusted.retiredPlugins[0].maxVersion = "9.0.0";
    h.catalog = mode === "wrong-key" ? signed(untrusted, publisher().privateKey) : untrusted;
    assert((await h.service.checkUpdates()).failures > 0, mode);
    assert.equal(h.runtime.has(id), true, mode);
    assert.equal(h.repository.snapshot().plugins[0].installed.version, "1.3.2");
    assert.equal(h.calls.includes(`purge:${id}`), false);
  }
});

test("cached signed retirement is applied during startup without a network check", async (t) => {
  const { h, catalog } = await fixture(t);
  const config = h.repository.snapshot();
  config.catalogCache = catalog;
  await h.repository.commit(config);
  await h.service.restore();
  assert.equal(h.runtime.has(id), false);
  assert.equal(h.service.summaries().length, 0);
});

test("failed cleanup cannot be forgotten on a retry after the runtime has already detached", async (t) => {
  const { h } = await fixture(t);
  const stop = h.runtime.deactivate.bind(h.runtime);
  h.runtime.deactivate = async (pluginId) => {
    await stop(pluginId);
    if (pluginId === id) throw new Error("resource cleanup failed");
  };
  h.failActivate = [`${id}@1.3.2`];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      assert((await h.service.checkUpdates()).failures > 0);
      assert.equal(h.repository.snapshot().plugins[0].installed.version, "1.3.2");
      assert.equal(h.calls.includes(`purge:${id}`), false);
    }
  } finally {
    h.runtime.deactivate = stop;
    h.failActivate = [];
  }
});

test("retirement catalogue schema rejects conflicting IDs and malformed or unbounded declarations", () => {
  const catalog = { format: 1, plugins: [], retiredPlugins: [retirement] };
  assert.doesNotThrow(() => assertCatalog(catalog));
  for (const value of [
    { ...catalog, retiredPlugins: {} },
    { ...catalog, retiredPlugins: [{ ...retirement, id: "../unsafe" }] },
    { ...catalog, retiredPlugins: [{ ...retirement, maxVersion: "1.3" }] },
    { ...catalog, retiredPlugins: [{ ...retirement, minHostVersion: "next" }] },
    { ...catalog, retiredPlugins: [retirement, { ...retirement, id: id.toUpperCase() }] },
    { ...catalog, plugins: [manifest(id)] },
    { ...catalog, retiredPlugins: Array.from({ length: 101 }, () => retirement) },
  ])
    assert.throws(() => assertCatalog(value));
});

test("archive retirement removes cached executable bytes but preserves user data and legacy migration journals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chord-retirement-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const archives = new ArchiveStore(root),
    release = manifest(id);
  await archives.prepare();
  const data = join(root, "data", id),
    cached = join(archives.directory, `${release.artifactSha256}.zip`);
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "backup"), "original wallpaper settings");
  await writeFile(cached, "cached executable");
  await archives.purge(release, { preserveData: true });
  assert.equal(await readFile(join(data, "backup"), "utf8"), "original wallpaper settings");
  await assert.rejects(readFile(cached), { code: "ENOENT" });
});
