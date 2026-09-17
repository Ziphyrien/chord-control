import { defineService, type Context, type JsonValue } from "@earendil-works/chord";

/** Stable, versioned primitives. High-level APIs belong to independently updated service plugins. */
export interface KernelService {
  call(operation: string, input: JsonValue, context: Context): Promise<JsonValue>;
}
export const HostKernel = defineService<KernelService>("chord-control.kernel.v1");
