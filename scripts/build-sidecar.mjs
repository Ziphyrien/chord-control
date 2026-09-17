import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildController } from "./build-controller.mjs";
import { isMain, repositoryRoot, withDirectoryLock } from "./release-files.mjs";

export async function buildSidecar({
  root = repositoryRoot,
  target = process.env.TAURI_TARGET_TRIPLE ?? "x86_64-pc-windows-msvc",
} = {}) {
  if (process.platform !== "win32") throw new Error("Build the Windows controller on Windows");
  if (Number(process.versions.node.split(".")[0]) < 26)
    throw new Error("Node 26 or newer is required for --build-sea");
  const targets = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" };
  if (targets[process.arch] !== target)
    throw new Error("Node architecture must match TAURI_TARGET_TRIPLE");
  const output = join(root, "src-tauri/binaries", `plugin-controller-${target}.exe`);
  return withDirectoryLock(output, async () => {
    const main = await buildController({ root });
    await mkdir(join(root, "src-tauri/binaries"), { recursive: true });
    const nonce = randomUUID();
    const temporary = `${output}.${nonce}.tmp.exe`;
    const config = join(root, "build", `sea-${nonce}.json`);
    try {
      await writeFile(
        config,
        JSON.stringify({
          main,
          output: temporary,
          disableExperimentalSEAWarning: true,
          useCodeCache: true,
          useSnapshot: false,
        }),
      );
      await promisify(execFile)(process.execPath, ["--build-sea", config], {
        cwd: root,
        timeout: 120000,
      });
      if ((await stat(temporary)).size === 0) throw new Error("SEA output is empty");
      await rename(temporary, output);
      return output;
    } finally {
      await rm(temporary, { force: true });
      await rm(config, { force: true });
    }
  });
}

if (isMain(import.meta.url)) console.log(`Built ${await buildSidecar()}`);
