import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WallpaperPolicy } from "../plugins/study-guard/src/wallpaper.ts";
import {
  POLICY_KEYS,
  policyValues,
  stringValue,
  dwordValue,
  legacyValue,
} from "../plugins/study-guard/src/registry.ts";
import { parseBackup, withJournalLock } from "../plugins/study-guard/src/journal.ts";
const originalWallpaper = "C:\\Original\\wallpaper.jpg";
const key = (entry) => `${entry.path}|${entry.name}`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "chord-policy-test-"));
  const systemRoot = join(root, "Windows");
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const stock = join(systemRoot, "Web", "Wallpaper", "Windows", "img0.jpg");
  await mkdir(join(stock, ".."), { recursive: true });
  await writeFile(stock, "fixture only");
  const data = join(root, "data");
  const h = {
    data,
    stock,
    wallpaper: originalWallpaper,
    values: new Map(),
    calls: [],
    /** @type {(operation: string, input: unknown, phase: string) => void | Promise<void>} */
    fault: () => {},
  };
  h.backup = join(data, "wallpaper-native-backup.json");
  h.lease = join(data, "wallpaper-policy-owner.txt");
  h.host = {
    async native(operation, input) {
      h.calls.push({ operation, input: structuredClone(input) });
      await h.fault(operation, input, "before");
      let value = null;
      switch (operation) {
        case "registry.read":
          value = structuredClone(h.values.get(key(input)) ?? null);
          break;
        case "registry.write":
          if (input.value === null) h.values.delete(key(input));
          else h.values.set(key(input), structuredClone(input.value));
          break;
        case "wallpaper.get":
          value = h.wallpaper;
          break;
        case "wallpaper.set":
          h.wallpaper = input.path;
          break;
        default:
          throw new Error(`Unexpected native operation: ${operation}`);
      }
      await h.fault(operation, input, "after");
      return value;
    },
  };
  h.policy = () => new WallpaperPolicy(h.host, data, () => systemRoot);
  h.save = async (value, legacy = false) => {
    await mkdir(data, { recursive: true });
    await writeFile(
      legacy ? join(data, "wallpaper-policy-backup.json") : h.backup,
      JSON.stringify(value),
    );
  };
  return h;
}
function entries(wallpaper) {
  return POLICY_KEYS.map(([path, name], index) => ({
    path,
    name,
    original: null,
    installed: policyValues(wallpaper)[index],
    managed: true,
  }));
}
async function absent(path) {
  await assert.rejects(readFile(path), { code: "ENOENT" });
}

test("stock path and literal HKCU paths; hot replacement restores first originals", async (t) => {
  const h = await fixture(t);
  assert.equal(
    POLICY_KEYS[0][0],
    "Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\ActiveDesktop",
  );
  assert.equal(POLICY_KEYS[3][0], "Control Panel\\Desktop");
  const initial = stringValue("preexisting", 2);
  h.values.set(key(entries(h.stock)[2]), initial);
  const first = h.policy(),
    second = h.policy();
  await first.apply();
  assert.equal(h.wallpaper, h.stock);
  assert.equal(h.values.size, 5);
  await second.apply();
  await first.restore();
  assert.equal(h.wallpaper, h.stock);
  await second.restore();
  assert.equal(h.wallpaper, originalWallpaper);
  assert.deepEqual([...h.values], [[key(entries(h.stock)[2]), initial]]);
  assert.deepEqual(await readdir(h.data), []);
});

test("external registry and wallpaper edits survive replacement and restore", async (t) => {
  const h = await fixture(t),
    first = h.policy();
  await first.apply();
  const changed = key(entries(h.stock)[4]);
  const external = { type: 3, bytes: [99, 0, 17] };
  h.values.set(changed, external);
  h.wallpaper = "C:\\User\\new.jpg";
  const replacement = h.policy();
  await replacement.apply();
  await first.restore();
  await replacement.restore();
  assert.deepEqual([...h.values], [[changed, external]]);
  assert.equal(h.wallpaper, "C:\\User\\new.jpg");
});

test("missing stock image causes zero native calls and no backup", async (t) => {
  const h = await fixture(t);
  await rm(h.stock);
  await assert.rejects(h.policy().apply(), /Windows 默认壁纸/);
  assert.equal(h.calls.length, 0);
  await absent(h.backup);
});

