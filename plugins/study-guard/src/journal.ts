import { mkdir, readFile, rename, rm, rmdir, lstat, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { legacyValue, parseRaw, POLICY_KEYS, type PolicyEntry } from "./registry.ts";

export interface Backup {
  format: 2;
  phase: "applying" | "active" | "restoring";
  entries: PolicyEntry[];
  originalWallpaper: string;
  wallpaper: string;
  priorWallpaper?: string;
  wallpaperManaged: boolean;
  retiredWallpaper?: string;
}
export async function optionalText(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
export async function atomicText(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
function pathText(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32768 && !value.includes("\0");
}
/** Old journals are decoded into the same recovery model; unknown paths never reach the host. */
export function parseBackup(text: string, legacy = false): Backup {
  const value = JSON.parse(text);
  if (
    !value ||
    !Array.isArray(value.entries) ||
    value.entries.length > POLICY_KEYS.length ||
    !pathText(value.originalWallpaper) ||
    !pathText(value.wallpaper)
  )
    throw new Error("壁纸备份格式无效");
  if (value.format !== undefined && value.format !== 1 && value.format !== 2)
    throw new Error("不支持的壁纸备份版本");
  if (value.format === 2 && !["applying", "active", "restoring"].includes(value.phase))
    throw new Error("壁纸备份阶段无效");
  for (const key of ["priorWallpaper", "retiredWallpaper"])
    if (value[key] !== undefined && !pathText(value[key])) throw new Error("壁纸备份路径无效");
  if (value.wallpaperManaged !== undefined && typeof value.wallpaperManaged !== "boolean")
    throw new Error("壁纸备份状态无效");
  const seen = new Set<string>();
  const entries = value.entries.map((item: Record<string, unknown>): PolicyEntry => {
    if (!item || typeof item !== "object") throw new Error("壁纸备份条目无效");
    const source = legacy ? (item.original as Record<string, unknown>) : item;
    if (
      !source ||
      !POLICY_KEYS.some(([path, name]) => path === source.path && name === source.name)
    )
      throw new Error("壁纸备份包含未知策略");
    const key = `${source.path}|${source.name}`;
    if (seen.has(key)) throw new Error("壁纸备份包含重复策略");
    seen.add(key);
    if (item.managed !== undefined && typeof item.managed !== "boolean")
      throw new Error("壁纸备份状态无效");
    if (legacy) {
      const installed = item.installed as Record<string, unknown>;
      if (!installed || installed.path !== source.path || installed.name !== source.name)
        throw new Error("旧版策略路径不匹配");
    }
    return {
      path: String(source.path),
      name: String(source.name),
      original: legacy ? legacyValue(item.original) : parseRaw(item.original),
      installed: legacy ? legacyValue(item.installed) : parseRaw(item.installed),
      managed: item.managed !== false,
      ...(item.prior !== undefined ? { prior: parseRaw(item.prior) } : {}),
    };
  });
  return {
    format: 2,
    phase: value.format === 2 ? value.phase : "active",
    entries,
    originalWallpaper: value.originalWallpaper,
    wallpaper: value.wallpaper,
    wallpaperManaged: value.wallpaperManaged !== false,
    priorWallpaper: value.priorWallpaper,
    retiredWallpaper: value.retiredWallpaper,
  };
}

/** Lock publication includes its owner; reapers serialize on the abandoned owner's token. */
async function directoryLock<T>(
  directory: string,
  lock: string,
  deadline: number,
  depth: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (depth > 8) throw new Error("壁纸锁恢复链过长；已保留恢复数据");
  const candidate = `${lock}.${randomUUID()}`;
  const identity = JSON.stringify({ pid: process.pid, token: randomUUID() });
  await mkdir(candidate);
  try {
    await atomicText(join(candidate, "owner.json"), identity);
    while (true) {
      try {
        await rename(candidate, lock);
        break;
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
        if (Date.now() >= deadline) throw new Error("壁纸策略正在使用中；已保留恢复数据");
        const text = await optionalText(join(lock, "owner.json"));
        if (text) {
          const owner = JSON.parse(text);
          if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
            throw new Error("壁纸锁所有者无效；已保留恢复数据");
          let dead = false;
          try {
            process.kill(owner.pid, 0);
          } catch (failure) {
            dead = (failure as NodeJS.ErrnoException).code === "ESRCH";
          }
          if (dead) {
            // Without a separate reaper lock, two recoveries could delete a newly acquired live lock.
            const digest = createHash("sha256")
              .update(`${lock}\0${text}`)
              .digest("hex")
              .slice(0, 24);
            const recovery = join(directory, `.wallpaper-recovery-${digest}`);
            await directoryLock(directory, recovery, deadline, depth + 1, async () => {
              if ((await optionalText(join(lock, "owner.json"))) === text)
                await rm(lock, { recursive: true, force: true });
            });
            continue;
          }
        } else {
          // Recover the empty directory left by the interrupted implementation. Never remove its contents.
          try {
            await rmdir(lock);
          } catch {
            /* A populated or live lock is never removed here. */
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      if ((await optionalText(join(lock, "owner.json"))) === identity)
        await rm(lock, { recursive: true, force: true });
    }
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
}
export async function withJournalLock<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true });
  return directoryLock(
    directory,
    join(directory, "wallpaper-policy.lock"),
    Date.now() + 5000,
    0,
    operation,
  );
}

export async function removeRetiredImage(
  directory: string,
  candidate: string | undefined,
  references: string[],
): Promise<void> {
  if (
    !candidate ||
    references.some((path) => resolve(path).toLowerCase() === resolve(candidate).toLowerCase())
  )
    return;
  if (
    !["study-wallpaper.png", "study-wallpaper.jpg"].some(
      (name) => resolve(directory, name).toLowerCase() === resolve(candidate).toLowerCase(),
    )
  )
    return;
  const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 20_000_000) return;
  const digest = createHash("sha256")
    .update(await readFile(candidate))
    .digest("hex");
  if (digest === "0a61944936dcd69194549880e02999524c7230b1a7d59f5f6f7e328266330998")
    await rm(candidate);
}
