import { DurableObject } from "cloudflare:workers";
import { object } from "../../../shared/validation.ts";
import { connectionChallenge } from "../../../shared/telemetry.ts";

type Session = { publicKey: string; nonce: string; expiresAt: number; authenticated: boolean };
type Pending = { requestId: string; requestedAt: string };
/** One connection coordinator per client identity; hibernation keeps idle clients inexpensive. */
export class DeviceConnection extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pending (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), requestId TEXT NOT NULL, requestedAt TEXT NOT NULL)",
    );
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  private pending(): Pending | null {
    return (
      this.ctx.storage.sql
        .exec<Pending>("SELECT requestId, requestedAt FROM pending WHERE singleton = 1")
        .toArray()[0] ?? null
    );
  }
  state() {
    return {
      connected: this.ctx
        .getWebSockets()
        .some((ws) => (ws.deserializeAttachment() as Session).authenticated),
      pending: this.pending(),
    };
  }
  requestReport() {
    let pending = this.pending();
    if (!pending) {
      pending = { requestId: crypto.randomUUID(), requestedAt: new Date().toISOString() };
      this.ctx.storage.sql.exec(
        "INSERT INTO pending(singleton, requestId, requestedAt) VALUES (1, ?, ?)",
        pending.requestId,
        pending.requestedAt,
      );
    }
    for (const ws of this.ctx.getWebSockets())
      if ((ws.deserializeAttachment() as Session).authenticated) {
        try {
          ws.send(JSON.stringify({ type: "report_requested", ...pending }));
        } catch {
          ws.close(1011, "Reconnect");
        }
      }
    return this.state();
  }
  acknowledge(requestId: string) {
    this.ctx.storage.sql.exec(
      "DELETE FROM pending WHERE singleton = 1 AND requestId = ?",
      requestId,
    );
  }
  async fetch(request: Request): Promise<Response> {
    const publicKey = request.headers.get("X-Client-Key") ?? "";
    if (
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
      !/^[a-f0-9]{64}$/.test(publicKey)
    )
      return new Response("WebSocket required", { status: 400 });
    if (this.ctx.getWebSockets().length >= 8)
      return new Response("Too many connections", { status: 429 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const session: Session = {
      publicKey,
      nonce: crypto.randomUUID(),
      expiresAt: Date.now() + 30_000,
      authenticated: false,
    };
    server.serializeAttachment(session);
    server.send(JSON.stringify({ type: "challenge", nonce: session.nonce }));
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > session.expiresAt)
      await this.ctx.storage.setAlarm(session.expiresAt);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const session = ws.deserializeAttachment() as Session;
    try {
      if (
        typeof message !== "string" ||
        message.length > 2048 ||
        session.authenticated ||
        Date.now() > session.expiresAt
      )
        throw new Error("Invalid authentication");
      const value: unknown = JSON.parse(message);
      if (
        !object(value) ||
        value.type !== "auth" ||
        typeof value.signature !== "string" ||
        !/^[a-f0-9]{128}$/.test(value.signature)
      )
        throw new Error("Invalid signature");
      const decode = (hex: string) =>
        Uint8Array.from(hex.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
      const key = await crypto.subtle.importKey(
        "raw",
        decode(session.publicKey),
        "Ed25519",
        false,
        ["verify"],
      );
      if (
        !(await crypto.subtle.verify(
          "Ed25519",
          key,
          decode(value.signature),
          new TextEncoder().encode(connectionChallenge(session.publicKey, session.nonce)),
        ))
      )
        throw new Error("Invalid signature");
      session.authenticated = true;
      ws.serializeAttachment(session);
      for (const previous of this.ctx.getWebSockets())
        if (previous !== ws && (previous.deserializeAttachment() as Session).authenticated)
          previous.close(1000, "Replaced");
      ws.send(JSON.stringify({ type: "ready", pending: this.pending() }));
    } catch {
      ws.close(1008, "Authentication failed");
    }
  }
  webSocketClose(ws: WebSocket, code: number, reason: string) {
    ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
  }
  webSocketError(ws: WebSocket) {
    ws.close(1011, "Reconnect");
  }
  async alarm() {
    let next = Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const session = ws.deserializeAttachment() as Session;
      if (!session.authenticated) {
        if (session.expiresAt <= Date.now()) ws.close(1008, "Authentication timed out");
        else next = Math.min(next, session.expiresAt);
      }
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }
}
