import test from "node:test";
import assert from "node:assert/strict";
import { basename, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { buildPlugin } from "../scripts/build-plugins.mjs";
import { createHarness } from "./helpers.mjs";

function passwordFor(date = new Date()) {
  return `${date.getMonth() + 1 + date.getDate()}${["S", "M", "T", "W", "T", "F", "S"][date.getDay()]}`;
}
function findPath(cells, password, size = 6) {
  const visit = (path) => {
    if (path.length === password.length) return path;
    const previous = path.at(-1);
    for (let index = 0; index < cells.length; index++) {
      if (path.includes(index) || cells[index] !== password[path.length]) continue;
      if (
        previous !== undefined &&
        (Math.abs((previous % size) - (index % size)) > 1 ||
          Math.abs(Math.floor(previous / size) - Math.floor(index / size)) > 1)
      )
        continue;
      const result = visit([...path, index]);
      if (result) return result;
    }
    return null;
  };
  return visit([]);
}
async function addBuilt(h, directory, path) {
  const manifest = await buildPlugin({
    directory: resolve(directory),
    outdir: h.buildDir,
    baseUrl: h.baseUrl,
    privateKey: h.privateKey,
  });
  const artifact = await readFile(
    join(h.buildDir, basename(new URL(manifest.artifactUrl).pathname)),
  );
  h.routes.set(new URL(manifest.artifactUrl).pathname, artifact);
  h.routes.set(path, Buffer.from(JSON.stringify(manifest)));
  await h.command({
    type: "add_plugin",
    manifestUrl: `${h.baseUrl}${path}`,
    publicKey: h.publicPem,
  });
  return manifest;
}
async function waitForChallenge(h, pluginId) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const value = await h.command({
      type: "plugin_call",
      pluginId,
      method: "challenge",
      input: null,
    });
    if (value) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("密保盘挑战未出现");
}

test("generic Chord services bind late and protect desktop open", async () => {
  process.env.CHORD_CONTROL_NATIVE_TEST = "1";
  const h = await createHarness();
  const passwordId = "com.chord.password-pad";
  try {
    await h.start();
    await addBuilt(h, "plugins/app-guard", "/guard.json");
    await assert.rejects(
      h.command({ type: "desktop_action", action: "open" }),
      /binding is closed|依赖服务未运行/,
    );
    await addBuilt(h, "plugins/password-pad", "/password.json");
    const opening = h.command({ type: "desktop_action", action: "open" });
    const challenge = await waitForChallenge(h, passwordId);
    const wrongPath = findPath(challenge.cells, "0X") ?? [0];
    const wrong = await h.command({
      type: "plugin_call",
      pluginId: passwordId,
      method: "submit",
      input: { id: challenge.id, path: wrongPath },
    });
    assert.equal(wrong.approved, false);
    const fresh = await waitForChallenge(h, passwordId);
    const path = findPath(fresh.cells, passwordFor());
    assert(path, "daily password must be represented by adjacent cells");
    const approved = await h.command({
      type: "plugin_call",
      pluginId: passwordId,
      method: "submit",
      input: { id: fresh.id, path },
    });
    assert.equal(approved.approved, true);
    assert.equal(await opening, null);
    const secondOpening = h.command({ type: "desktop_action", action: "open" });
    const second = await waitForChallenge(h, passwordId);
    const secondPath = findPath(second.cells, passwordFor());
    assert(secondPath);
    await h.command({
      type: "plugin_call",
      pluginId: passwordId,
      method: "submit",
      input: { id: second.id, path: secondPath },
    });
    assert.equal(await secondOpening, null);
  } finally {
    await h.close();
    delete process.env.CHORD_CONTROL_NATIVE_TEST;
  }
});
