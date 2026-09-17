import { defineService, type Context, type JsonValue } from "@earendil-works/chord";

/** Versioned host primitives available to plugins with the host-control grant. */
export interface KernelService {
  call(operation: string, input: JsonValue, context: Context): Promise<JsonValue>;
}
export const HostKernel = defineService<KernelService>("chord-control.kernel.v1");
