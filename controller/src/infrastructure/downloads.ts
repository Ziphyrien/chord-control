import { assertUrl } from "../../../shared/plugin-format.ts";
import { message, object } from "../../../shared/validation.ts";
import type { DownloadSource } from "./github.ts";

export interface DownloadOptions<T> {
  maxBytes: number;
  probeBytes: number;
  etag?: string;
  cached?: T;
  decode(bytes: Uint8Array): T;
  prefix?(bytes: Uint8Array): void;
  fetcher?: typeof fetch;
  probeTimeoutMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
interface DownloadResult<T> {
  value: T;
  etag?: string;
  source: string;
}
interface Transfer<T> {
  source: DownloadSource;
  ready: Promise<void>;
  finish(): Promise<DownloadResult<T>>;
  close(): void;
}
function routeTag(encoded: string | undefined, source: string): string | undefined {
  if (!encoded) return;
  if (!encoded.startsWith("route:")) return source === "direct" ? encoded : undefined;
  try {
    const tag: unknown = JSON.parse(Buffer.from(encoded.slice(6), "base64url").toString("utf8"));
    if (object(tag) && tag.source === source && typeof tag.etag === "string") return tag.etag;
  } catch {
    return;
  }
}
function encodeTag(source: string, etag: string | null): string | undefined {
  return etag
    ? `route:${Buffer.from(JSON.stringify({ source, etag })).toString("base64url")}`
    : undefined;
}
function transfer<T>(source: DownloadSource, options: DownloadOptions<T>): Transfer<T> {
  const cancel = new AbortController();
  const signal = options.signal ? AbortSignal.any([cancel.signal, options.signal]) : cancel.signal;
  const total = setTimeout(() => cancel.abort(new Error("下载超时")), options.timeoutMs ?? 60_000);
  const probe = setTimeout(
    () => cancel.abort(new Error("来源测速超时")),
    options.probeTimeoutMs ?? 10_000,
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0,
    done = false,
    etag: string | undefined,
    decoded: { value: T } | undefined;
  const close = () => {
    clearTimeout(total);
    clearTimeout(probe);
    cancel.abort();
    void reader?.cancel().catch(() => undefined);
  };
  async function read(): Promise<void> {
    signal.throwIfAborted();
    const chunk = await reader!.read();
    done = chunk.done;
    if (!chunk.done) {
      bytes += chunk.value.byteLength;
      if (bytes > options.maxBytes) throw new Error("下载超过大小限制");
      chunks.push(chunk.value);
    }
  }
  const ready = (async () => {
    assertUrl(source.url);
    signal.throwIfAborted();
    const tag = options.cached === undefined ? undefined : routeTag(options.etag, source.id);
    const headers: Record<string, string> = {
      "user-agent": "chord-control",
      accept: "application/json,application/octet-stream",
      "cache-control": "no-cache",
    };
    if (tag) headers["if-none-match"] = tag;
    const response = await (options.fetcher ?? fetch)(source.url, {
      headers,
      signal,
      credentials: "omit",
    });
    if (response.url) assertUrl(response.url);
    if (response.status === 304 && tag && options.cached !== undefined) {
      await response.body?.cancel();
      done = true;
      decoded = { value: options.cached };
      etag = options.etag;
    } else {
      if (
        response.status !== 200 ||
        /text\/html/i.test(response.headers.get("content-type") ?? "") ||
        Number(response.headers.get("content-length")) > options.maxBytes ||
        !response.body
      ) {
        await response.body?.cancel();
        throw new Error(`来源返回无效文件 (HTTP ${response.status})`);
      }
      reader = response.body.getReader();
      etag = encodeTag(source.id, response.headers.get("etag"));
      while (!done && bytes < options.probeBytes) await read();
      const prefix = Buffer.concat(chunks);
      if (done) decoded = { value: options.decode(prefix) };
      else options.prefix?.(prefix);
    }
    clearTimeout(probe);
  })().catch((error) => {
    close();
    throw error;
  });
  return {
    source,
    ready,
    close,
    async finish() {
      try {
        await ready;
        while (!done) await read();
        signal.throwIfAborted();
        return {
          value: decoded ? decoded.value : options.decode(Buffer.concat(chunks)),
          etag,
          source: source.id,
        };
      } finally {
        close();
      }
    },
  };
}
/** Race useful content, retain the winner's stream, retry remaining routes on failed verification. */
export async function downloadFromSources<T>(
  routes: DownloadSource[],
  options: DownloadOptions<T>,
): Promise<DownloadResult<T>> {
  const remaining = new Map(routes.map((route) => [route.id, route]));
  const failures: string[] = [];
  while (remaining.size) {
    options.signal?.throwIfAborted();
    const candidates = [...remaining.values()].map((route) => transfer(route, options));
    try {
      const winner = await Promise.any(
        candidates.map(async (candidate) => {
          await candidate.ready;
          return candidate;
        }),
      );
      for (const candidate of candidates) if (candidate !== winner) candidate.close();
      try {
        return await winner.finish();
      } catch (error) {
        remaining.delete(winner.source.id);
        failures.push(`${winner.source.id}: ${message(error)}`);
      }
    } catch (error) {
      if (error instanceof AggregateError) failures.push(...error.errors.map(message));
      else failures.push(message(error));
      break;
    } finally {
      for (const candidate of candidates) candidate.close();
    }
  }
  options.signal?.throwIfAborted();
  throw new Error(`下载失败: ${failures.join("；") || "没有可用来源"}`);
}
