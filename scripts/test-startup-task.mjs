import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "win32", "This probe requires Windows Task Scheduler.");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Run only on the isolated Windows CI runner.");
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), "Chord highest 空格 &-"));
const executable = path.join(temporary, "chord-control.exe");
const profile = path.join(temporary, "profile");
const system32 = path.join(process.env.SystemRoot ?? "C:/Windows", "System32");
const settings = { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 32_768 };
const identity = spawnSync(
  path.join(system32, "whoami.exe"),
  ["/user", "/fo", "csv", "/nh"],
  settings,
);
assert.ifError(identity.error);
assert.equal(identity.status, 0, identity.stderr);
const sid = identity.stdout.match(/S-1-5-[0-9-]+/)?.[0];
assert.ok(sid, "Cannot identify the interactive CI account.");
// The production helper also migrates this per-user entry. The disposable runner must be clean.
const legacy = spawnSync(
  path.join(system32, "reg.exe"),
  ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "Chord Control"],
  settings,
);
assert.ifError(legacy.error);
assert.equal(
  legacy.status,
  1,
  "CI already has a Chord Control login entry; refusing to replace it.",
);

function legacyEntry(enabled) {
  for (const [key, type, data] of [
    [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "REG_SZ",
      `"${executable}" --background`,
    ],
    [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run",
      "REG_BINARY",
      enabled ? "020000000000000000000000" : "030000000000000000000000",
    ],
  ]) {
    const result = spawnSync(
      path.join(system32, "reg.exe"),
      ["add", key, "/v", "Chord Control", "/t", type, "/d", data, "/f"],
      settings,
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
}

function invoke(operation, owner = sid) {
  return spawnSync(executable, ["--startup-task", operation, "--startup-owner", owner], {
    ...settings,
    env: { ...process.env, LOCALAPPDATA: profile },
  });
}
function task(operation, expected) {
  const result = invoke(operation);
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${operation}: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), { Ok: expected }, `${operation}: ${result.stdout}`);
}
try {
  mkdirSync(profile);
  copyFileSync(path.join(root, "src-tauri/target/release/chord-control.exe"), executable);
  task("query", false);
  const alternate = invoke("enable", "S-1-5-21-1-2-3-1001");
  assert.ifError(alternate.error);
  assert.equal(alternate.status, 1, "Alternate account must be rejected before registration.");
  task("query", false);
  task("ensure", true);
  task("query", true); // Production inspection verifies SID, HighestAvailable, action and trigger.
  task("disable", false);
  task("ensure", false); // A disabled preference must survive the next startup.
  legacyEntry(true);
  task("ensure", true); // Migrate the old enabled Run entry to a highest task.
  task("disable", false);
  legacyEntry(false);
  task("ensure", false); // Respect Task Manager's disabled StartupApproved state.
  task("enable", true);
  task("enable", true); // No duplicate task or login trigger.
  task("query", true);
  const maintenance = spawnSync(executable, ["--maintenance-stop", "--startup-owner", sid], {
    ...settings,
    env: { ...process.env, LOCALAPPDATA: profile },
  });
  assert.ifError(maintenance.error);
  assert.equal(maintenance.status, 0, maintenance.stderr);
  task("query", true); // Updates stop the session while retaining login settings.
  const cleanup = spawnSync(executable, ["--uninstall-cleanup", "--startup-owner", sid], {
    ...settings,
    env: { ...process.env, LOCALAPPDATA: profile },
  });
  assert.ifError(cleanup.error);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  task("query", false);
  console.log(
    "Highest startup task: real COM registration, owner, Unicode path, migration and toggle passed.",
  );
} catch (error) {
  console.error("Startup task probe failed:", error);
  throw error;
} finally {
  // Retain the executable if cleanup fails so a remaining task never points at a deleted file.
  if (existsSync(executable)) task("disable", false);
  rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
}
