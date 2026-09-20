import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { verifyRelease } from "../controller/src/domain/releases.ts";
import { CHORD_VERSION } from "../shared/versions.ts";
import { manifest, publisher, signed } from "./helpers.mjs";
import { createTransportHarness } from "./transport-harness.mjs";

test("Chord compatibility accepts only current and audited predecessor without rewriting signed metadata", () => {
  const key = publisher();
  for (const chordVersion of ["0.85.1", CHORD_VERSION]) {
    const release = signed(manifest("test.compat", { chordVersion }), key.privateKey);
    const before = JSON.stringify(release);
    verifyRelease(release, key.publicKey, false);
    assert.equal(JSON.stringify(release), before);
    assert.throws(() => verifyRelease({ ...release, name: "tampered" }, key.publicKey, false));
  }
  for (const chordVersion of ["0.85.0", "0.86.0", "0.87.0", "1.0.0"])
    assert.throws(
      () =>
        verifyRelease(
          signed(manifest("test.compat", { chordVersion }), key.privateKey),
          key.publicKey,
          false,
        ),
      /插件与当前主程序不兼容/,
    );
});
test(
  "real Chord runtime loads signed predecessor bundles across restart and updates to current runtime",
  { timeout: 30000 },
  async (t) => {
    const h = await createTransportHarness();
    t.onTestFinished(() => h.close());
    await h.start();
    const old = await h.fixture("1.0.0", { id: "test.chord-upgrade", chordVersion: "0.85.1" });
    await h.add(old);
    assert.equal(h.snapshot.plugins.find((p) => p.id === old.id).running, true);
    await h.stop();
    await h.start();
    assert.equal(h.snapshot.plugins.find((p) => p.id === old.id).running, true);
    await h.fixture("1.1.0", { id: old.id, chordVersion: CHORD_VERSION });
    const result = await h.command({ type: "check_updates" });
    assert.equal(result.failures, 0);
    const plugin = h.snapshot.plugins.find((p) => p.id === old.id);
    assert.equal(plugin.version, "1.1.0");
    assert.equal(plugin.running, true);
  },
);
