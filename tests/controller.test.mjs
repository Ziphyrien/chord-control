import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, generateKeyPairSync } from "node:crypto";
import { zipSync } from "fflate";
import { createHarness, pluginId, signed } from "./helpers.mjs";
import { assertId, assertManifest, safePath } from "../shared/plugin-format.ts";

const call = (id, method, input = null) => ({ type: "plugin_call", pluginId: id, method, input });
const settings = (h, autoUpdate = true) => ({
  checkIntervalMinutes: 30,
  autoUpdate,
  catalogUrl: `${h.baseUrl}/catalog.json`,
  catalogPublicKey: h.publicPem,
});

test(
  "real plugin: signature pin, UI RPC, persistence, offline restart and ETag",
  { timeout: 60000 },
  async (t) => {
    const h = await createHarness();
    t.after(() => h.close());
    const manifest = await h.buildExample();
    await h.start();
    const wrongKey = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    await assert.rejects(
      h.command({
        type: "add_plugin",
        manifestUrl: `${h.baseUrl}/manifest.json`,
        publicKey: wrongKey,
      }),
      /签名/,
    );
    assert.equal(h.snapshot.plugins.length, 0);
    await h.command({
      type: "add_plugin",
      manifestUrl: `${h.baseUrl}/manifest.json`,
      publicKey: h.publicPem,
    });
    assert.equal(h.snapshot.plugins[0].running, true);
    assert.equal((await h.command(call(pluginId, "info"))).platform, process.platform);
    await h.command(call(pluginId, "save_note", "persistent note 中文"));
    assert.equal(await h.command(call(pluginId, "read_note")), "persistent note 中文");
    const ui = await h.command({ type: "plugin_ui", pluginId });
    const page = await fetch(ui.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /系统信息与便笺/);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    const rpcUrl = new URL("rpc", ui.url);
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "null" },
      body: JSON.stringify({ method: "read_note", input: null }),
    });
    assert.equal((await response.json()).result, "persistent note 中文");
    assert.equal(response.headers.get("access-control-allow-origin"), "null");
    assert.equal(
      (await fetch(rpcUrl, { method: "POST", headers: { origin: "https://evil.invalid" } })).status,
      403,
    );
    assert.equal((await fetch(new URL("/incorrect/ui", ui.url))).status, 404);
    const downloads = h.requests.filter((r) => r.path.endsWith(".zip")).length;
    await h.command({ type: "check_updates" });
    assert(h.requests.some((r) => r.path === "/manifest.json" && r.etag));
    assert.equal(h.requests.filter((r) => r.path.endsWith(".zip")).length, downloads);
    await h.stop();
    h.offline = true;
    await h.start();
    assert.equal(h.snapshot.plugins[0].running, true, "restores cache before checking the network");
    assert.equal(await h.command(call(pluginId, "read_note")), "persistent note 中文");
    await h.command({ type: "set_enabled", pluginId, enabled: false });
    await assert.rejects(h.command(call(pluginId, "info")), /未运行/);
    await h.stop();
    await h.start();
    assert.equal(h.snapshot.plugins[0].enabled, false);
    assert.equal(h.snapshot.plugins[0].running, false);
    assert.equal(h.snapshot.plugins[0].revision, manifest.artifactSha256);
  },
);

test(
  "hot update: failed candidate keeps old generation and pause releases resources",
  { timeout: 60000 },
  async (t) => {
    const h = await createHarness();
    t.after(() => h.close());
    const id = "com.test.lifecycle";
    await h.buildFixture("1.0.0");
    await h.start();
    await h.command({
      type: "add_plugin",
      manifestUrl: `${h.baseUrl}/manifest.json`,
      publicKey: h.publicPem,
    });
    assert.equal(await h.command(call(id, "version")), "1.0.0");
    await h.buildFixture("2.0.0", { fail: true });
    assert.equal((await h.command({ type: "check_updates" })).failures, 1);
    assert.equal(h.snapshot.plugins[0].status, "error");
    assert.equal(h.snapshot.plugins[0].running, true);
    assert.equal(await h.command(call(id, "version")), "1.0.0");
    await h.buildFixture("3.0.0");
    assert.equal((await h.command({ type: "check_updates" })).failures, 0);
    assert.equal(await h.command(call(id, "version")), "3.0.0");
    await h.command({ type: "set_enabled", pluginId: id, enabled: false });
    const ticks = join(h.directory, "data/data", id, "ticks");
    const stopped = await readFile(ticks, "utf8");
    await delay(150);
    assert.equal(await readFile(ticks, "utf8"), stopped, "pause disposes plugin timers");
    await h.stop();
    await h.start();
    assert.equal(h.snapshot.plugins[0].running, false);
    await h.command({ type: "set_enabled", pluginId: id, enabled: true });
    assert.equal(await h.command(call(id, "version")), "3.0.0");
    await h.command({ type: "remove_plugin", pluginId: id });
    await assert.rejects(h.command(call(id, "version")), /未运行/);
    assert.equal(h.snapshot.plugins.length, 0);
  },
);

