import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { downloadFromSources } from "../../../shared/downloads.ts";
import { githubSources } from "../../../shared/github.ts";
import { compareVersion } from "../../../shared/plugin-format.ts";
import { object } from "../../../shared/validation.ts";
import { verifyUpdaterSignature } from "../../../shared/updater-signature.ts";

export interface Release {
  version: string;
  url: string;
  signature: string;
}
export interface UpdaterConfig {
  endpoints: string[];
  pubkey: string;
}
const minimumTarget = "0.4.2";
export function parseRelease(bytes: Uint8Array, endpoint: string): Release {
  const data: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!object(data) || typeof data.version !== "string" || !object(data.platforms))
    throw new Error("更新信息无效");
  compareVersion(data.version, minimumTarget);
  const platform = data.platforms["windows-x86_64"];
  if (
    !object(platform) ||
    typeof platform.url !== "string" ||
    typeof platform.signature !== "string"
  )
    throw new Error("更新缺少 Windows 安装包或签名");
  const source = new URL(endpoint);
  const expected = `https://github.com/${source.pathname.split("/").slice(1, 3).join("/")}/releases/download/app-v${data.version}/Chord.Control-setup.exe`;
  if (source.hostname !== "github.com" || platform.url !== expected)
    throw new Error("更新地址不属于官方发布");
  return { version: data.version, url: platform.url, signature: platform.signature };
}
export async function latest(config: UpdaterConfig, signal: AbortSignal): Promise<Release> {
  const endpoint = config.endpoints[0];
  if (!endpoint) throw new Error("缺少主程序更新地址");
  return (
    await downloadFromSources(githubSources(endpoint), {
      maxBytes: 256 * 1024,
      probeBytes: 256 * 1024,
      timeoutMs: 30_000,
      signal,
      decode: (bytes) => parseRelease(bytes, endpoint),
    })
  ).value;
}
export function needed(installed: string, release: Release): boolean {
  return (
    compareVersion(release.version, minimumTarget) >= 0 &&
    compareVersion(release.version, installed) > 0
  );
}
export async function prepare(
  release: Release,
  config: UpdaterConfig,
  stagingDir: string,
  signal: AbortSignal,
): Promise<string> {
  const directory = join(stagingDir, "installer");
  await mkdir(directory, { recursive: true });
  const destination = join(directory, `Chord.Control-${release.version}.exe`);
  try {
    const cached = await readFile(destination);
    verifyUpdaterSignature(cached, release.signature, config.pubkey);
    return destination;
  } catch {
    /* An incomplete or previous download is replaced only by verified bytes. */
  }
  const { value: bytes } = await downloadFromSources(githubSources(release.url), {
    maxBytes: 150 * 1024 * 1024,
    probeBytes: 64 * 1024,
    timeoutMs: 180_000,
    signal,
    prefix: (bytes) => {
      if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error("来源未返回 Windows 安装包");
    },
    decode: (bytes) => {
      verifyUpdaterSignature(bytes, release.signature, config.pubkey);
      return bytes;
    },
  });
  signal.throwIfAborted();
  await writeFile(destination, bytes);
  return destination;
}
export async function launch(
  installer: string,
  installation: string,
  signal: AbortSignal,
  failed: (error: Error) => void,
): Promise<void> {
  const runningDirectory = dirname(await realpath(process.execPath));
  if (resolve(installation).toLowerCase() !== runningDirectory.toLowerCase())
    throw new Error("运行中的控制器与安装目录不一致，已取消升级");
  signal.throwIfAborted();
  // NSIS consumes /D as the final unquoted command-line tail, including spaces.
  // Quote argv[0] explicitly because libuv must not quote that /D tail for us.
  const child = spawn(installer, ["/S", "/UPDATE", `/D=${installation}`], {
    argv0: `"${installer}"`,
    windowsVerbatimArguments: true,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise<void>((done, reject) => {
    child.once("spawn", done);
    child.once("error", reject);
  });
  child.once("exit", (code) => {
    if (!signal.aborted) failed(new Error(`安装程序已结束但控制器仍在运行 (${code})`));
  });
  child.unref();
}
