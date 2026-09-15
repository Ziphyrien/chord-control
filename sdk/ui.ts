import type { Json } from "../shared/protocol.ts";

export async function callHost(method: string, input: Json = null): Promise<Json> {
  const response = await fetch(new URL("rpc", location.href), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, input }),
    credentials: "omit",
    signal: AbortSignal.timeout(30_000),
  });
  const reply = await response.json();
  if (!response.ok || !reply.ok) throw new Error(reply.message ?? "插件调用失败");
  return reply.result;
}
