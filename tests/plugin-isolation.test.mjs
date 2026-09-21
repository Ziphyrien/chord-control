import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applicationFixture, manifest, registration } from "./helpers.mjs";

// Use the shipped service declarations so a new accidental dependency joins this transaction.
test("wallpaper activation failure cannot roll back the browser and password update group", async (t) => {
  const packages = await Promise.all(
    ["password-pad", "app-guard", "study-guard", "wallpaper-policy"].map(async (name) =>
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
    }),
  );
  const wallpaper = releases.find((item) => item.id === "com.chord.wallpaper-policy");
  const previous = releases
    .filter((item) => item !== wallpaper)
    .map((item) => ({ ...item, version: "0.0.1" }));
  const h = await applicationFixture(previous.map((item) => registration(item)));
  t.onTestFinished(() => h.service.close());
  h.catalog = {
    format: 1,
    plugins: releases.map((item) => ({ ...item, artifactSha256: "b".repeat(64) })),
  };
  h.failActivate = [`${wallpaper.id}@${wallpaper.version}`];
  assert.equal((await h.service.checkUpdates()).failures, 1);
  const summaries = h.service.summaries();
  for (const release of releases.filter((item) => item !== wallpaper)) {
    const item = summaries.find((row) => row.id === release.id);
    assert.equal(item.version, release.version);
    assert.equal(item.running, true);
    assert.equal(item.error, undefined);
  }
  assert.equal(summaries.find((item) => item.id === wallpaper.id).running, false);
  const failure = h.events.find((event) => event[0] === "插件更新失败");
  assert.match(failure[1], /com\.chord\.wallpaper-policy/);
  assert.doesNotMatch(failure[1], /com\.chord\.(study-guard|password-pad|app-guard)/);
});
