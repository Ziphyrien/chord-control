import type { Json } from "./protocol.ts";

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function jsonValue(value: unknown, depth = 0): value is Json {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => jsonValue(item, depth + 1));
  return object(value) && Object.values(value).every((item) => jsonValue(item, depth + 1));
}
export function text(value: unknown, label: string, max = 4096, empty = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.length) ||
    value.includes("\0")
  )
    throw new Error(`${label} 格式错误`);
  return value;
}
export function strings(value: unknown, label: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} 格式错误`);
  const entries = value.map((item) => text(item, label, 150));
  if (new Set(entries).size !== entries.length) throw new Error(`${label} 包含重复项`);
  return entries;
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