test(
  "signed catalogue discovers/removes plugins, preserves pause and honours manual updates",
  { timeout: 60000 },
  async (t) => {
    const h = await createHarness();
    t.after(() => h.close());
    const first = await h.buildFixture("1.0.0");
    h.catalog([first]);
    await h.start();
    await h.command({ type: "set_settings", settings: settings(h) });
    assert.equal(h.snapshot.plugins.length, 1);
    assert(h.snapshot.plugins[0].running);
    await h.command({ type: "set_enabled", pluginId: first.id, enabled: false });
    const second = await h.buildFixture("1.0.0", { id: "com.test.second" });
    h.catalog([first, second]);
    await h.command({ type: "check_updates" });
    assert.equal(h.snapshot.plugins.find((p) => p.id === first.id).running, false);
    assert.equal(h.snapshot.plugins.find((p) => p.id === second.id).running, true);
    const next = await h.buildFixture("2.0.0", { id: second.id });
    h.catalog([first, next]);
    await h.command({ type: "set_settings", settings: settings(h, false) });
    assert.equal(await h.command(call(second.id, "version")), "1.0.0");
    await h.command({ type: "install", pluginId: second.id });
    assert.equal(await h.command(call(second.id, "version")), "2.0.0");
    h.catalog([next]);
    await h.command({ type: "check_updates" });
    assert.equal(h.snapshot.plugins.length, 1);
    assert.equal(h.snapshot.plugins[0].id, second.id);
    await h.command({ type: "remove_plugin", pluginId: second.id });
    await h.command({ type: "check_updates" });
    assert.equal(
      h.snapshot.plugins.length,
      0,
      "manually removed catalogue plugin is not silently re-added",
    );
  },
);

test(
  "tampering and malformed archives are rejected before replacing running code",
  { timeout: 60000 },
  async (t) => {
    const h = await createHarness();
    t.after(() => h.close());
    const first = await h.buildFixture("1.0.0");
    await h.start();
    await h.command({
      type: "add_plugin",
      manifestUrl: `${h.baseUrl}/manifest.json`,
      publicKey: h.publicPem,
    });
    h.routes.set("/manifest.json", Buffer.from(JSON.stringify({ ...first, name: "tampered" })));
    assert.equal((await h.command({ type: "check_updates" })).failures, 1);
    assert.equal(await h.command(call(first.id, "version")), "1.0.0");
    const zip = zipSync({ "../escaped.txt": new TextEncoder().encode("escape") });
    h.routes.set("/bad.zip", zip);
    const bad = signed(
      {
        ...first,
        signature: undefined,
        version: "2.0.0",
        artifactUrl: `${h.baseUrl}/bad.zip`,
        artifactSha256: createHash("sha256").update(zip).digest("hex"),
      },
      h.privateKey,
    );
    h.routes.set("/manifest.json", Buffer.from(JSON.stringify(bad)));
    assert.equal((await h.command({ type: "check_updates" })).failures, 1);
    assert.match(h.snapshot.plugins[0].error, /非法路径/);
    assert.equal(await h.command(call(first.id, "version")), "1.0.0");
    h.routes.set("/bad.zip", Buffer.from("tampered archive"));
    await assert.rejects(h.command({ type: "install", pluginId: first.id }), /SHA-256/);
  },
);

test("Windows paths and version validation reject traversal; unchanged builds keep the same digest", async (t) => {
  for (const id of ["..", "CON", "nul.txt", "plugin.", "a/b"]) assert.throws(() => assertId(id));
  for (const path of ["../x", "C:/x", "a/../../x", "a\\b", "a:b", "x/nul", "a."])
    assert.throws(() => safePath("C:/staging", path));
  const h = await createHarness();
  t.after(() => h.close());
  const a = await h.buildExample(),
    b = await h.buildExample();
  assert.equal(a.artifactSha256, b.artifactSha256);
  assert.doesNotThrow(() => assertManifest(a));
  assert.throws(() => assertManifest({ ...a, version: "../x" }));
});
