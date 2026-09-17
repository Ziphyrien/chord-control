import { randomUUID } from "node:crypto";
import type { ActivityItem, ActivityTone } from "../../../shared/protocol.ts";
import type { Enqueue } from "../domain/ports.ts";

/** The callback owns the gate only for its own critical section. Downloads never use it. */
export function serialQueue(): Enqueue {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
}
export class ActivityLog {
  private entries: ActivityItem[] = [];
  snapshot(): ActivityItem[] {
    return this.entries.map((item) => ({ ...item }));
  }
  add = (title: string, detail: string, tone: ActivityTone = "info"): void => {
    this.entries.unshift({
      id: randomUUID(),
      time: new Date().toISOString(),
      title,
      detail: detail.slice(0, 4000),
      tone,
    });
    this.entries.length = Math.min(this.entries.length, 100);
  };
}
