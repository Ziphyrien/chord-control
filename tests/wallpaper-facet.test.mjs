import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFacetHost, defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ControlHost, PluginNative } from "../sdk/index.ts";
import { PluginDiagnostics } from "../sdk/diagnostics.ts";
import wallpaperFacet from "../plugins/wallpaper-policy/src/worker.ts";
import { WallpaperPolicy as OldPolicy } from "./wallpaper-legacy-fixture.ts";
import { applicationFixture, manifest, registration } from "./helpers.mjs";

const initial = "C:\\User\\initial.jpg";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "chord-wallpaper-facet-"));
  const systemRoot = join(root, "Windows");
  const stock = join(systemRoot, "Web", "Wallpaper", "Windows", "img0.jpg");
  await mkdir(join(stock, ".."), { recursive: true });
  await writeFile(stock, "stock");
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({
      format: 3,
      plugins: [
        {
          id: "com.chord.study-guard",
          enabled: true,
          installed: { id: "com.chord.study-guard", version: "1.3.0" },
        },
      ],
    }),
  );
  vi.stubEnv("SystemRoot", systemRoot);
  const h = { root, stock, systemRoot, wallpaper: initial, values: new Map(), denied: false };
  const hosts = new Set();
  h.native = async (operation, input) => {
    if (operation === "wallpaper.get") return h.wallpaper;
    if (operation === "wallpaper.set") {
      h.wallpaper = input.path;
      return null;
    }
    const key = `${input?.path}|${input?.name}`;
    if (operation === "registry.read") return structuredClone(h.values.get(key) ?? null);
    if (operation === "registry.write") {
      if (h.denied) throw new Error("RegCreateKeyExW denied (5)");
      if (input.value === null) h.values.delete(key);
      else h.values.set(key, structuredClone(input.value));
      return null;
    }
    throw new Error(`Unexpected ${operation}`);
  };
  h.start = async () => {
    const host = await createFacetHost({
      facets: [
        defineFacet({
          id: "test.wallpaper.host",
          setup(env) {
            env.provide(ControlHost, {
              async paths() {
                return {
                  dataDir: join(root, "data", "com.chord.wallpaper-policy"),
                  bundleDir: root,
                };
              },
              async log() {},
              async present() {},
            });
            env.provide(PluginNative, {
              async call(asset, request) {
                assert.equal(asset, "native/chord-wallpaper.exe");
                assert(request && typeof request === "object" && !Array.isArray(request));
                return {
                  format: 1,
                  ok: true,
                  value: await h.native(request.operation, request.input),
                };
              },
            });
          },
        }),
        wallpaperFacet,
      ],
    });
    hosts.add(host);
    return host;
  };
  t.onTestFinished(async () => {
    h.denied = false;
    for (const host of hosts) await host.dispose();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  return h;
}

test("real wallpaper facet pause restores migrated originals after legacy ownership hands off", async (t) => {
  const h = await fixture(t);
  const legacy = new OldPolicy(
    { native: h.native },
    join(h.root, "data", "com.chord.study-guard"),
    () => h.systemRoot,
  );
  await legacy.apply();
  const host = await h.start();
  await legacy.restore();
  assert.equal(h.wallpaper, h.stock);
  const diagnostic = await host.services.use(PluginDiagnostics).snapshot(BACKGROUND_CONTEXT);
  assert.equal(diagnostic.metrics.find((metric) => metric.name === "policy.passed").value, 6);
  await host.dispose();
  assert.equal(h.wallpaper, initial);
  assert.equal(h.values.size, 0);
});

test("actual RegCreateKey denial fails only wallpaper activation while unrelated updates commit", async (t) => {
  const h = await fixture(t);
  const packages = await Promise.all(
    ["wallpaper-policy", "password-pad", "app-guard", "system-info"].map(async (name) =>
      JSON.parse(
        await readFile(new URL(`../plugins/${name}/package.json`, import.meta.url), "utf8"),
      ),
    ),
  );
  const releases = packages.map((pkg) =>
    manifest(pkg.name, {
      version: pkg.version,
      services: pkg.control.services,
      permissions: pkg.control.permissions,
      artifactSha256: "b".repeat(64),
    }),
  );
  const previous = releases
    .filter((item) => item.id !== "com.chord.wallpaper-policy")
    .map((item) => ({ ...item, version: "0.0.1", artifactSha256: "a".repeat(64) }));
  const app = await applicationFixture(previous.map((item) => registration(item)));
  t.onTestFinished(() => app.service.close());
  const activate = app.runtime.activate.bind(app.runtime);
  app.runtime.activate = async (release) => {
    if (release.id === "com.chord.wallpaper-policy") await h.start();
    await activate(release);
  };
  h.denied = true;
  app.catalog = { format: 1, plugins: releases };
  assert.equal((await app.service.checkUpdates()).failures, 1);
  const summaries = app.service.summaries();
  for (const release of releases.filter((item) => item.id !== "com.chord.wallpaper-policy")) {
    const summary = summaries.find((item) => item.id === release.id);
    assert.equal(summary.version, release.version);
    assert.equal(summary.running, true);
    assert.equal(summary.error, undefined);
  }
  const failed = summaries.find((item) => item.id === "com.chord.wallpaper-policy");
  assert.equal(failed.running, false);
  assert.match(failed.error, /RegCreateKeyExW denied/);
  assert.equal(h.wallpaper, initial);
  assert.equal(h.values.size, 0);
});
