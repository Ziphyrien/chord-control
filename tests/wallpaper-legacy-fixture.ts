// Frozen pre-split policy algorithm (study-guard 1.2.3). Kept only to exercise
// cross-version leases, rollback and dispose against the migrated plugin.
import { stat, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { HostService } from "../sdk/index.ts";
import type { Json } from "../shared/protocol.ts";
import {
  POLICY_KEYS,
  parseRaw,
  policyValues,
  sameValue,
  type PolicyEntry,
  type RawValue,
} from "../plugins/wallpaper-policy/src/registry.ts";
import {
  atomicText,
  optionalText,
  parseBackup,
  removeRetiredImage,
  withJournalLock,
  type Backup,
} from "../plugins/wallpaper-policy/src/journal.ts";

async function stockWallpaper(root: string | undefined): Promise<string> {
  if (!root || !isAbsolute(root)) throw new Error("无法定位 Windows 系统目录");
  const path = join(root, "Web", "Wallpaper", "Windows", "img0.jpg");
  if (!(await stat(path).catch(() => undefined))?.isFile())
    throw new Error(`未找到 Windows 默认壁纸: ${path}`);
  return path;
}
function controlled(entry: PolicyEntry, current: RawValue, phase: Backup["phase"]): boolean {
  return (
    entry.managed &&
    (sameValue(current, entry.installed) ||
      (phase !== "active" &&
        (sameValue(current, entry.original) ||
          (entry.prior !== undefined && sameValue(current, entry.prior)))))
  );
}
function controlledWallpaper(saved: Backup, current: string): boolean {
  return (
    saved.wallpaperManaged &&
    (current === saved.wallpaper ||
      (saved.phase !== "active" &&
        (current === saved.originalWallpaper || current === saved.priorWallpaper)))
  );
}

/** Write-ahead transactions retain the first original through migration, crash and retry. */
export class WallpaperPolicy {
  private readonly owner = randomUUID();
  private readonly host: HostService;
  private readonly directory: string;
  private readonly backupPath: string;
  private readonly leasePath: string;
  private readonly legacyPath: string;
  private readonly systemRoot: () => string | undefined;
  constructor(
    host: HostService,
    directory: string,
    systemRoot = () => process.env.SystemRoot ?? process.env.WINDIR,
  ) {
    this.systemRoot = systemRoot;
    this.host = host;
    this.directory = directory;
    this.backupPath = join(directory, "wallpaper-native-backup.json");
    this.leasePath = join(directory, "wallpaper-policy-owner.txt");
    this.legacyPath = join(directory, "wallpaper-policy-backup.json");
  }
  private call(operation: string, input: Json = null) {
    return this.host.native(operation, input, BACKGROUND_CONTEXT);
  }
  async owns(): Promise<boolean> {
    return (await optionalText(this.leasePath)) === this.owner;
  }
  private async readEntry(entry: Pick<PolicyEntry, "path" | "name">): Promise<RawValue> {
    return parseRaw(await this.call("registry.read", { path: entry.path, name: entry.name }));
  }
  private async writeEntry(entry: PolicyEntry, value: RawValue): Promise<void> {
    await this.call("registry.write", { path: entry.path, name: entry.name, value });
  }
  private async wallpaper(): Promise<string> {
    const value = await this.call("wallpaper.get");
    if (typeof value !== "string") throw new Error("无法读取当前壁纸");
    return value;
  }
  private save(saved: Backup): Promise<void> {
    return atomicText(this.backupPath, JSON.stringify(saved));
  }
  async apply(): Promise<void> {
    const target = await stockWallpaper(this.systemRoot());
    await withJournalLock(this.directory, async () => {
      if (await this.owns()) return;
      const previousText = await optionalText(this.backupPath);
      const legacyText =
        previousText === undefined ? await optionalText(this.legacyPath) : undefined;
      const previous =
        previousText !== undefined
          ? parseBackup(previousText)
          : legacyText !== undefined
            ? parseBackup(legacyText, true)
            : undefined;
      const previousLease = await optionalText(this.leasePath);
      const beforeWallpaper = await this.wallpaper();
      const values = policyValues(target);
      const entries: PolicyEntry[] = [];
      for (const [index, [path, name]] of POLICY_KEYS.entries()) {
        const current = await this.readEntry({ path, name });
        const old = previous?.entries.find((entry) => entry.path === path && entry.name === name);
        const managed = !old || controlled(old, current, previous!.phase);
        entries.push({
          path,
          name,
          original: managed && old ? old.original : current,
          installed: managed ? values[index] : current,
          prior: current,
          managed,
        });
      }
      const wallpaperManaged = !previous || controlledWallpaper(previous, beforeWallpaper);
      const saved: Backup = {
        format: 2,
        phase: "applying",
        entries,
        wallpaperManaged,
        priorWallpaper: beforeWallpaper,
        originalWallpaper:
          wallpaperManaged && previous ? previous.originalWallpaper : beforeWallpaper,
        wallpaper: wallpaperManaged ? target : beforeWallpaper,
        retiredWallpaper:
          previous?.retiredWallpaper ??
          (previous?.wallpaper !== target ? previous?.wallpaper : undefined),
      };
      await this.save(saved);
      const attempted: PolicyEntry[] = [];
      let wallpaperAttempted = false;
      try {
        // Ownership is published before mutations so failed rollback can be retried by dispose.
        await atomicText(this.leasePath, this.owner);
        for (const entry of entries) {
          if (!entry.managed || sameValue(entry.prior!, entry.installed)) continue;
          if (!sameValue(await this.readEntry(entry), entry.prior!))
            throw new Error("壁纸策略已被外部修改");
          attempted.push(entry);
          await this.writeEntry(entry, entry.installed);
        }
        if (wallpaperManaged && beforeWallpaper !== target) {
          if ((await this.wallpaper()) !== beforeWallpaper) throw new Error("壁纸已被外部修改");
          wallpaperAttempted = true;
          await this.call("wallpaper.set", { path: target });
        }
        saved.phase = "active";
        await this.save(saved);
      } catch (error) {
        const failures: unknown[] = [];
        for (const entry of attempted.reverse()) {
          try {
            if (sameValue(await this.readEntry(entry), entry.installed))
              await this.writeEntry(entry, entry.prior!);
          } catch (failure) {
            failures.push(failure);
          }
        }
        try {
          if (wallpaperAttempted && (await this.wallpaper()) === target)
            await this.call("wallpaper.set", { path: beforeWallpaper });
        } catch (failure) {
          failures.push(failure);
        }
        if (failures.length)
          throw new AggregateError([error, ...failures], "壁纸应用与恢复失败；保留恢复备份");
        if (previousText !== undefined) await atomicText(this.backupPath, previousText);
        else await rm(this.backupPath, { force: true });
        if (previousLease !== undefined) await atomicText(this.leasePath, previousLease);
        else await rm(this.leasePath, { force: true });
        throw error;
      }
    });
  }
  async measure(): Promise<{ checks: number; passed: number; owned: boolean; errors: string[] }> {
    const target = await stockWallpaper(this.systemRoot());
    const values = policyValues(target),
      errors: string[] = [];
    let passed = 0;
    if (
      (await this.wallpaper()).replaceAll("/", "\\").toLowerCase() ===
      target.replaceAll("/", "\\").toLowerCase()
    )
      passed++;
    else errors.push("wallpaper.current_mismatch");
    for (const [index, [path, name]] of POLICY_KEYS.entries()) {
      if (sameValue(await this.readEntry({ path, name }), values[index])) passed++;
      else errors.push(`policy.${name}.mismatch`);
    }
    return { checks: 1 + POLICY_KEYS.length, passed, owned: await this.owns(), errors };
  }
  async restore(): Promise<void> {
    await withJournalLock(this.directory, async () => {
      if (!(await this.owns())) return;
      const text = await optionalText(this.backupPath);
      if (text === undefined) throw new Error("壁纸恢复备份缺失");
      const saved = parseBackup(text);
      const phase = saved.phase;
      saved.phase = "restoring";
      await this.save(saved);
      const failures: unknown[] = [];
      for (const entry of saved.entries) {
        try {
          const current = await this.readEntry(entry);
          if (controlled(entry, current, phase) && !sameValue(current, entry.original))
            await this.writeEntry(entry, entry.original);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        const current = await this.wallpaper();
        if (
          controlledWallpaper({ ...saved, phase }, current) &&
          current !== saved.originalWallpaper
        )
          await this.call("wallpaper.set", { path: saved.originalWallpaper });
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) throw new AggregateError(failures, "壁纸恢复未完成；保留备份以便重试");
      const references = [await this.wallpaper(), saved.originalWallpaper];
      for (const entry of saved.entries) {
        const raw = await this.readEntry(entry);
        if (raw?.type === 1 || raw?.type === 2)
          references.push(Buffer.from(raw.bytes).toString("utf16le").replace(/\0+$/, ""));
      }
      await removeRetiredImage(this.directory, saved.retiredWallpaper, references);
      await rm(this.legacyPath, { force: true });
      await rm(this.backupPath, { force: true });
      await rm(this.leasePath, { force: true });
    });
  }
}
