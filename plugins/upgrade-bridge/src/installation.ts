import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Read the PE version resource, never the Node SEA version or registry cache. */
export function executableVersion(file: Buffer): string {
  try {
    if (file.readUInt16LE(0) !== 0x5a4d) throw new Error("MZ");
    const pe = file.readUInt32LE(0x3c);
    if (file.readUInt32LE(pe) !== 0x4550 || file.readUInt16LE(pe + 4) !== 0x8664)
      throw new Error("PE x64");
    const optional = pe + 24;
    if (file.readUInt16LE(optional) !== 0x20b) throw new Error("PE32+");
    const sections = optional + file.readUInt16LE(pe + 20);
    const count = file.readUInt16LE(pe + 6);
    if (!count || count > 96) throw new Error("sections");
    function offset(rva: number, length: number): number {
      for (let index = 0; index < count; index++) {
        const section = sections + index * 40;
        const start = file.readUInt32LE(section + 12);
        const size = file.readUInt32LE(section + 16);
        const raw = file.readUInt32LE(section + 20);
        if (
          rva >= start &&
          rva - start + length <= size &&
          raw + rva - start + length <= file.length
        )
          return raw + rva - start;
      }
      throw new Error("resource outside sections");
    }
    const rva = file.readUInt32LE(optional + 128);
    const size = file.readUInt32LE(optional + 132);
    if (!rva || size < 16 || size > 4 * 1024 * 1024) throw new Error("resources");
    const root = offset(rva, size);
    const resources = file.subarray(root, root + size);
    function entry(directory: number, id?: number): number {
      const count = resources.readUInt16LE(directory + 12) + resources.readUInt16LE(directory + 14);
      for (let index = 0; index < count; index++) {
        const item = directory + 16 + index * 8;
        if (id === undefined || resources.readUInt32LE(item) === id)
          return resources.readUInt32LE(item + 4);
      }
      throw new Error("version resource missing");
    }
    function directory(value: number): number {
      if (!(value & 0x80000000)) throw new Error("resource directory");
      return value & 0x7fffffff;
    }
    const data = entry(directory(entry(directory(entry(0, 16)))));
    if (data & 0x80000000) throw new Error("resource data");
    const length = resources.readUInt32LE(data + 4);
    if (length < 92 || length > 1024 * 1024) throw new Error("version length");
    const block = offset(resources.readUInt32LE(data), length);
    const info = file.subarray(block, block + length);
    if (
      info.readUInt16LE(0) < 92 ||
      info.readUInt16LE(0) > length ||
      info.readUInt16LE(2) !== 52 ||
      info.readUInt16LE(4) !== 0 ||
      info.subarray(6, 38).toString("utf16le") !== "VS_VERSION_INFO\0" ||
      info.readUInt32LE(40) !== 0xfeef04bd ||
      info.readUInt32LE(44) !== 0x10000 ||
      info.readUInt32LE(76) !== 1
    )
      throw new Error("fixed version info");
    const major = info.readUInt32LE(48),
      minor = info.readUInt32LE(52);
    if ((minor & 0xffff) !== 0) throw new Error("unsupported revision");
    return `${major >>> 16}.${major & 0xffff}.${minor >>> 16}`;
  } catch {
    throw new Error("无法读取 chord-control.exe 的 Windows 版本信息");
  }
}
export async function installedApplication(
  executable: string,
  signal: AbortSignal,
): Promise<{ directory: string; version: string }> {
  signal.throwIfAborted();
  if (basename(executable).toLowerCase() !== "plugin-controller.exe")
    throw new Error("升级助手需要在已安装的主程序中运行");
  const directory = dirname(await realpath(executable));
  const host = join(directory, "chord-control.exe");
  let bytes: Buffer;
  try {
    bytes = await readFile(host, { signal });
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(`无法读取主程序文件: ${host}`, { cause: error });
  }
  return { directory, version: executableVersion(bytes) };
}
