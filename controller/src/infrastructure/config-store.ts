import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "./files.ts";
import {
  emptyConfiguration,
  readConfiguration,
  type Configuration,
} from "../domain/configuration.ts";
import type { ConfigRepository } from "../domain/ports.ts";
import { object } from "../../../shared/validation.ts";

export class ConfigStore implements ConfigRepository {
  private state: Configuration = emptyConfiguration();
  readonly file: string;
  private readonly allowUnsigned: boolean;
  constructor(directory: string, allowUnsigned = false) {
    this.file = join(directory, "config.json");
    this.allowUnsigned = allowUnsigned;
  }
  snapshot(): Configuration {
    return structuredClone(this.state);
  }
  async load(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if (!object(error) || error.code !== "ENOENT") throw error;
      await this.commit(emptyConfiguration());
      return;
    }
    const input: unknown = JSON.parse(content.replace(/^\uFEFF/, ""));
    const next = readConfiguration(input, this.allowUnsigned);
    if (object(input) && input.format !== next.format) await this.commit(next);
    else this.state = next;
  }
  async commit(next: Configuration): Promise<void> {
    // State becomes visible only after its durable replacement succeeds.
    const validated = readConfiguration(next, this.allowUnsigned);
    await atomicWrite(this.file, JSON.stringify(validated, null, 2) + "\n");
    this.state = structuredClone(validated);
  }
}
