import type { Json } from "../shared/protocol.ts";
import { jsonValue, object } from "../shared/validation.ts";

/** A per-generation opaque URL is the only bridge available to plugin web content. */
export async function callHost(method: string, input: Json = null): Promise<Json> {
  if (!method || method.length > 100) throw new Error("插件方法无效");
  const response = await fetch(new URL("rpc", location.href), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    cache: "no-store",
    body: JSON.stringify({ method, input }),
    signal: AbortSignal.timeout(30_000),
  });
  const reply: unknown = await response.json();
  if (!object(reply) || reply.ok !== true || !response.ok)
    throw new Error(
      object(reply) && typeof reply.message === "string" ? reply.message : "插件调用失败",
    );
  if (!jsonValue(reply.result)) throw new Error("插件返回值格式错误");
  return reply.result;
}
