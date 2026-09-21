import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { buildNativePlugin } from "./build-native-plugin.mjs";

// Compare against the exact native asset produced for the signed catalogue.
const directory = resolve("plugins/telemetry");
const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
const declaration = pkg.control.native;
const manifest = join(directory, declaration.manifest);
const targetDir = resolve("build/plugin-native", pkg.name);
const binary = join(targetDir, "x86_64-pc-windows-msvc/release", `${declaration.binary}.exe`);
const previous = await readFile(binary);
const bundleDir = await mkdtemp(join(tmpdir(), "chord-native-rebuild-"));
try {
  await promisify(execFile)(
    "cargo",
    [
      "clean",
      "--manifest-path",
      manifest,
      "--target",
      "x86_64-pc-windows-msvc",
      "--target-dir",
      targetDir,
      "--release",
      "-p",
      declaration.binary,
    ],
    { cwd: directory, windowsHide: true, timeout: 30_000 },
  );
  // Ensure a wall-clock timestamp cannot accidentally match the preceding link.
  await setTimeout(1100);
  await buildNativePlugin({ manifest, bundleDir, declaration, id: pkg.name });
  const rebuilt = await readFile(join(bundleDir, declaration.asset));
  assert(previous.equals(rebuilt), "Unchanged native source produced different EXE bytes");
  console.log("Native plugin rebuild is byte-identical to the signed catalogue asset.");
} finally {
  await rm(bundleDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
