export type Browser = "edge" | "chrome";
export interface ProcessIdentity {
  pid: number;
  createdAt: string;
  executable: string;
}
export interface ProcessRow extends ProcessIdentity {
  parentPid: number;
  name: string;
}
export const BROWSER_NAMES = ["msedge.exe", "chrome.exe"];
export function browserOf(row: ProcessRow): Browser {
  return row.name.toLowerCase() === "msedge.exe" ? "edge" : "chrome";
}
export function identity(value: unknown): ProcessIdentity {
  const row = value as Partial<ProcessIdentity> | null;
  if (
    !row ||
    !Number.isSafeInteger(row.pid) ||
    Number(row.pid) <= 0 ||
    typeof row.createdAt !== "string" ||
    !row.createdAt ||
    typeof row.executable !== "string" ||
    !row.executable ||
    row.executable.includes("\0")
  )
    throw new Error("原生进程标识无效");
  return { pid: Number(row.pid), createdAt: row.createdAt, executable: row.executable };
}
export function snapshot(value: unknown): ProcessRow[] {
  if (!Array.isArray(value) || value.length > 100000) throw new Error("原生进程快照无效");
  return value.map((value) => {
    const id = identity(value);
    if (
      !Number.isSafeInteger(value.parentPid) ||
      value.parentPid < 0 ||
      typeof value.name !== "string" ||
      !BROWSER_NAMES.includes(value.name.toLowerCase())
    )
      throw new Error("浏览器进程快照无效");
    return { ...id, parentPid: value.parentPid, name: value.name };
  });
}
const key = (row: ProcessIdentity) => `${row.pid}:${row.createdAt}:${row.executable.toLowerCase()}`;

/** Baseline processes survive activation; new process identities require a grant. */
export class BrowserGate {
  private allowed = new Set<string>();
  private grants = new Set<string>();
  readonly paths = new Map<Browser, string>();
  initialize(rows: ProcessRow[]): void {
    this.allowed = new Set(rows.map(key));
    this.grants.clear();
    this.remember(rows);
  }
  authorize(row: ProcessIdentity): void {
    this.grants.add(key(row));
  }
  private remember(rows: ProcessRow[]): void {
    for (const row of rows) this.paths.set(browserOf(row), row.executable);
  }
  blocked(rows: ProcessRow[]): ProcessRow[] {
    this.remember(rows);
    const allowed = new Set(
      rows.filter((row) => this.allowed.has(key(row)) || this.grants.has(key(row))).map(key),
    );
    // Descendants inherit only an allowed parent's identity in this same snapshot.
    let changed = true;
    while (changed) {
      changed = false;
      const parents = new Set(rows.filter((row) => allowed.has(key(row))).map((row) => row.pid));
      for (const row of rows)
        if (!allowed.has(key(row)) && parents.has(row.parentPid)) {
          allowed.add(key(row));
          changed = true;
        }
    }
    this.allowed = allowed;
    // Spawn grants are consumed on the next serialized poll, never a timed browser-wide exemption.
    this.grants.clear();
    return rows.filter((row) => !allowed.has(key(row)));
  }
}
