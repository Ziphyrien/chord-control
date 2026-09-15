import { randomInt, randomUUID } from "node:crypto";
const GRID_SIZE = 6;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function dailyPassword(date = new Date()): string {
  return `${date.getMonth() + 1 + date.getDate()}${["S", "M", "T", "W", "T", "F", "S"][date.getDay()]}`;
}
function dateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
function adjacent(a: number, b: number): boolean {
  return (
    a !== b &&
    Math.abs((a % GRID_SIZE) - (b % GRID_SIZE)) <= 1 &&
    Math.abs(Math.floor(a / GRID_SIZE) - Math.floor(b / GRID_SIZE)) <= 1
  );
}
function createGrid(password: string, random = randomInt): string[] {
  const cells = Array.from({ length: GRID_SIZE ** 2 }, () => ALPHABET[random(ALPHABET.length)]);
  const path = [random(cells.length)];
  for (let i = 1; i < password.length; i++) {
    const next = cells
      .map((_, index) => index)
      .filter((index) => !path.includes(index) && adjacent(path.at(-1)!, index));
    path.push(next[random(next.length)]);
  }
  path.forEach((index, offset) => {
    cells[index] = password[offset];
  });
  return cells;
}
type Challenge = {
  id: string;
  title: string;
  cells: string[];
  expiresAt: number;
  day: string;
  password: string;
  attempts: number;
  finish(granted: boolean): void;
};
export class Challenges {
  private readonly pending = new Map<string, Challenge>();
  constructor(
    private readonly changed: () => void,
    private readonly now = () => new Date(),
  ) {}
  request(title: string, signal?: AbortSignal): Promise<boolean> {
    if (this.pending.size >= 12 || signal?.aborted) return Promise.resolve(false);
    const date = this.now(),
      password = dailyPassword(date),
      id = randomUUID();
    return new Promise((resolve) => {
      const cancel = () => finish(false);
      const timer = setTimeout(cancel, 120000);
      const finish = (granted: boolean) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        resolve(granted);
        this.changed();
      };
      this.pending.set(id, {
        id,
        title: title.slice(0, 120),
        cells: createGrid(password),
        expiresAt: date.getTime() + 120000,
        day: dateKey(date),
        password,
        attempts: 0,
        finish,
      });
      signal?.addEventListener("abort", cancel, { once: true });
      this.changed();
    });
  }
  view(): { id: string; title: string; cells: string[]; size: number; expiresAt: number } | null {
    for (const item of this.pending.values())
      if (this.now().getTime() >= item.expiresAt || dateKey(this.now()) !== item.day)
        item.finish(false);
    const item = this.pending.values().next().value;
    return item
      ? {
          id: item.id,
          title: item.title,
          cells: [...item.cells],
          size: GRID_SIZE,
          expiresAt: item.expiresAt,
        }
      : null;
  }
  submit(id: string, path: unknown): boolean {
    const item = this.pending.get(id);
    if (!item) return false;
    if (this.now().getTime() >= item.expiresAt || dateKey(this.now()) !== item.day) {
      item.finish(false);
      return false;
    }
    const valid =
      Array.isArray(path) &&
      path.length === item.password.length &&
      path.every((index) => Number.isInteger(index) && index >= 0 && index < GRID_SIZE ** 2) &&
      new Set(path).size === path.length &&
      path.every((index, offset) => offset === 0 || adjacent(path[offset - 1], index)) &&
      path.map((index) => item.cells[index]).join("") === item.password;
    if (valid) item.finish(true);
    else if (++item.attempts >= 5) item.finish(false);
    else {
      item.cells = createGrid(item.password);
      this.changed();
    }
    return valid;
  }
  cancel(id: string): void {
    this.pending.get(id)?.finish(false);
  }
  dispose(): void {
    for (const item of this.pending.values()) item.finish(false);
  }
}
