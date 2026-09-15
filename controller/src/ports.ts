import type { Json, PluginManifest } from "../../shared/protocol.ts";

export interface PluginLifecycle {
  has(id: string): boolean;
  activate(manifest: PluginManifest, archive: Uint8Array): Promise<void>;
  deactivate(id: string): Promise<void>;
  before(id: string, action: string, input: Json): Promise<boolean>;
  dispose(): Promise<void>;
}
export interface PluginPage {
  html: string;
  revision: string;
}
export interface PluginUi {
  ui(id: string): Promise<PluginPage>;
  call(id: string, method: string, input: Json): Promise<Json>;
}
export type Enqueue = <T>(task: () => Promise<T>) => Promise<T>;
