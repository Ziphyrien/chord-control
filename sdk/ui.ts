import type { Json } from "../shared/protocol.ts";
import { jsonValue, object } from "../shared/validation.ts";

export type PluginCall = (method: string, input?: Json, signal?: AbortSignal) => Promise<Json>;

/** HTTP adapter for the plugin's Chord PluginUi service, scoped to one signed generation. */
export function createPluginCall({
  endpoint,
  signal: lifetime,
  request = fetch,
}: {
  endpoint: URL;
  signal?: AbortSignal;
  request?: typeof fetch;
}): PluginCall {
  return async (method, input = null, signal) => {
    if (!method || method.length > 100 || !jsonValue(input)) throw new Error("请求格式有误");
    const cancellation = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...[lifetime, signal].filter((item): item is AbortSignal => !!item),
    ]);
    cancellation.throwIfAborted();
    const response = await request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify({ method, input }),
      signal: cancellation,
    });
    if (response.status === 404 || response.status === 410)
      throw new Error("页面已失效，请重新打开");
    let reply: unknown;
    try {
      reply = await response.json();
    } catch {
      cancellation.throwIfAborted();
      throw new Error(
        response.ok ? "收到的数据格式有误，请重新打开" : "页面连接暂时不可用，请稍后重试",
      );
    }
    cancellation.throwIfAborted();
    if (!object(reply) || reply.ok !== true || !response.ok)
      throw new Error(
        object(reply) && typeof reply.message === "string" ? reply.message : "操作未完成，请重试",
      );
    if (!jsonValue(reply.result)) throw new Error("收到的数据格式有误，请重试");
    return reply.result;
  };
}
