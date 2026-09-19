import { timingSafeEqual } from "node:crypto";
import { isTelemetryReport, telemetryMaxBytes } from "../../../shared/telemetry.ts";
import { object } from "../../../shared/validation.ts";
export { DeviceConnection } from "./connections.ts";

type Device = {
  id: string;
  public_key: string;
  label: string;
  trusted: number;
  first_seen: string;
  last_seen: string;
  sequence: number;
  payload: string;
};
class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function unhex(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
}
async function body(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get("Content-Length")) > limit)
    throw new RequestError(413, "报告过大");
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, "请求内容为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RequestError(413, "报告过大");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
function parse(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new RequestError(400, "JSON格式无效");
  }
}
async function admin(request: Request, env: Env): Promise<void> {
  if (!env.ADMIN_TOKEN) throw new RequestError(503, "管理密钥尚未配置");
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(env.ADMIN_TOKEN)),
  ]);
  if (!timingSafeEqual(new Uint8Array(left), new Uint8Array(right)))
    throw new RequestError(401, "管理密钥无效");
}
function describe(row: Device) {
  return {
    id: row.id,
    label: row.label,
    trusted: row.trusted === 1,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    ageSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(row.last_seen)) / 1000)),
    sequence: row.sequence,
    report: JSON.parse(row.payload),
  };
}
async function ingest(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json")
    throw new RequestError(415, "需要JSON报告");
  const publicKey = request.headers.get("X-Client-Key") ?? "",
    signature = request.headers.get("X-Client-Signature") ?? "";
  if (!/^[a-f0-9]{64}$/.test(publicKey) || !/^[a-f0-9]{128}$/.test(signature))
    throw new RequestError(401, "缺少有效客户端签名");
  const bytes = await body(request, telemetryMaxBytes);
  const key = await crypto.subtle.importKey("raw", unhex(publicKey), { name: "Ed25519" }, false, [
    "verify",
  ]);
  if (!(await crypto.subtle.verify("Ed25519", key, unhex(signature), bytes)))
    throw new RequestError(401, "客户端签名无效");
  const report = parse(bytes);
  if (!isTelemetryReport(report)) throw new RequestError(400, "报告字段无效");
  const id = hex(await crypto.subtle.digest("SHA-256", unhex(publicKey)));
  const previous = await env.DB.prepare("SELECT sequence FROM devices WHERE id = ?")
    .bind(id)
    .first<{ sequence: number }>();
  if (previous && previous.sequence >= report.sequence)
    throw new RequestError(409, "报告序号已接收");
  const now = new Date().toISOString(),
    payload = JSON.stringify(report);
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO devices (id, public_key, first_seen, last_seen, sequence, payload) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM devices WHERE id = ?) OR (SELECT COUNT(*) FROM devices WHERE trusted = 0) < 1000 ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, sequence = excluded.sequence, payload = excluded.payload WHERE excluded.sequence > devices.sequence",
    ).bind(id, publicKey, now, now, report.sequence, payload, id),
    env.DB.prepare(
      "INSERT OR IGNORE INTO reports (device_id, sequence, received_at, payload) SELECT id, ?, ?, ? FROM devices WHERE id = ? AND trusted = 1 AND sequence = ?",
    ).bind(report.sequence, now, payload, id, report.sequence),
  ]);
  if (!results[0].meta.changes) throw new RequestError(previous ? 409 : 429, "报告未被接收");
  if (report.requestId) await env.CONNECTIONS.getByName(id).acknowledge(report.requestId);
  return Response.json({ clientId: id, receivedAt: now }, { status: 201 });
}
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname;
  if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
  const limited = await env.RATE_LIMIT.limit({
    key: request.headers.get("CF-Connecting-IP") ?? "local",
  });
  if (!limited.success) throw new RequestError(429, "请求过于频繁");
  if (path === "/api/reports" && request.method === "POST") return ingest(request, env);
  const live = path.match(/^\/api\/live\/([a-f0-9]{64})$/);
  if (live && request.method === "GET") {
    const id = hex(await crypto.subtle.digest("SHA-256", unhex(live[1])));
    const headers = new Headers(request.headers);
    headers.set("X-Client-Key", live[1]);
    return env.CONNECTIONS.getByName(id).fetch(new Request(request, { headers }));
  }
  await admin(request, env);
  if (path === "/api/devices" && request.method === "GET") {
    const query = (url.searchParams.get("q") ?? "").slice(0, 256);
    const { results } = await env.DB.prepare(
      "SELECT * FROM devices WHERE instr(lower(label || ' ' || COALESCE(json_extract(payload, '$.client.hostname'), '') || ' ' || COALESCE(json_extract(payload, '$.client.username'), '') || ' ' || id), lower(?)) > 0 ORDER BY last_seen DESC LIMIT 100",
    )
      .bind(query)
      .all<Device>();
    return Response.json({
      receivedAt: new Date().toISOString(),
      devices: results.map(describe),
      limit: 100,
    });
  }
  const command = path.match(/^\/api\/devices\/([a-f0-9]{64})\/(request-report|live)$/);
  if (command) {
    const device = await env.DB.prepare("SELECT sequence FROM devices WHERE id = ?")
      .bind(command[1])
      .first<{ sequence: number }>();
    if (!device) throw new RequestError(404, "客户端不存在");
    const connection = env.CONNECTIONS.getByName(command[1]);
    if (command[2] === "request-report" && request.method === "POST")
      return Response.json({ ...(await connection.requestReport()), sequence: device.sequence });
    if (command[2] === "live" && request.method === "GET")
      return Response.json({ ...(await connection.state()), sequence: device.sequence });
    throw new RequestError(405, "请求方法无效");
  }
  const match = path.match(/^\/api\/devices\/([a-f0-9]{64})(\/trust)?$/);
  if (match && !match[2] && request.method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ?")
      .bind(match[1])
      .first<Device>();
    if (!row) throw new RequestError(404, "客户端不存在");
    const { results } = await env.DB.prepare(
      "SELECT received_at, payload FROM reports WHERE device_id = ? ORDER BY sequence DESC LIMIT 12",
    )
      .bind(match[1])
      .all<{ received_at: string; payload: string }>();
    return Response.json({
      device: describe(row),
      history: results.map((entry) => ({
        receivedAt: entry.received_at,
        report: JSON.parse(entry.payload),
      })),
    });
  }
  if (match?.[2] && request.method === "POST") {
    const value = parse(await body(request, 1024));
    if (
      !object(value) ||
      typeof value.trusted !== "boolean" ||
      typeof value.label !== "string" ||
      value.label.length > 100
    )
      throw new RequestError(400, "客户端设置无效");
    const result = await env.DB.prepare("UPDATE devices SET trusted = ?, label = ? WHERE id = ?")
      .bind(value.trusted ? 1 : 0, value.label, match[1])
      .run();
    if (!result.meta.changes) throw new RequestError(404, "客户端不存在");
    return Response.json({ saved: true });
  }
  throw new RequestError(404, "接口不存在");
}
export default {
  async fetch(request, env) {
    let response: Response;
    try {
      response = await route(request, env);
    } catch (error) {
      if (!(error instanceof RequestError))
        console.error(JSON.stringify({ event: "telemetry_request_failed", error: String(error) }));
      response = Response.json(
        { error: error instanceof RequestError ? error.message : "服务暂时不可用" },
        { status: error instanceof RequestError ? error.status : 500 },
      );
    }
    if (response.status === 101) return response;
    const secured = new Response(response.body, response);
    secured.headers.set("Cache-Control", "no-store");
    secured.headers.set("X-Content-Type-Options", "nosniff");
    secured.headers.set("Referrer-Policy", "no-referrer");
    secured.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return secured;
  },
  async scheduled(_event, env) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM reports WHERE received_at < ?").bind(
        new Date(Date.now() - 7 * 86400_000).toISOString(),
      ),
      env.DB.prepare("DELETE FROM devices WHERE trusted = 0 AND last_seen < ?").bind(
        new Date(Date.now() - 86400_000).toISOString(),
      ),
    ]);
  },
} satisfies ExportedHandler<Env>;
