import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authorizationTitle } from "../plugins/app-guard/src/policy.ts";
import { Notes } from "../plugins/system-info/src/notes.ts";

test("generic guard hooks authorize desktop/settings and affected protected plugins", () => {
  for (const action of ["desktop.open", "desktop.quit", "set_settings"])
    assert.equal(typeof authorizationTitle(action, null), "string");
  for (const pluginId of ["com.chord.password-pad", "com.chord.app-guard"]) {
    assert.equal(typeof authorizationTitle("set_enabled", { pluginId, enabled: false }), "string");
    assert.equal(typeof authorizationTitle("remove_plugin", { pluginId }), "string");
    assert.equal(authorizationTitle("set_enabled", { pluginId, enabled: true }), undefined);
    assert.equal(
      typeof authorizationTitle("remove_plugin", {
        pluginId: "other.provider",
        affectedPluginIds: [pluginId],
      }),
      "string",
    );
  }
  for (const input of [
    null,
    [],
    "x",
    { pluginId: "other" },
    { pluginId: "toString" },
    { pluginId: "com.chord.study-guard" },
  ])
    assert.equal(authorizationTitle("remove_plugin", input), undefined);
  assert.equal(authorizationTitle("window_closed", null), undefined);
});

async function notesFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "chord-notes-test-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return { directory, notes: new Notes(directory) };
}
test("notes preserve plain text, order writes, and reject invalid writes without data loss", async (t) => {
  const { directory, notes } = await notesFixture(t);
  assert.equal(await notes.read(), "");
  await Promise.all([
    notes.save("first"),
    notes.save("第二行\n<html>text</html>"),
    notes.save("last\n"),
  ]);
  assert.equal(await notes.read(), "last\n");
  assert.equal(await readFile(join(directory, "note.txt"), "utf8"), "last\n");
  for (const value of [null, {}, "x".repeat(10001)])
    await assert.rejects(notes.save(value), /10000/);
  assert.equal(await notes.read(), "last\n");
  await notes.save("x".repeat(10000));
  assert.equal((await notes.read()).length, 10000);
  assert.deepEqual(await readdir(directory), ["note.txt"]);
});
test("failed atomic note replacement does not poison subsequent saves", async (t) => {
  const { directory, notes } = await notesFixture(t);
  await mkdir(join(directory, "note.txt"));
  await assert.rejects(notes.save("cannot replace directory"));
  assert.deepEqual(await readdir(directory), ["note.txt"]);
  await rm(join(directory, "note.txt"), { recursive: true });
  await notes.save("recovered");
  await notes.drain();
  assert.equal(await notes.read(), "recovered");
});
