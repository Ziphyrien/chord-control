import { sign } from "node:crypto";
import { arch, hostname, platform, release, uptime, userInfo } from "node:os";
import type { DiagnosticSnapshot } from "../../../sdk/diagnostics.ts";
import type { Json } from "../../../shared/protocol.ts";
import {
  telemetryEndpoint,
  telemetryIntervalMs,
  telemetryMaxBytes,
  type TelemetryReport,
} from "../../../shared/telemetry.ts";
import { message } from "../../../shared/validation.ts";
import { TelemetryIdentity } from "./store.ts";
import { LiveConnection } from "./connection.ts";

export class Reporter {
  private readonly lifetime = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private identity?: TelemetryIdentity;
  private failures = 0;
  private live?: LiveConnection;
  private requestId: string | null = null;
  private stopped = false;
  private since = new Date().toISOString();
  private attempts = 0;
  private succeeded = 0;
  private failed = 0;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private lastMs: number | null = null;
  private lastBytes: number | null = null;
  private latest: TelemetryReport | null = null;
  constructor(
    private readonly directory: string,
    private readonly collect: (signal: AbortSignal) => Promise<Json>,
    private readonly log: (text: string) => Promise<void>,
  ) {}
  async start(): Promise<void> {
    this.identity = await TelemetryIdentity.load(this.directory);
    this.live = new LiveConnection(this.identity, async (id) => {
      this.requestId = id;
      await this.pending;
      if (this.requestId === id) await this.send();
    });
    this.live.start();
    this.timer = setTimeout(() => {
      void this.send();
    }, 3000);
  }
  status(): Json {
    const completed = this.succeeded + this.failed;
    return {
      connected: this.live?.connected ?? false,
      pendingRequestId: this.requestId,
      clientId: this.identity?.id ?? null,
      endpoint: telemetryEndpoint,
      intervalSeconds: telemetryIntervalMs / 1000,
      since: this.since,
      attempts: this.attempts,
      succeeded: this.succeeded,
      failed: this.failed,
      successRatio: completed ? this.succeeded / completed : null,
      sending: !!this.pending,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      lastMs: this.lastMs,
      lastBytes: this.lastBytes,
    };
  }
  metrics(): DiagnosticSnapshot {
    const completed = this.succeeded + this.failed;
    return {
      since: this.since,
      observedAt: new Date().toISOString(),
      lastError: this.lastError,
      metrics: [
        { name: "upload.attempts", kind: "counter", value: this.attempts, unit: "count" },
        { name: "upload.failed", kind: "counter", value: this.failed, unit: "count" },
        {
          name: "upload.successRatio",
          kind: "gauge",
          value: completed ? this.succeeded / completed : null,
          unit: "ratio",
        },
        { name: "upload.lastDuration", kind: "gauge", value: this.lastMs, unit: "ms" },
        { name: "upload.lastBytes", kind: "gauge", value: this.lastBytes, unit: "bytes" },
        {
          name: "connection.up",
          kind: "gauge",
          value: this.live?.connected ? 1 : 0,
          unit: "boolean",
        },
      ],
    };
  }
  report(): Json {
    return this.latest;
  }
  send(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.stopped || !this.identity) return Promise.resolve();
    clearTimeout(this.timer);
    this.pending = this.attempt().finally(() => {
      this.pending = undefined;
      if (!this.stopped)
        this.timer = setTimeout(
          () => {
            void this.send();
          },
          Math.min(telemetryIntervalMs * 2 ** this.failures, 30 * 60_000),
        );
    });
    return this.pending;
  }
  private async attempt(): Promise<void> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]);
    const started = performance.now();
    this.attempts++;
    try {
      const identity = this.identity!;
      const sequence = await identity.next();
      const requestId = this.requestId;
      const host = await this.collect(signal);
      const memory = process.memoryUsage(),
        cpu = process.cpuUsage();
      const report: TelemetryReport = {
        format: 1,
        sequence,
        requestId,
        capturedAt: new Date().toISOString(),
        client: {
          hostname: hostname(),
          username: userInfo().username,
          platform: platform(),
          release: release(),
          arch: arch(),
          uptimeSeconds: uptime(),
        },
        process: {
          uptimeSeconds: process.uptime(),
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          cpuUserMicros: cpu.user,
          cpuSystemMicros: cpu.system,
        },
        host,
      };
      this.latest = report;
      const body = JSON.stringify(report);
      this.lastBytes = Buffer.byteLength(body);
      if (this.lastBytes > telemetryMaxBytes) throw new Error("诊断报告超出上传限制");
      const response = await fetch(telemetryEndpoint, {
        method: "POST",
        body,
        signal,
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "X-Client-Key": identity.publicKey,
          "X-Client-Signature": sign(null, Buffer.from(body), identity.privateKey).toString("hex"),
        },
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`遥测接收端返回 HTTP ${response.status}`);
      this.succeeded++;
      this.failures = 0;
      this.lastError = null;
      if (this.requestId === requestId) this.requestId = null;
      this.lastSuccessAt = new Date().toISOString();
    } catch (error) {
      this.failed++;
      this.failures = Math.min(this.failures + 1, 3);
      this.lastError = message(error).slice(0, 1000);
      if (!this.stopped) await this.log(`遥测上传失败: ${this.lastError}`).catch(() => {});
    } finally {
      this.lastMs = Math.round(performance.now() - started);
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.live?.stop();
    clearTimeout(this.timer);
    this.lifetime.abort();
    await this.pending;
  }
}
