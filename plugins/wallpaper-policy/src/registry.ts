export type RawValue = { type: number; bytes: number[] } | null;
export interface PolicyEntry {
  path: string;
  name: string;
  original: RawValue;
  installed: RawValue;
  prior?: RawValue;
  managed: boolean;
}
export const POLICY_KEYS = [
  [
    String.raw`Software\Microsoft\Windows\CurrentVersion\Policies\ActiveDesktop`,
    "NoChangingWallPaper",
  ],
  [String.raw`Software\Microsoft\Windows\CurrentVersion\Policies\System`, "Wallpaper"],
  [String.raw`Software\Microsoft\Windows\CurrentVersion\Policies\System`, "WallpaperStyle"],
  [String.raw`Control Panel\Desktop`, "WallpaperStyle"],
  [String.raw`Control Panel\Desktop`, "TileWallpaper"],
] as const;
export function stringValue(text: string, type = 1): Exclude<RawValue, null> {
  return { type, bytes: [...Buffer.from(`${text}\0`, "utf16le")] };
}
export function dwordValue(value: number): Exclude<RawValue, null> {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return { type: 4, bytes: [...bytes] };
}
export function policyValues(wallpaper: string): RawValue[] {
  return [
    dwordValue(1),
    stringValue(wallpaper),
    stringValue("4"),
    stringValue("10"),
    stringValue("0"),
  ];
}
export function sameValue(left: RawValue, right: RawValue): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.type === right.type &&
    left.bytes.length === right.bytes.length &&
    left.bytes.every((byte, index) => byte === right.bytes[index])
  );
}
export function parseRaw(value: unknown): RawValue {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("注册表备份值无效");
  const raw = value as Record<string, unknown>;
  if (
    !Number.isInteger(raw.type) ||
    Number(raw.type) < 0 ||
    Number(raw.type) > 0xffffffff ||
    !Array.isArray(raw.bytes) ||
    raw.bytes.length > 1_048_576 ||
    !raw.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  )
    throw new Error("注册表备份值无效");
  return { type: Number(raw.type), bytes: [...raw.bytes] };
}
/** Decode the exact registry kinds used by the retired PowerShell journal. */
export function legacyValue(value: unknown): RawValue {
  if (!value || typeof value !== "object") throw new Error("旧版注册表备份无效");
  const raw = value as Record<string, unknown>;
  if (raw.present === false) return null;
  if (raw.present !== true) throw new Error("旧版注册表备份无效");
  if ((raw.kind === "String" || raw.kind === "ExpandString") && typeof raw.value === "string")
    return stringValue(raw.value, raw.kind === "String" ? 1 : 2);
  if (
    raw.kind === "DWord" &&
    Number.isInteger(raw.value) &&
    Number(raw.value) >= -2147483648 &&
    Number(raw.value) <= 0xffffffff
  )
    return dwordValue(Number(raw.value));
  if (raw.kind === "Binary") return parseRaw({ type: 3, bytes: raw.value });
  if (
    raw.kind === "MultiString" &&
    Array.isArray(raw.value) &&
    raw.value.every((text) => typeof text === "string")
  )
    return stringValue(`${raw.value.join("\0")}\0`, 7);
  if (raw.kind === "QWord" && (typeof raw.value === "string" || Number.isSafeInteger(raw.value))) {
    const number = BigInt(String(raw.value));
    if (number < -(1n << 63n) || number >= 1n << 64n) throw new Error("旧版 QWord 超出范围");
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt.asUintN(64, number));
    return { type: 11, bytes: [...bytes] };
  }
  throw new Error("旧版壁纸备份包含无效的注册表值");
}
