import { defineService, type Context, type JsonValue } from "@earendil-works/chord";
import { object } from "../shared/validation.ts";

export type DiagnosticMetric = {
  name: string;
  kind: "counter" | "gauge";
  value: number | null;
  unit: string;
};
export type DiagnosticSnapshot = {
  since: string;
  observedAt: string;
  metrics: DiagnosticMetric[];
  lastError: string | null;
};
/** Read-only operational state, available to any plugin declaring diagnostics permission. */
export interface HostDiagnosticService {
  snapshot(context: Context): Promise<JsonValue>;
}
export interface PluginDiagnosticService {
  snapshot(context: Context): Promise<DiagnosticSnapshot>;
}
export const HostDiagnostics = defineService<HostDiagnosticService>("chord-control.diagnostics");
/** Optional local service, discovered without adding a dependency on any business plugin. */
export const PluginDiagnostics = defineService<PluginDiagnosticService>(
  "chord-control.plugin-diagnostics",
);
export function isDiagnosticSnapshot(value: unknown): value is DiagnosticSnapshot {
  if (
    !object(value) ||
    typeof value.since !== "string" ||
    !Number.isFinite(Date.parse(value.since)) ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !Array.isArray(value.metrics) ||
    value.metrics.length > 64 ||
    !(
      value.lastError === null ||
      (typeof value.lastError === "string" && value.lastError.length <= 1000)
    )
  )
    return false;
  return value.metrics.every(
    (metric) =>
      object(metric) &&
      typeof metric.name === "string" &&
      metric.name.length <= 100 &&
      ["counter", "gauge"].includes(String(metric.kind)) &&
      (metric.value === null ||
        (typeof metric.value === "number" && Number.isFinite(metric.value))) &&
      typeof metric.unit === "string" &&
      metric.unit.length <= 32,
  );
}
