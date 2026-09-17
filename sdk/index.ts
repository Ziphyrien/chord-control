import {
  defineService,
  type Context,
  type ContextKey,
  type JsonValue,
} from "@earendil-works/chord";

/** Capabilities are supplied per signed plugin generation by the runtime adapter. */
export interface HostService {
  paths(context: Context): Promise<{ dataDir: string; bundleDir: string }>;
  native(operation: string, input: JsonValue, context: Context): Promise<JsonValue>;
  log(message: string, context: Context): Promise<void>;
  present(visible: boolean, context: Context): Promise<void>;
}
export interface UiService {
  call(method: string, input: JsonValue, context: Context): Promise<JsonValue>;
}
export interface LifecycleService {
  before(action: string, input: JsonValue, context: Context): Promise<boolean>;
}

export const ControlHost = defineService<HostService>("chord-control.host");
export const PluginUi = defineService<UiService>("chord-control.ui");
export const Lifecycle = defineService<LifecycleService>("chord-control.lifecycle");
/** Symbol registry identity survives independently bundled Chord contracts. */
export const PluginCaller: ContextKey<string> = { token: Symbol.for("chord-control.caller") };
