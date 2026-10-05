import { execFile } from "node:child_process";
import { safePath } from "../../../shared/plugin-format.ts";
import type { Json } from "../../../shared/protocol.ts";
import { jsonValue, message } from "../../../shared/validation.ts";

const INPUT_LIMIT = 32 * 1024;
const OUTPUT_LIMIT = 64 * 1024;
const TIMEOUT = 10_000;

/** Run one signed plugin-owned native asset without exposing a shell or host-domain operation. */
export async function runNativeAsset(
  bundleDir: string,
  asset: string,
  input: Json,
  signal?: AbortSignal,
): Promise<Json> {
  if (process.platform !== "win32") throw new Error("原生插件资产仅支持 Windows");
  if (asset.length > 256 || !asset.startsWith("native/") || !asset.toLowerCase().endsWith(".exe"))
    throw new Error("原生插件资产路径无效");
  const executable = safePath(bundleDir, asset);
  if (!jsonValue(input)) throw new Error("原生插件输入不是有效 JSON");
  const encoded = JSON.stringify(input);
  if (encoded === undefined || Buffer.byteLength(encoded) > INPUT_LIMIT)
    throw new Error("原生插件输入过大");
  signal?.throwIfAborted();
  let closed: Promise<void> | undefined;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      let child;
      try {
        child = execFile(
          executable,
          [],
          {
            windowsHide: true,
            timeout: TIMEOUT,
            maxBuffer: OUTPUT_LIMIT,
            encoding: "utf8",
            signal,
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      } catch (error) {
        reject(error);
        return;
      }
      closed = new Promise<void>((done) => child.once("close", () => done()));
      child.stdin?.on("error", reject);
      child.stdin?.end(encoded);
    });
    await closed;
    const value: unknown = JSON.parse(output);
    if (!jsonValue(value)) throw new Error("原生插件输出不是有效 JSON");
    return value;
  } catch (error) {
    const wrapped = new Error(`原生插件资产 ${asset} 执行失败: ${message(error)}`);
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (typeof error.code === "string" || typeof error.code === "number")
    )
      Object.assign(wrapped, { code: error.code });
    throw wrapped;
  } finally {
    await closed;
  }
}
