import { randomUUID } from "node:crypto";
import type { ActivityItem } from "../../shared/protocol.ts";

export class ActivityLog {
  readonly items: ActivityItem[] = [];
  add(title: string, detail: string, tone: ActivityItem["tone"] = "info"): void {
    this.items.unshift({ id: randomUUID(), time: new Date().toISOString(), title, detail, tone });
    this.items.splice(100);
  }
}
