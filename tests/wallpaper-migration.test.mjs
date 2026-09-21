import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WallpaperPolicy } from "../plugins/wallpaper-policy/src/wallpaper.ts";
import { LegacyMigration } from "../plugins/wallpaper-policy/src/migration.ts";
import { WallpaperPolicy as OldPolicy } from "./wallpaper-legacy-fixture.ts";
import {
  POLICY_KEYS,
  policyValues,
  stringValue,
} from "../plugins/wallpaper-policy/src/registry.ts";
import { parseBackup, withJournalLock } from "../plugins/wallpaper-policy/src/journal.ts";

const faults = vi.hoisted(() => ({ rename: undefined, remove: undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    async rename(from, to) {
      await actual.rename(from, to);
      await faults.rename?.(from, to);
    },
    async rm(path, options) {
      await actual.rm(path, options);
      await faults.remove?.(path);
    },
  };
});
const original = "C:\\Personal\\original.jpg";
const key = (value) => `${value.path}|${value.name}`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "chord-migration-"));
  const directory = join(root, "data", "com.chord.wallpaper-policy");
  const legacy = join(root, "data", "com.chord.study-guard");
  const systemRoot = join(root, "Windows");
  const stock = join(systemRoot, "Web", "Wallpaper", "Windows", "img0.jpg");
  await mkdir(join(stock, ".."), { recursive: true });
  await writeFile(stock, "stock");
  t.onTestFinished(async () => {
    faults.rename = faults.remove = undefined;
    await rm(root, { recursive: true, force: true });
  });
  const h = {
    root,
    directory,
    legacy,
    systemRoot,
    stock,
    wallpaper: original,
    values: new Map(),
    calls: [],
    fault: () => {},
  };
  h.host = {
    async native(operation, input) {
      h.calls.push({ operation, input });
      h.fault(operation, input);
      if (operation === "wallpaper.get") return h.wallpaper;
      if (operation === "wallpaper.set") {
        h.wallpaper = input.path;
        return null;
      }
      if (operation === "registry.read") return structuredClone(h.values.get(key(input)) ?? null);
      if (operation === "registry.write") {
        if (input.value === null) h.values.delete(key(input));
        else h.values.set(key(input), structuredClone(input.value));
        return null;
      }
      throw new Error(`Unexpected ${operation}`);
    },
  };
  h.policy = () => new WallpaperPolicy(h.host, directory, () => systemRoot);
  h.old = () => new OldPolicy(h.host, legacy, () => systemRoot);
  h.config = (version = "1.3.0", enabled = true) =>
    writeFile(
      join(root, "config.json"),
      JSON.stringify({
        format: 3,
        plugins: [
          {
            id: "com.chord.study-guard",
            enabled,
            installed: { id: "com.chord.study-guard", version },
          },
        ],
      }),
    );
  h.backup = (dir = directory) => join(dir, "wallpaper-native-backup.json");
  h.lease = (dir = directory) => join(dir, "wallpaper-policy-owner.txt");
  h.receipt = join(directory, "wallpaper-migration-receipt.json");
  return h;
}
async function absent(path) {
  await assert.rejects(readFile(path), { code: "ENOENT" });
}
async function recovered(h) {
  assert.equal(h.wallpaper, original);
  assert.equal(h.values.size, 0);
  await absent(h.backup());
  await absent(h.lease());
  await absent(h.receipt);
  assert.deepEqual(await readdir(h.legacy), []);
}

test("fresh install and successful old dispose never touch legacy state or read host configuration", async (t) => {
  const fresh = await fixture(t);
  const policy = fresh.policy();
  await policy.apply();
  await policy.restore();
  await assert.rejects(readdir(fresh.legacy), { code: "ENOENT" });
  const h = await fixture(t);
  const old = h.old();
  await old.apply();
  await old.restore();
  // Even stale installed metadata is irrelevant when normal old dispose completed.
  await h.config("1.2.3");
  const next = h.policy();
  await next.apply();
  assert.deepEqual(await readdir(h.legacy), []);
  await next.restore();
  await recovered(h);
});

test("active old browser versions defer takeover without revoking their lease or making native calls", async (t) => {
  for (const version of ["1.2.1", "1.2.3", "1.3.0-rc.1", "invalid"]) {
    const h = await fixture(t);
    const old = h.old();
    await old.apply();
    await h.config(version);
    const before = await readFile(h.backup(h.legacy), "utf8");
    h.calls.length = 0;
    const next = h.policy();
    await assert.rejects(next.apply(), /1\.3\.0/);
    await next.restore();
    assert.equal(h.calls.length, 0);
    assert.equal(await old.owns(), true);
    assert.equal(await readFile(h.backup(h.legacy), "utf8"), before);
    await absent(h.receipt);
    await old.restore();
  }
});