test("apply failure, including mutate-then-throw, rolls back every attempted value", async (t) => {
  for (const stage of ["before", "after"]) {
    const h = await fixture(t);
    h.fault = (operation, input, timing) => {
      if (operation === "wallpaper.set" && input.path === h.stock && timing === stage)
        throw new Error("set failed");
    };
    await assert.rejects(h.policy().apply(), /set failed/);
    assert.equal(h.values.size, 0);
    assert.equal(h.wallpaper, originalWallpaper);
    await absent(h.backup);
    await absent(h.lease);
  }
});

test("failed rollback retains an owned journal; dispose retries recovery", async (t) => {
  const h = await fixture(t),
    policy = h.policy();
  h.fault = (operation, input, stage) => {
    if (
      stage === "before" &&
      ((operation === "wallpaper.set" && input.path === h.stock) ||
        (operation === "registry.write" && input.value === null))
    )
      throw new Error("offline");
  };
  await assert.rejects(policy.apply(), /保留恢复备份/);
  assert.equal(await policy.owns(), true);
  assert.equal(parseBackup(await readFile(h.backup, "utf8")).phase, "applying");
  assert.equal(h.values.size, 5);
  h.fault = () => {};
  await policy.restore();
  assert.equal(h.values.size, 0);
  await absent(h.backup);
});

test("restore errors retain data and allow a later generation to finish", async (t) => {
  const h = await fixture(t),
    first = h.policy();
  await first.apply();
  let failed = false;
  h.fault = (operation, input, stage) => {
    if (
      !failed &&
      stage === "before" &&
      operation === "registry.write" &&
      input.name === "TileWallpaper"
    ) {
      failed = true;
      throw new Error("restore failed");
    }
  };
  await assert.rejects(first.restore(), /保留备份/);
  assert.equal(parseBackup(await readFile(h.backup, "utf8")).phase, "restoring");
  h.fault = () => {};
  const next = h.policy();
  await next.apply();
  await first.restore();
  await next.restore();
  assert.equal(h.values.size, 0);
  assert.equal(h.wallpaper, originalWallpaper);
  await absent(h.backup);
});

test("0.2.0 raw journal migrates the active custom image while retaining originals", async (t) => {
  const h = await fixture(t);
  const custom = join(h.data, "study-wallpaper.jpg");
  const oldEntries = entries(custom).map(({ managed: _managed, ...entry }) => entry);
  oldEntries[0].original = dwordValue(7);
  h.wallpaper = custom;
  for (const entry of oldEntries) h.values.set(key(entry), entry.installed);
  await h.save({ entries: oldEntries, wallpaper: custom, originalWallpaper });
  await writeFile(custom, "user-owned replacement image: retain");
  const policy = h.policy();
  await policy.apply();
  assert.equal(h.wallpaper, h.stock);
  await policy.restore();
  assert.equal(h.wallpaper, originalWallpaper);
  assert.deepEqual([...h.values], [[key(oldEntries[0]), dwordValue(7)]]);
  assert.equal(await readFile(custom, "utf8"), "user-owned replacement image: retain");
});

test("PowerShell BOM journal and old lease migrate without running scripts", async (t) => {
  const h = await fixture(t),
    custom = join(h.data, "study-wallpaper.jpg");
  const installed = [1, custom, "4", "10", "0"];
  const oldEntries = POLICY_KEYS.map(([path, name], index) => ({
    original: { path, name, present: false },
    installed: {
      path,
      name,
      present: true,
      kind: index === 0 ? "DWord" : "String",
      value: installed[index],
    },
  }));
  oldEntries[1].original = {
    ...oldEntries[1].original,
    present: true,
    kind: "ExpandString",
    value: "%USERPROFILE%\\old.jpg",
  };
  await h.save({ entries: oldEntries, wallpaper: custom, originalWallpaper }, true);
  const legacy = join(h.data, "wallpaper-policy-backup.json");
  await writeFile(legacy, `\uFEFF${await readFile(legacy, "utf8")}`);
  await writeFile(h.lease, "retired-ps1-owner");
  h.wallpaper = custom;
  for (const entry of oldEntries) h.values.set(key(entry.installed), legacyValue(entry.installed));
  const policy = h.policy();
  await policy.apply();
  assert.equal(h.wallpaper, h.stock);
  await policy.restore();
  assert.equal(h.wallpaper, originalWallpaper);
  assert.deepEqual(
    [...h.values],
    [[key(oldEntries[1].original), stringValue("%USERPROFILE%\\old.jpg", 2)]],
  );
  await absent(legacy);
});

