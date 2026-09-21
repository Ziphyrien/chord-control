import { open, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { atomicText, optionalText, parseBackup, withJournalLock } from "./journal.ts";

interface Receipt {
  format: 1;
  phase: "publishing" | "active" | "releasing";
  token: string;
  owner: string;
  backup: string;
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Only installations with legacy state coordinate with the retired study plugin. */
export class LegacyMigration {
  private readonly directory: string;
  private readonly legacy: string;
  private readonly receiptPath: string;
  private receipt: Receipt | undefined;
  constructor(directory: string) {
    this.directory = directory;
    this.legacy = join(dirname(directory), "com.chord.study-guard");
    this.receiptPath = join(directory, "wallpaper-migration-receipt.json");
  }
  private path(directory: string, name: "backup" | "lease" | "powershell") {
    return join(
      directory,
      name === "backup"
        ? "wallpaper-native-backup.json"
        : name === "lease"
          ? "wallpaper-policy-owner.txt"
          : "wallpaper-policy-backup.json",
    );
  }
  private async readReceipt(): Promise<Receipt | undefined> {
    const text = await optionalText(this.receiptPath);
    if (text === undefined) return undefined;
    const value: unknown = JSON.parse(text);
    if (
      !record(value) ||
      value.format !== 1 ||
      !["publishing", "active", "releasing"].includes(String(value.phase)) ||
      typeof value.token !== "string" ||
      !uuid.test(value.token) ||
      typeof value.owner !== "string" ||
      !uuid.test(value.owner) ||
      typeof value.backup !== "string"
    )
      throw new Error("壁纸迁移收据格式无效；已保留恢复数据");
    parseBackup(value.backup);
    return value as unknown as Receipt;
  }
  private async source(): Promise<string | undefined> {
    const native = await optionalText(this.path(this.legacy, "backup"));
    if (native !== undefined) return JSON.stringify(parseBackup(native));
    const legacy = await optionalText(this.path(this.legacy, "powershell"));
    return legacy === undefined ? undefined : JSON.stringify(parseBackup(legacy, true));
  }
  private async assertSafeTakeover(lease: string | undefined): Promise<void> {
    // Host data layout in 0.4.6+: <root>/data/<plugin id>, <root>/config.json.
    // Read only the persisted identity/version/enabled fields. Never write host configuration.
    const path = join(dirname(dirname(this.directory)), "config.json");
    let value: unknown;
    try {
      const file = await open(path, "r");
      try {
        if ((await file.stat()).size > 1_048_576) throw new Error("配置过大");
        value = JSON.parse((await file.readFile("utf8")).replace(/^\uFEFF/, ""));
      } finally {
        await file.close();
      }
    } catch {
      throw new Error("无法确认旧版浏览器保护状态；请先完成浏览器保护升级，再启用壁纸策略");
    }
    if (
      !record(value) ||
      (value.format !== 2 && value.format !== 3) ||
      !Array.isArray(value.plugins) ||
      value.plugins.length > 100 ||
      !value.plugins.every(record)
    )
      throw new Error("无法确认旧版浏览器保护配置；已延迟壁纸迁移");
    const matches = value.plugins.filter(
      (item) => typeof item.id === "string" && item.id.toLowerCase() === "com.chord.study-guard",
    );
    if (matches.length === 0 && lease === undefined) return;
    if (matches.length !== 1) throw new Error("无法确认旧版浏览器保护身份；已延迟壁纸迁移");
    const plugin = matches[0];
    if (plugin.enabled === false && lease === undefined) return;
    if (plugin.enabled !== undefined && typeof plugin.enabled !== "boolean")
      throw new Error("无法确认旧版浏览器保护状态；已延迟壁纸迁移");
    const installed = plugin.installed;
    const version =
      record(installed) &&
      installed.id === "com.chord.study-guard" &&
      typeof installed.version === "string"
        ? installed.version
        : "";
    const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
    if (
      !parts ||
      !parts.slice(1).every((part) => Number.isSafeInteger(Number(part))) ||
      !(Number(parts[1]) > 1 || (Number(parts[1]) === 1 && Number(parts[2]) >= 3))
    )
      throw new Error("请先将浏览器保护更新到 1.3.0 或更高版本；已延迟壁纸迁移，保留旧版保护");
  }
  private async writeReceipt(receipt: Receipt) {
    await atomicText(this.receiptPath, JSON.stringify(receipt));
    this.receipt = receipt;
  }
  private async replay(receipt: Receipt) {
    await atomicText(this.path(this.directory, "backup"), receipt.backup);
    // Keep an old-format-compatible journal so an explicit old-version rollback
    // can still restore the first originals. Its fresh UUID lease supersedes us.
    await atomicText(this.path(this.legacy, "backup"), receipt.backup);
    await atomicText(this.path(this.directory, "lease"), receipt.owner);
    await this.writeReceipt({ ...receipt, phase: "active" });
  }
  async owns(): Promise<boolean> {
    const receipt = await this.readReceipt();
    return !receipt || (await optionalText(this.path(this.legacy, "lease"))) === receipt.token;
  }
  async run(acquire: boolean, owner: string, operation: (imported: boolean) => Promise<void>) {
    const receipt = await this.readReceipt();
    const source = await this.source();
    const lease = await optionalText(this.path(this.legacy, "lease"));
    if (!receipt && source === undefined && lease === undefined) {
      this.receipt = undefined;
      return operation(false);
    }
    await withJournalLock(this.legacy, async () => {
      this.receipt = await this.readReceipt();
      const currentLease = await optionalText(this.path(this.legacy, "lease"));
      if (
        this.receipt?.phase === "releasing" &&
        (currentLease === undefined || currentLease === this.receipt.token)
      ) {
        await this.cleanup();
        return operation(false);
      }
      if (this.receipt && currentLease === this.receipt.token) {
        if (this.receipt.phase === "publishing") await this.replay(this.receipt);
        return operation(false);
      }
      // A fresh UUID from an old-version activation owns the old journal again.
      // Its dispose and rollback must not race a new policy's writes or cleanup.
      if (!acquire) return;
      await this.assertSafeTakeover(currentLease);
      const current = await this.source();
      if (current === undefined) {
        if (currentLease !== undefined) throw new Error("旧版壁纸恢复备份缺失；已保留租约");
        if (this.receipt) await this.cleanup();
        return operation(false);
      }
      if (!this.receipt && (await optionalText(this.path(this.directory, "backup"))) !== undefined)
        throw new Error("新旧壁纸恢复日志同时存在；已保留数据，请先停用旧版保护");
      const staged: Receipt = {
        format: 1,
        phase: "publishing",
        token: randomUUID(),
        owner,
        backup: current,
      };
      // The staged copy precedes lease revocation. If the process dies before
      // revocation, the next attempt re-reads the live source under this same lock.
      await this.writeReceipt(staged);
      await atomicText(this.path(this.legacy, "lease"), staged.token);
      await this.replay(staged);
      return operation(true);
    });
  }
  async publish(backup: string): Promise<void> {
    if (!this.receipt) return atomicText(this.path(this.directory, "backup"), backup);
    const owner = await optionalText(this.path(this.directory, "lease"));
    const staged: Receipt = {
      ...this.receipt,
      phase: "publishing",
      backup,
      owner: owner ?? this.receipt.owner,
    };
    await this.writeReceipt(staged);
    await this.replay(staged);
  }
  private async cleanup() {
    for (const directory of [this.legacy, this.directory])
      for (const name of ["backup", "powershell", "lease"] as const)
        await rm(this.path(directory, name), { force: true });
    await rm(this.receiptPath, { force: true });
    this.receipt = undefined;
  }
  async finish(): Promise<void> {
    if (!this.receipt) return;
    await this.writeReceipt({ ...this.receipt, phase: "releasing" });
    await this.cleanup();
  }
}