test("missing or malformed configuration cannot revoke a legacy owner", async (t) => {
  const h = await fixture(t);
  const old = h.old();
  await old.apply();
  for (const text of [
    undefined,
    "{}",
    "not json",
    '{"format":3,"plugins":[]}',
    '{"format":3,"plugins":[null]}',
  ]) {
    if (text !== undefined) await writeFile(join(h.root, "config.json"), text);
    await assert.rejects(h.policy().apply(), /无法确认/);
    assert.equal(await old.owns(), true);
  }
  await old.restore();
});

test("active journal takeover preserves first originals and old dispose cannot restore new policy", async (t) => {
  const h = await fixture(t);
  const initial = stringValue("before either plugin", 2);
  const entry = { path: POLICY_KEYS[2][0], name: POLICY_KEYS[2][1] };
  h.values.set(key(entry), initial);
  const old = h.old();
  await old.apply();
  await h.config();
  const next = h.policy();
  await next.apply();
  assert.equal(await old.owns(), false);
  await old.restore();
  assert.equal(h.wallpaper, h.stock);
  assert.equal(parseBackup(await readFile(h.backup(), "utf8")).originalWallpaper, original);
  assert.equal(parseBackup(await readFile(h.backup(h.legacy), "utf8")).originalWallpaper, original);
  await next.restore();
  assert.equal(h.wallpaper, original);
  assert.deepEqual([...h.values], [[key(entry), initial]]);
  await absent(h.receipt);
});

test("failed old activation and partial old restore both migrate recoverable first originals", async (t) => {
  for (const phase of ["applying", "restoring"]) {
    const h = await fixture(t);
    const old = h.old();
    if (phase === "applying") {
      h.fault = (operation, input) => {
        if (
          (operation === "wallpaper.set" && input.path === h.stock) ||
          (operation === "registry.write" && input.value === null)
        )
          throw new Error("denied");
      };
      await assert.rejects(old.apply(), /保留恢复备份/);
    } else {
      await old.apply();
      h.fault = (operation, input) => {
        if (operation === "registry.write" && input.name === "TileWallpaper")
          throw new Error("denied");
      };
      await assert.rejects(old.restore(), /保留备份/);
    }
    assert.equal(parseBackup(await readFile(h.backup(h.legacy), "utf8")).phase, phase);
    h.fault = () => {};
    await h.config();
    const next = h.policy();
    await next.apply();
    await old.restore();
    await next.restore();
    await recovered(h);
  }
});

test("legacy PowerShell BOM source migrates and preserves manual changes", async (t) => {
  const h = await fixture(t);
  await mkdir(h.legacy, { recursive: true });
  const custom = join(h.legacy, "study-wallpaper.jpg");
  const installed = [1, custom, "4", "10", "0"];
  const entries = POLICY_KEYS.map(([path, name], index) => ({
    original: { path, name, present: false },
    installed: {
      path,
      name,
      present: true,
      kind: index === 0 ? "DWord" : "String",
      value: installed[index],
    },
  }));
  await writeFile(
    join(h.legacy, "wallpaper-policy-backup.json"),
    "\uFEFF" + JSON.stringify({ entries, wallpaper: custom, originalWallpaper: original }),
  );
  await writeFile(h.lease(h.legacy), "old-powershell-owner");
  for (const [index, [path, name]] of POLICY_KEYS.entries())
    h.values.set(key({ path, name }), policyValues(custom)[index]);
  h.wallpaper = "C:\\User\\manual.jpg";
  const edited = key({ path: POLICY_KEYS[4][0], name: POLICY_KEYS[4][1] });
  const manual = stringValue("manual setting");
  h.values.set(edited, manual);
  await h.config();
  const next = h.policy();
  await next.apply();
  assert.equal(parseBackup(await readFile(h.backup(), "utf8")).entries[0].original, null);
  await next.restore();
  assert.equal(h.wallpaper, "C:\\User\\manual.jpg");
  assert.deepEqual([...h.values], [[edited, manual]]);
  assert.deepEqual(await readdir(h.legacy), []);
});

test("old-version reactivation wins its UUID lease; new dispose leaves its journal and originals intact", async (t) => {
  const h = await fixture(t);
  await h.old().apply();
  await h.config();
  const next = h.policy();
  await next.apply();
  const rollback = h.old();
  await rollback.apply();
  await h.config("1.2.3");
  const before = await readFile(h.backup(h.legacy), "utf8");
  await next.restore();
  assert.equal(await rollback.owns(), true);
  assert.equal(await readFile(h.backup(h.legacy), "utf8"), before);
  await assert.rejects(h.policy().apply(), /1\.3\.0/);
  await rollback.restore();
  assert.equal(h.wallpaper, original);
  await h.config();
  const resume = h.policy();
  await resume.apply();
  await resume.restore();
  await recovered(h);
});

test("manual edit after old rollback restoration is not overwritten by stale migrated journal", async (t) => {
  const h = await fixture(t);
  await h.old().apply();
  await h.config();
  await h.policy().apply();
  const rollback = h.old();
  await rollback.apply();
  await rollback.restore();
  h.wallpaper = "C:\\Personal\\after-rollback.jpg";
  const next = h.policy();
  await next.apply();
  await next.restore();
  assert.equal(h.wallpaper, "C:\\Personal\\after-rollback.jpg");
});

