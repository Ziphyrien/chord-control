import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginManifest } from "../../shared/protocol.ts";
import { unpack, verifyHash } from "./artifacts.ts";

export async function atomicWrite(path: string, value: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export class ArchiveStore {
  constructor(
    readonly directory: string,
    readonly staging: string,
  ) {}
  async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await rm(this.staging, { recursive: true, force: true });
    await mkdir(this.staging, { recursive: true });
  }
  async read(manifest: PluginManifest): Promise<Uint8Array> {
    const bytes = await readFile(join(this.directory, `${manifest.artifactSha256}.zip`));
    verifyHash(manifest, bytes);
    return bytes;
  }
  async write(manifest: PluginManifest, bytes: Uint8Array): Promise<void> {
    await atomicWrite(join(this.directory, `${manifest.artifactSha256}.zip`), bytes);
  }
  async validate(manifest: PluginManifest, bytes: Uint8Array): Promise<void> {
    const directory = await unpack(this.staging, manifest, bytes);
    await rm(directory, { recursive: true });
  }
}
