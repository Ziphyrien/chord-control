import type { Json, PluginManifest, PluginCatalog } from "../../../shared/protocol.ts";
import type { Configuration, PluginSource } from "./configuration.ts";

export interface ConfigRepository {
  snapshot(): Configuration;
  commit(next: Configuration): Promise<void>;
}
export interface Archives {
  read(manifest: PluginManifest): Promise<Uint8Array>;
  write(manifest: PluginManifest, bytes: Uint8Array): Promise<void>;
  validate(manifest: PluginManifest, bytes: Uint8Array): Promise<void>;
}
export interface ReleaseSource {
  manifest(
    source: PluginSource,
    etag?: string,
    cached?: PluginManifest,
  ): Promise<{ value: PluginManifest; etag?: string }>;
  catalog(
    source: PluginSource,
    etag?: string,
    cached?: PluginCatalog,
  ): Promise<{ value: PluginCatalog; etag?: string }>;
  archive(manifest: PluginManifest): Promise<Uint8Array>;
  close(): void;
}
export interface PluginPage {
  html: string;
  revision: string;
}
export interface PluginRuntime {
  has(id: string): boolean;
  revision(id: string): string | undefined;
  activate(manifest: PluginManifest, archive: Uint8Array): Promise<void>;
  deactivate(id: string): Promise<void>;
  before(id: string, action: string, input: Json): Promise<boolean>;
  ui(id: string): Promise<PluginPage>;
  call(id: string, method: string, input: Json): Promise<Json>;
}
export type Enqueue = <T>(operation: () => Promise<T>) => Promise<T>;
export type Activity = (
  title: string,
  detail: string,
  tone?: "info" | "success" | "warning" | "error",
) => void;
