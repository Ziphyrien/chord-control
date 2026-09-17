import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
const NOTE_LIMIT = 10_000;

/** Preserve the established note.txt format while making writes ordered and atomic. */
export class Notes {
  private readonly directory: string;
  private readonly path: string;
  private writes: Promise<void> = Promise.resolve();
  constructor(directory: string) {
    if (!directory) throw new Error("便笺存储尚未准备好");
    this.directory = directory;
    this.path = join(directory, "note.txt");
  }
  async read(): Promise<string> {
    await this.writes;
    try {
      return await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }
  save(value: unknown): Promise<void> {
    if (typeof value !== "string" || value.length > NOTE_LIMIT)
      return Promise.reject(new Error(`便笺最多 ${NOTE_LIMIT} 个字符`));
    const next = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx");
        try {
          await file.writeFile(value, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.writes = next.catch(() => {});
    return next;
  }
  async drain(): Promise<void> {
    await this.writes;
  }
}