test("crash after any write in a migration retains the original before both versions", async (t) => {
  for (let completed = 0; completed <= 6; completed++) {
    const h = await fixture(t),
      custom = join(h.data, "study-wallpaper.jpg");
    const oldValues = policyValues(custom);
    const saved = {
      format: 2,
      phase: "applying",
      entries: entries(h.stock).map((entry, index) => ({ ...entry, prior: oldValues[index] })),
      originalWallpaper,
      wallpaper: h.stock,
      priorWallpaper: custom,
      wallpaperManaged: true,
    };
    await h.save(saved);
    for (const [index, entry] of saved.entries.entries())
      h.values.set(key(entry), index < completed ? entry.installed : entry.prior);
    h.wallpaper = completed === 6 ? h.stock : custom;
    const next = h.policy();
    await next.apply();
    assert.equal(h.wallpaper, h.stock);
    await next.restore();
    assert.equal(h.values.size, 0);
    assert.equal(h.wallpaper, originalWallpaper);
  }
});

test("external edit between snapshot and write is preserved during rollback", async (t) => {
  const h = await fixture(t);
  let reads = 0;
  const external = stringValue("external");
  h.fault = (operation, input, stage) => {
    if (
      operation === "registry.read" &&
      input.name === "NoChangingWallPaper" &&
      stage === "before" &&
      ++reads === 2
    )
      h.values.set(key(input), external);
  };
  await assert.rejects(h.policy().apply(), /外部修改/);
  assert.deepEqual([...h.values], [[key(entries(h.stock)[0]), external]]);
  await absent(h.backup);
});

test("malformed journals fail before policy mutations and retain original bytes", async (t) => {
  const h = await fixture(t);
  const malformed = {
    entries: [{ path: "Software\\Unrelated", name: "x", original: null, installed: null }],
    wallpaper: h.stock,
    originalWallpaper,
  };
  await h.save(malformed);
  await assert.rejects(h.policy().apply(), /未知策略/);
  assert.deepEqual(JSON.parse(await readFile(h.backup, "utf8")), malformed);
  assert.equal(
    h.calls.some((call) => call.operation.endsWith(".write") || call.operation.endsWith(".set")),
    false,
  );
  assert.throws(() =>
    legacyValue({ present: true, kind: "QWord", value: Number.MAX_SAFE_INTEGER + 1 }),
  );
  assert.deepEqual(legacyValue({ present: true, kind: "QWord", value: "-1" }), {
    type: 11,
    bytes: Array(8).fill(255),
  });
});

test("dead-process and interrupted empty-directory locks recover without deleting journals", async (t) => {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const h = await fixture(t);
  const lock = join(h.data, "wallpaper-policy.lock");
  await mkdir(lock, { recursive: true });
  await writeFile(
    join(lock, "owner.json"),
    JSON.stringify({ pid: Number(child.stdout), token: "dead" }),
  );
  const first = h.policy(),
    replacement = h.policy();
  await Promise.all([first.apply(), replacement.apply()]);
  await first.restore();
  await replacement.restore();
  assert.equal(h.wallpaper, originalWallpaper);
  await mkdir(lock);
  const next = h.policy();
  await next.apply();
  await next.restore();
  assert.equal(h.values.size, 0);
});

test("filesystem lock serializes worker generations", async (t) => {
  const h = await fixture(t);
  const order = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const first = withJournalLock(h.data, async () => {
    order.push("first");
    entered();
    await gate;
    order.push("released");
  });
  await ready;
  const second = withJournalLock(h.data, async () => {
    order.push("second");
  });
  release();
  const handoff = await Promise.allSettled([first, second]);
  for (const result of handoff) if (result.status === "rejected") throw result.reason;
  assert.deepEqual(order, ["first", "released", "second"]);

  // Repeated handoffs also exercise the cleanup/acquisition boundary, not only
  // serialization of operation callbacks. A retired owner must never delete its successor.
  const lock = join(h.data, "wallpaper-policy.lock");
  let active = 0;
  let completed = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, async () => {
      for (let round = 0; round < 12; round++) {
        await withJournalLock(h.data, async () => {
          assert.equal(++active, 1);
          const owner = await readFile(join(lock, "owner.json"), "utf8");
          await writeFile(join(h.data, "value"), String(++completed));
          assert.equal(await readFile(join(lock, "owner.json"), "utf8"), owner);
          active--;
        });
      }
    }),
  );
  for (const result of results) if (result.status === "rejected") throw result.reason;
  assert.equal(completed, 48);
  assert.equal(active, 0);
  await absent(join(lock, "owner.json"));
  assert.deepEqual(await readdir(h.data), ["value"]);
});
