import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFacetHost, defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ControlHost, PluginUi } from "../sdk/index.ts";
import { PluginDiagnostics } from "../sdk/diagnostics.ts";
import { PasswordPrompt } from "../packages/contracts/password.ts";
import browserFacet from "../plugins/study-guard/src/worker.ts";
import wallpaperFacet from "../plugins/wallpaper-policy/src/worker.ts";
import { WallpaperPolicy as OldPolicy } from "./wallpaper-legacy-fixture.ts";
import { applicationFixture, manifest, registration, deferred } from "./helpers.mjs";

const initial = "C:\\User\\initial.jpg";
const browser = (pid) => ({
  pid,
  parentPid: 0,
  createdAt: `time-${pid}`,
  name: "chrome.exe",
  executable: "C:\\Chrome\\chrome.exe",
});
const call = (host, method, input = null) =>
  host.services.use(PluginUi).call(method, input, BACKGROUND_CONTEXT);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "chord-split-"));
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
  const h = {
    root,
    stock,
    systemRoot,
    wallpaper: initial,
    values: new Map(),
    calls: [],
    processes: [browser(1)],
    denied: false,
    authorize: async () => true,
  };
  const hosts = new Set();
  h.native = async (operation, input) => {
    h.calls.push({ operation, input });
    if (operation === "process.list") return h.processes;
    if (operation === "process.spawn") {
      h.processes.push(browser(30));
      return { pid: 30, createdAt: "time-30" };
    }
    if (operation === "process.terminate") {
      h.processes = h.processes.filter((row) => row.pid !== input.pid);
      return null;
    }
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
  h.start = async (kind) => {
    const pluginId = kind === "browser" ? "com.chord.study-guard" : "com.chord.wallpaper-policy";
    const host = await createFacetHost({
      facets: [
        defineFacet({
          id: `test.${kind}.host`,
          setup(env) {
            env.provide(ControlHost, {
              async paths() {
                assert.equal(kind, "wallpaper", "browser requires no wallpaper data directory");
                return { dataDir: join(root, "data", pluginId), bundleDir: root };
              },
              async native(operation, input) {
                if (kind === "browser") assert(operation.startsWith("process."));
                else assert(!operation.startsWith("process."));
                return h.native(operation, input);
              },
              async log() {},
              async present() {},
            });
            if (kind === "browser")
              env.provide(PasswordPrompt, { authorize: (...args) => h.authorize(...args) });
          },
        }),
        kind === "browser" ? browserFacet : wallpaperFacet,
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

test("real wallpaper pause restores migrated originals while browser monitoring and authorization continue", async (t) => {
  const h = await fixture(t);
  const legacy = new OldPolicy(
    { native: h.native },
    join(h.root, "data", "com.chord.study-guard"),
    () => h.systemRoot,
  );
  await legacy.apply();
  const browserHost = await h.start("browser");
  const wallpaperHost = await h.start("wallpaper");
  await legacy.restore();
  assert.equal(h.wallpaper, h.stock);
  const diagnostic = await wallpaperHost.services
    .use(PluginDiagnostics)
    .snapshot(BACKGROUND_CONTEXT);
  assert.equal(diagnostic.metrics.find((metric) => metric.name === "policy.passed").value, 6);
  await wallpaperHost.dispose();
  assert.equal(h.wallpaper, initial);
  assert.equal(h.values.size, 0);
  assert.equal((await call(browserHost, "status")).active, true);
  const browserDiagnostic = await browserHost.services
    .use(PluginDiagnostics)
    .snapshot(BACKGROUND_CONTEXT);
  assert(browserDiagnostic.metrics.every((metric) => !metric.name.startsWith("policy.")));
  h.processes.push(browser(7));
  await vi.waitFor(
    () =>
      assert(
        h.calls.some((item) => item.operation === "process.terminate" && item.input.pid === 7),
      ),
    { timeout: 2500 },
  );
  await vi.waitFor(() => assert(h.calls.some((item) => item.operation === "process.spawn")), {
    timeout: 2500,
  });
  assert.equal((await call(browserHost, "status")).active, true);
});

test("browser pause cancels pending authorization and leaves the independent wallpaper policy active", async (t) => {
  const h = await fixture(t);
  const authorized = deferred();
  h.authorize = () => authorized.promise;
  const browserHost = await h.start("browser");
  const wallpaperHost = await h.start("wallpaper");
  assert.equal((await call(browserHost, "open_browser", "chrome")).requested, true);
  await browserHost.dispose();
  authorized.resolve(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    h.calls.some((item) => item.operation === "process.spawn"),
    false,
  );
  assert.equal(h.wallpaper, h.stock);
  const snapshot = await wallpaperHost.services.use(PluginDiagnostics).snapshot(BACKGROUND_CONTEXT);
  assert.equal(snapshot.metrics.find((metric) => metric.name === "policy.owned").value, 1);
  await wallpaperHost.dispose();
  assert.equal(h.wallpaper, initial);
});

test("actual RegCreateKey denial fails only wallpaper activation while browser and unrelated updates commit", async (t) => {
  const h = await fixture(t);
  const packages = await Promise.all(
    ["study-guard", "wallpaper-policy", "password-pad", "app-guard", "system-info"].map(
      async (name) =>
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
  let browserHost;
  const activate = app.runtime.activate.bind(app.runtime);
  app.runtime.activate = async (release) => {
    if (release.id === "com.chord.wallpaper-policy") await h.start("wallpaper");
    if (release.id === "com.chord.study-guard" && release.version === "1.3.0")
      browserHost = await h.start("browser");
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
  assert.equal((await call(browserHost, "open_browser", "chrome")).requested, true);
  await vi.waitFor(() => assert(h.calls.some((item) => item.operation === "process.spawn")));
});
