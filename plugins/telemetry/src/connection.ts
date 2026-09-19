import { sign } from "node:crypto";
import { object } from "../../../shared/validation.ts";
import { connectionChallenge, telemetryEndpoint } from "../../../shared/telemetry.ts";
import type { TelemetryIdentity } from "./store.ts";

export class LiveConnection {
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stopped = false;
  private failures = 0;
  private lastPong = Date.now();
  connected = false;
  constructor(
    private readonly identity: TelemetryIdentity,
    private readonly requestReport: (id: string) => Promise<void>,
  ) {}
  start() {
    if (this.stopped) return;
    const url = new URL(`/api/live/${this.identity.publicKey}`, telemetryEndpoint);
    url.protocol = "wss:";
    const socket = new WebSocket(url);
    this.socket = socket;
    this.lastPong = Date.now();
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastPong > 75_000) socket.close();
      else if (socket.readyState === WebSocket.OPEN) socket.send("ping");
    }, 30_000);
    socket.onmessage = (event) => {
      if (socket !== this.socket || this.stopped) return;
      if (event.data === "pong") {
        this.lastPong = Date.now();
        return;
      }
      try {
        if (typeof event.data !== "string" || event.data.length > 4096)
          throw new Error("Invalid message");
        const value: unknown = JSON.parse(event.data);
        if (!object(value)) throw new Error("Invalid message");
        if (
          value.type === "challenge" &&
          typeof value.nonce === "string" &&
          value.nonce.length < 100
        )
          socket.send(
            JSON.stringify({
              type: "auth",
              signature: sign(
                null,
                Buffer.from(connectionChallenge(this.identity.publicKey, value.nonce)),
                this.identity.privateKey,
              ).toString("hex"),
            }),
          );
        else if (value.type === "ready") {
          this.connected = true;
          this.failures = 0;
          if (object(value.pending) && typeof value.pending.requestId === "string")
            void this.requestReport(value.pending.requestId).catch(() => {});
        } else if (value.type === "report_requested" && typeof value.requestId === "string")
          void this.requestReport(value.requestId).catch(() => {});
      } catch {
        socket.close();
      }
    };
    socket.onerror = () => {
      socket.close();
    };
    socket.onclose = () => {
      if (socket !== this.socket) return;
      this.connected = false;
      clearInterval(this.heartbeat);
      if (!this.stopped)
        this.retry = setTimeout(
          () => this.start(),
          Math.min(1000 * 2 ** this.failures++, 60_000) + Math.floor(Math.random() * 1000),
        );
    };
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    this.socket?.close();
    this.connected = false;
  }
}
