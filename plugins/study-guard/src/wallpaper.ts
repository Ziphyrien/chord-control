import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { HostService } from "../../../sdk/index.ts";
import type { Json } from "../../../shared/protocol.ts";
type Raw = { type: number; bytes: number[] } | null;
type Entry = { path: string; name: string; original: Raw; installed: Raw };
type Backup = { entries: Entry[]; originalWallpaper: string; wallpaper: string };
const rawString = (text: string): Raw => ({
  type: 1,
  bytes: [...Buffer.from(text + "\0", "utf16le")],
});
const rawDword = (n: number): Raw => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(n >>> 0);
  return { type: 4, bytes: [...bytes] };
};
function sameRaw(left: Raw, right: Raw): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.type === right.type &&
    left.bytes.length === right.bytes.length &&
    left.bytes.every((byte, index) => byte === right.bytes[index])
  );
}
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
async function atomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}
function legacyRaw(value: { present?: boolean; kind?: string; value?: Json }): Raw {
  if (!value.present) return null;
  if (value.kind === "DWord") return rawDword(Number(value.value));
  if (value.kind === "String" || value.kind === "ExpandString")
    return { ...rawString(String(value.value))!, type: value.kind === "String" ? 1 : 2 };
  if (value.kind === "Binary") return { type: 3, bytes: value.value as number[] };
  if (value.kind === "MultiString")
    return {
      type: 7,
      bytes: [...Buffer.from((value.value as string[]).join("\0") + "\0\0", "utf16le")],
    };
  if (value.kind === "QWord") {
    const bytes = Buffer.alloc(8);
    bytes.writeBigInt64LE(BigInt(String(value.value)));
    return { type: 11, bytes: [...bytes] };
  }
  throw new Error("旧版壁纸备份包含不支持的注册表类型");
}
export class WallpaperPolicy {
  private readonly owner = randomUUID();
  private readonly backup: string;
  private readonly lease: string;
  constructor(
    private readonly host: HostService,
    private readonly dataDir: string,
    private readonly bundleDir: string,
  ) {
    this.backup = join(dataDir, "wallpaper-native-backup.json");
    this.lease = join(dataDir, "wallpaper-policy-owner.txt");
  }
  private call(operation: string, input: Json = null) {
    return this.host.native(operation, input, BACKGROUND_CONTEXT);
  }
  async owns(): Promise<boolean> {
    return (await readOptional(this.lease)) === this.owner;
  }
  async apply(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const wallpaper = join(this.dataDir, "study-wallpaper.jpg");
    await copyFile(join(this.bundleDir, "assets/study-wallpaper.jpg"), wallpaper);
    const definitions: [string, string, Raw][] = [
      [
        "Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\ActiveDesktop",
        "NoChangingWallPaper",
        rawDword(1),
      ],
      [
        "Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System",
        "Wallpaper",
        rawString(wallpaper),
      ],
      [
        "Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System",
        "WallpaperStyle",
        rawString("4"),
      ],
      ["Control Panel\\Desktop", "WallpaperStyle", rawString("10")],
      ["Control Panel\\Desktop", "TileWallpaper", rawString("0")],
    ];
    const entries: Entry[] = [];
    for (const [path, name, installed] of definitions)
      entries.push({
        path,
        name,
        installed,
        original: (await this.call("registry.read", { path, name })) as Raw,
      });
    const originalWallpaper = String(await this.call("wallpaper.get"));
    const existing = await readOptional(this.backup);
    let saved: Backup = { entries, originalWallpaper, wallpaper };
    if (existing) saved = JSON.parse(existing) as Backup;
    else {
      const legacy = await readOptional(join(this.dataDir, "wallpaper-policy-backup.json"));
      if (legacy) {
        const old = JSON.parse(legacy);
        saved = {
          originalWallpaper: old.originalWallpaper,
          wallpaper,
          entries: old.entries.map(
            (item: {
              original: {
                path: string;
                name: string;
                present?: boolean;
                kind?: string;
                value?: Json;
              };
              installed: { present?: boolean; kind?: string; value?: Json };
            }) => ({
              path: item.original.path,
              name: item.original.name,
              original: legacyRaw(item.original),
              installed: legacyRaw(item.installed),
            }),
          ),
        };
      }
    }
    // Keep the first original value, but track what this generation actually installs.
    saved = {
      originalWallpaper: saved.originalWallpaper,
      wallpaper,
      entries: entries.map((entry) => {
        const previous = saved.entries.find(
          (item) => item.path === entry.path && item.name === entry.name,
        );
        return { ...entry, original: previous ? previous.original : entry.original };
      }),
    };
    // Persist original values before the first mutation; retain them across hot replacement.
    await atomic(this.backup, JSON.stringify(saved));
    try {
      for (const entry of entries)
        await this.call("registry.write", {
          path: entry.path,
          name: entry.name,
          value: entry.installed,
        });
      await this.call("wallpaper.set", { path: wallpaper });
      await atomic(this.lease, this.owner);
    } catch (error) {
      for (const entry of entries)
        await this.call("registry.write", {
          path: entry.path,
          name: entry.name,
          value: entry.original,
        });
      await this.call("wallpaper.set", { path: originalWallpaper });
      if (existing) await atomic(this.backup, existing);
      else await rm(this.backup, { force: true });
      throw error;
    }
  }
  async restore(): Promise<void> {
    if (!(await this.owns())) return;
    const text = await readOptional(this.backup);
    if (!text) return;
    const saved = JSON.parse(text) as Backup;
    for (const entry of saved.entries) {
      const current = (await this.call("registry.read", {
        path: entry.path,
        name: entry.name,
      })) as Raw;
      if (sameRaw(current, entry.installed))
        await this.call("registry.write", {
          path: entry.path,
          name: entry.name,
          value: entry.original,
        });
    }
    if ((await this.call("wallpaper.get")) === saved.wallpaper)
      await this.call("wallpaper.set", { path: saved.originalWallpaper });
    await rm(this.backup, { force: true });
    await rm(this.lease, { force: true });
    await rm(join(this.dataDir, "wallpaper-policy-backup.json"), { force: true });
  }
}
