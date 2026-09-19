import type { Json } from "../../../shared/protocol.ts";
import { message } from "../../../shared/validation.ts";

type Counter = {
  pluginId: string;
  operation: string;
  since: string;
  attempts: number;
  succeeded: number;
  failed: number;
  inFlight: number;
  totalMs: number;
  maxMs: number;
  lastMs: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
};

/** Observations only: rates describe completed calls, never an invented health score. */
export class OperationMetrics {
  private readonly entries = new Map<string, Counter>();
  async measure<T>(pluginId: string, operation: string, task: () => Promise<T>): Promise<T> {
    operation = operation.slice(0, 80);
    const key = `${pluginId}:${operation}`;
    let counter = this.entries.get(key);
    if (!counter) {
      if (this.entries.size >= 128) this.entries.delete(this.entries.keys().next().value!);
      counter = {
        pluginId,
        operation,
        since: new Date().toISOString(),
        attempts: 0,
        succeeded: 0,
        failed: 0,
        inFlight: 0,
        totalMs: 0,
        maxMs: 0,
        lastMs: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastError: null,
      };
      this.entries.set(key, counter);
    }
    counter.attempts++;
    counter.inFlight++;
    const started = performance.now();
    try {
      const result = await task();
      counter.succeeded++;
      counter.lastSuccessAt = new Date().toISOString();
      return result;
    } catch (error) {
      counter.failed++;
      counter.lastFailureAt = new Date().toISOString();
      counter.lastError = message(error).slice(0, 300);
      throw error;
    } finally {
      const elapsed = Math.round((performance.now() - started) * 100) / 100;
      counter.inFlight--;
      counter.totalMs += elapsed;
      counter.lastMs = elapsed;
      counter.maxMs = Math.max(counter.maxMs, elapsed);
    }
  }
  snapshot(): Json {
    return [...this.entries.values()].map((item) => {
      const completed = item.succeeded + item.failed;
      return {
        ...item,
        successRatio: completed ? item.succeeded / completed : null,
        meanMs: completed ? Math.round((item.totalMs / completed) * 100) / 100 : null,
      };
    });
  }
}