test("registry denial after migration retains an owned recovery journal for activation cleanup", async (t) => {
  const h = await fixture(t);
  await h.old().apply();
  await h.config();
  h.fault = (operation) => {
    if (operation === "registry.read") throw new Error("denied");
  };
  const next = h.policy();
  await assert.rejects(next.apply(), /denied/);
  assert.equal(await next.owns(), true);
  h.fault = () => {};
  await next.restore();
  await recovered(h);
});

test("crash after each migration publication replays the staged copy without losing originals", async (t) => {
  // Initial receipt, old lease revocation, new copy, compatible old copy,
  // new lease publication, active receipt. Fail after the atomic rename landed.
  for (let crash = 1; crash <= 6; crash++) {
    const h = await fixture(t);
    const old = h.old();
    await old.apply();
    await h.config();
    let writes = 0;
    faults.rename = (_from, to) => {
      if (
        (to === h.receipt ||
          to === h.backup() ||
          to === h.backup(h.legacy) ||
          to === h.lease() ||
          to === h.lease(h.legacy)) &&
        ++writes === crash
      )
        throw new Error("crash");
    };
    await assert.rejects(
      withJournalLock(h.directory, () =>
        new LegacyMigration(h.directory).run(true, randomUUID(), async () => {}),
      ),
      /crash/,
    );
    faults.rename = undefined;
    const next = h.policy();
    await next.apply();
    await old.restore();
    await next.restore();
    await recovered(h);
  }
});

test("crash before revocation re-reads a source changed by old dispose", async (t) => {
  const h = await fixture(t);
  const old = h.old();
  await old.apply();
  await h.config();
  faults.rename = (_from, to) => {
    if (to === h.receipt) throw new Error("crash");
  };
  await assert.rejects(h.policy().apply(), /crash/);
  faults.rename = undefined;
  await old.restore();
  h.wallpaper = "C:\\User\\after-dispose.jpg";
  const next = h.policy();
  await next.apply();
  await next.restore();
  assert.equal(h.wallpaper, "C:\\User\\after-dispose.jpg");
});

test("interrupted restore cleanup does not replay an already restored legacy policy", async (t) => {
  for (const target of ["old-backup", "old-lease", "new-backup", "receipt"]) {
    const h = await fixture(t);
    await h.old().apply();
    await h.config();
    const policy = h.policy();
    await policy.apply();
    const path = {
      "old-backup": h.backup(h.legacy),
      "old-lease": h.lease(h.legacy),
      "new-backup": h.backup(),
      receipt: h.receipt,
    }[target];
    faults.remove = (removed) => {
      if (removed === path) throw new Error("crash");
    };
    await assert.rejects(policy.restore(), /crash/);
    faults.remove = undefined;
    assert.equal(h.wallpaper, original);
    const next = h.policy();
    await next.apply();
    await next.restore();
    await recovered(h);
  }
});

test("new activation rollback keeps migrated originals and compatibility journal recoverable", async (t) => {
  const h = await fixture(t);
  const oldRoot = join(h.root, "oldWindows");
  const oldStock = join(oldRoot, "Web", "Wallpaper", "Windows", "img0.jpg");
  await mkdir(join(oldStock, ".."), { recursive: true });
  await writeFile(oldStock, "old stock");
  const old = new OldPolicy(h.host, h.legacy, () => oldRoot);
  await old.apply();
  await h.config();
  h.fault = (operation, input) => {
    if (operation === "wallpaper.set" && input.path === h.stock)
      throw new Error("new activation denied");
  };
  const next = h.policy();
  await assert.rejects(next.apply(), /new activation denied/);
  assert.equal(h.wallpaper, oldStock);
  assert.equal(await next.owns(), true);
  assert.equal(await old.owns(), false);
  const saved = parseBackup(await readFile(h.backup(h.legacy), "utf8"));
  assert.equal(saved.originalWallpaper, original);
  assert.equal(saved.wallpaper, oldStock);
  h.fault = () => {};
  await next.restore();
  await recovered(h);
});

test("old dispose racing a migration serializes on the legacy journal lock", async (t) => {
  for (const oldFirst of [true, false]) {
    const h = await fixture(t);
    const old = h.old();
    await old.apply();
    await h.config();
    let release, entered;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const lock = withJournalLock(h.legacy, async () => {
      entered();
      await gate;
    });
    await ready;
    const next = h.policy();
    const work = oldFirst ? [old.restore(), next.apply()] : [next.apply(), old.restore()];
    release();
    await Promise.all([lock, ...work]);
    assert.equal(h.wallpaper, h.stock);
    await next.restore();
    await recovered(h);
  }
});

test("disabled old registration without an owner can migrate an orphaned first-original journal", async (t) => {
  const h = await fixture(t);
  await h.old().apply();
  await rm(h.lease(h.legacy));
  await h.config("1.2.3", false);
  const next = h.policy();
  await next.apply();
  await next.restore();
  await recovered(h);
});
