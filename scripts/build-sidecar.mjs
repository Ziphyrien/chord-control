import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { buildController } from "./build-controller.mjs";

if (process.platform !== "win32") throw new Error("Build the Windows controller on Windows");
if (Number(process.versions.node.split(".")[0]) < 26)
  throw new Error("Node 26 or newer is required to build the executable");
const target = process.env.TAURI_TARGET_TRIPLE ?? "x86_64-pc-windows-msvc";
const targets = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" };
if (targets[process.arch] !== target)
  throw new Error("Node architecture must match TAURI_TARGET_TRIPLE");
const exec = promisify(execFile);
const root = process.cwd();
await buildController();
await mkdir("src-tauri/binaries", { recursive: true });
const output = join(root, "src-tauri/binaries", `plugin-controller-${target}.exe`);
const temporary = `${output}.tmp.exe`;
const seaPath = join(root, "build/sea-config.json");
await writeFile(
  seaPath,
  JSON.stringify({
    main: join(root, "build/controller.cjs"),
    output: temporary,
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
    useSnapshot: false,
  }),
);
try {
  await exec(process.execPath, ["--build-sea", seaPath], { cwd: root });
  await rename(temporary, output);
} finally {
  await rm(temporary, { force: true });
}
console.log(`Built ${output}`);
