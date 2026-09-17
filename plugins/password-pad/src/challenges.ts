import { randomUUID } from "node:crypto";
import { GRID_SIZE, type ChallengeView } from "../input.ts";
import { accepts, localDay, makeBoard, passwordFor } from "./board.ts";
const LIFETIME_MS = 120_000;
const ATTEMPTS = 5;
interface Pending {
  view: ChallengeView;
  answer: string;
  day: string;
  attempts: number;
  settle(approved: boolean): void;
}

/** FIFO authorization queue. Each request owns its deadline, attempts and abort listener. */
export class Challenges {
  private readonly queue = new Map<string, Pending>();
  private readonly changed: () => void;
  private readonly now: () => Date;
  private disposed = false;
  constructor(changed: () => void, now = () => new Date()) {
    this.changed = changed;
    this.now = now;
  }
  get pending(): boolean {
    return this.queue.size > 0;
  }
  request(title: string, signal?: AbortSignal): Promise<boolean> {
    if (this.disposed || signal?.aborted || this.queue.size >= 12) return Promise.resolve(false);
    const date = this.now();
    const answer = passwordFor(date);
    const id = randomUUID();
    return new Promise((resolve) => {
      const deny = () => settle(false);
      const timer = setTimeout(deny, LIFETIME_MS);
      const settle = (approved: boolean) => {
        if (!this.queue.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", deny);
        resolve(approved);
        this.changed();
      };
      this.queue.set(id, {
        answer,
        day: localDay(date),
        attempts: 0,
        settle,
        view: {
          id,
          revision: 0,
          title: title.slice(0, 120),
          cells: makeBoard(answer),
          size: GRID_SIZE,
          expiresAt: date.getTime() + LIFETIME_MS,
        },
      });
      signal?.addEventListener("abort", deny, { once: true });
      this.changed();
    });
  }
  private current(): Pending | undefined {
    const date = this.now();
    for (const item of this.queue.values()) {
      if (date.getTime() >= item.view.expiresAt || localDay(date) !== item.day) item.settle(false);
    }
    return this.queue.values().next().value;
  }
  view(): ChallengeView | null {
    const item = this.current();
    return item ? { ...item.view, cells: [...item.view.cells] } : null;
  }
  submit(id: string, revision: unknown, sequence: unknown): boolean {
    const item = this.current();
    if (!item || item.view.id !== id || revision !== item.view.revision) return false;
    const approved = accepts(item.view.cells, item.answer, sequence);
    if (approved || ++item.attempts >= ATTEMPTS) item.settle(approved);
    else {
      item.view = { ...item.view, revision: item.view.revision + 1, cells: makeBoard(item.answer) };
      this.changed();
    }
    return approved;
  }
  close(): void {
    for (const item of this.queue.values()) item.settle(false);
  }
  dispose(): void {
    this.disposed = true;
    this.close();
  }
}
