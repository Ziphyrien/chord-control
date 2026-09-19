import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { object } from "../../../shared/validation.ts";

type Identity = { privateKey: string; publicKey: string; sequence: number };
export class TelemetryIdentity {
  private constructor(
    private readonly file: string,
    private readonly identity: Identity,
  ) {}
  static async load(directory: string): Promise<TelemetryIdentity> {
    const file = join(directory, "identity.json");
    let value: unknown;
    try {
      value = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const keys = generateKeyPairSync("ed25519");
      value = {
        privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKey: keys.publicKey
          .export({ type: "spki", format: "der" })
          .subarray(-32)
          .toString("hex"),
        sequence: 0,
      };
      await writeFile(file, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    }
    if (
      !object(value) ||
      typeof value.privateKey !== "string" ||
      typeof value.publicKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.publicKey) ||
      !Number.isSafeInteger(value.sequence) ||
      Number(value.sequence) < 0
    )
      throw new Error("遥测身份文件无效");
    const privateKey = createPrivateKey(value.privateKey);
    if (
      privateKey.asymmetricKeyType !== "ed25519" ||
      createPublicKey(privateKey)
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("hex") !== value.publicKey
    )
      throw new Error("遥测身份密钥不匹配");
    return new TelemetryIdentity(file, {
      privateKey: value.privateKey,
      publicKey: value.publicKey,
      sequence: Number(value.sequence),
    });
  }
  get id(): string {
    return createHash("sha256").update(Buffer.from(this.identity.publicKey, "hex")).digest("hex");
  }
  get publicKey(): string {
    return this.identity.publicKey;
  }
  get privateKey(): string {
    return this.identity.privateKey;
  }
  async next(): Promise<number> {
    if (this.identity.sequence >= Number.MAX_SAFE_INTEGER) throw new Error("遥测序号已耗尽");
    this.identity.sequence++;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(this.identity), { flag: "wx", mode: 0o600 });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
    return this.identity.sequence;
  }
}
