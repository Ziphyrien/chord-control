import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { safePath } from "../shared/plugin-format.ts";
import { repositoryRoot, withDirectoryLock } from "./release-files.mjs";

/** Repository build capability; native sources and runtime policy belong to each plugin. */
export async function buildNativePlugin({ manifest, bundleDir, declaration, id }) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("Native plugin assets must be built on Windows x64");
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(declaration.binary ?? "") ||
    typeof declaration.asset !== "string" ||
    !declaration.asset.endsWith(".exe")
  )
    throw new Error("Invalid native plugin declaration");
  const destination = safePath(bundleDir, declaration.asset);
  const targetDir = join(repositoryRoot, "build/plugin-native", id);
  const target = "x86_64-pc-windows-msvc";
  await withDirectoryLock(targetDir, async () => {
    await promisify(execFile)(
      "cargo",
      [
        "build",
        "--release",
        "--locked",
        "--manifest-path",
        manifest,
        "--target",
        target,
        "--target-dir",
        targetDir,
        "--bin",
        declaration.binary,
      ],
      {
        cwd: dirname(manifest),
        windowsHide: true,
        timeout: 300_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          CARGO_ENCODED_RUSTFLAGS: [
            "-C",
            "target-feature=+crt-static",
            "--remap-path-prefix",
            `${repositoryRoot}=source`,
          ].join("\x1f"),
        },
      },
    );
    const binary = join(targetDir, target, "release", `${declaration.binary}.exe`);
    const bytes = await readFile(binary);
    const pe = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : 0;
    if (
      bytes.length < 64 ||
      bytes.subarray(0, 2).toString() !== "MZ" ||
      pe < 64 ||
      pe + 12 > bytes.length ||
      bytes.readUInt32LE(pe) !== 0x4550 ||
      bytes.readUInt16LE(pe + 4) !== 0x8664
    )
      throw new Error("Native plugin asset is not a Windows x64 executable");
    if (bytes.readUInt32LE(pe + 8) !== 0)
      throw new Error("Native plugin asset must have a fixed zero PE timestamp");
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(binary, destination, 1);
  });
}
