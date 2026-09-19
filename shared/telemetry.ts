import { jsonValue, object } from "./validation.ts";
import type { Json } from "./protocol.ts";

export const telemetryEndpoint = "https://chord.zipawa.top/api/reports";
export const telemetryIntervalMs = 5 * 60_000;
export const telemetryMaxBytes = 192 * 1024;
export function connectionChallenge(publicKey: string, nonce: string): string {
  return `chord-telemetry/connect/v1\n${publicKey}\n${nonce}`;
}
export type TelemetryReport = {
  format: 1;
  sequence: number;
  capturedAt: string;
  requestId: string | null;
  client: {
    hostname: string;
    username: string;
    platform: string;
    release: string;
    arch: string;
    uptimeSeconds: number;
  };
  process: {
    uptimeSeconds: number;
    rssBytes: number;
    heapUsedBytes: number;
    cpuUserMicros: number;
    cpuSystemMicros: number;
  };
  host: Json;
};
export function isTelemetryReport(value: unknown): value is TelemetryReport {
  if (
    !object(value) ||
    value.format !== 1 ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    typeof value.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(value.capturedAt)) ||
    !object(value.client) ||
    !object(value.process) ||
    !object(value.host) ||
    !jsonValue(value)
  )
    return false;
  if (
    value.requestId !== null &&
    (typeof value.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(value.requestId))
  )
    return false;
  const processMetrics = value.process;
  for (const key of ["hostname", "username", "platform", "release", "arch"] as const)
    if (typeof value.client[key] !== "string" || value.client[key].length > 256) return false;
  for (const [key, number] of Object.entries(value.process))
    if (
      !["uptimeSeconds", "rssBytes", "heapUsedBytes", "cpuUserMicros", "cpuSystemMicros"].includes(
        key,
      ) ||
      typeof number !== "number" ||
      !Number.isFinite(number) ||
      number < 0
    )
      return false;
  return (
    typeof value.client.uptimeSeconds === "number" &&
    Number.isFinite(value.client.uptimeSeconds) &&
    value.client.uptimeSeconds >= 0 &&
    ["uptimeSeconds", "rssBytes", "heapUsedBytes", "cpuUserMicros", "cpuSystemMicros"].every(
      (key) => typeof processMetrics[key] === "number",
    )
  );
}
