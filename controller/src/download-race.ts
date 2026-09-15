import { assertUrl } from "../../shared/plugin-format.ts";
import type { DownloadSource } from "./github-sources.ts";

type Fetcher = typeof fetch;
export interface DownloadOptions<T> {
  maxBytes: number;
  probeBytes: number;
  etag?: string;
  cached?: T;
  decode(bytes: Uint8Array): T;
  prefix?(bytes: Uint8Array): void;
  fetcher?: Fetcher;
  probeTimeoutMs?: number;
  timeoutMs?: number;
}
interface Candidate<T> {
  source: DownloadSource;
  ready: Promise<void>;
  finish(): Promise<{ value: T; etag?: string; source: string }>;
  cancel(): void;
}
function cachedTag(token: string | undefined, source: string): string | undefined {
  if (!token) return;
  if (!token.startsWith("route:")) return source === "direct" ? token : undefined;
  try {
    const entry = JSON.parse(Buffer.from(token.slice(6), "base64url").toString());
    return entry.source === source && typeof entry.etag === "string" ? entry.etag : undefined;
  } catch {
    return;
  }
}
function encodeTag(source: string, etag: string | null): string | undefined {
  return etag
    ? `route:${Buffer.from(JSON.stringify({ source, etag })).toString("base64url")}`
    : undefined;
}
function openCandidate<T>(source: DownloadSource, options: DownloadOptions<T>): Candidate<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("下载超时")),
    options.timeoutMs ?? 60000,
  );
  const probeTimeout = setTimeout(
    () => controller.abort(new Error("来源测速超时")),
    options.probeTimeoutMs ?? 10000,
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let size = 0;
  const chunks: Uint8Array[] = [];
  let finished = false;
  let decoded: { value: T } | undefined;
  let etag: string | undefined;
  function cancel(): void {
    clearTimeout(timeout);
    clearTimeout(probeTimeout);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
  async function next(): Promise<void> {
    const result = await reader!.read();
    if (result.done) {
      finished = true;
      return;
    }
    size += result.value.byteLength;
    if (size > options.maxBytes) throw new Error("下载超过大小限制");
    chunks.push(result.value);
  }
  const ready = (async () => {
    assertUrl(source.url);
    const tag = options.cached === undefined ? undefined : cachedTag(options.etag, source.id);
    const headers: Record<string, string> = {
      "user-agent": "chord-control",
      accept: "application/json,application/octet-stream",
      "cache-control": "no-cache",
    };
    if (tag) headers["if-none-match"] = tag;
    const response = await (options.fetcher ?? fetch)(source.url, {
      headers,
      signal: controller.signal,
      credentials: "omit",
    });
    if (response.url) assertUrl(response.url);
    if (response.status === 304 && tag && options.cached !== undefined) {
      decoded = { value: options.cached };
      finished = true;
      etag = options.etag;
      void response.body?.cancel();
    } else {
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      if (/text\/html/i.test(response.headers.get("content-type") ?? "")) {
        void response.body?.cancel();
        throw new Error("来源返回了网页而非插件文件");
      }
      if (Number(response.headers.get("content-length")) > options.maxBytes) {
        void response.body?.cancel();
        throw new Error("下载超过大小限制");
      }
      if (!response.body) throw new Error("下载内容为空");
      reader = response.body.getReader();
      etag = encodeTag(source.id, response.headers.get("etag"));
      while (!finished && size < options.probeBytes) await next();
      const prefix = Buffer.concat(chunks);
      if (finished) decoded = { value: options.decode(prefix) };
      else options.prefix?.(prefix);
    }
    clearTimeout(probeTimeout);
  })().catch((error) => {
    cancel();
    throw error;
  });
  return {
    source,
    ready,
    cancel,
    async finish() {
      try {
        await ready;
        while (!finished) await next();
        return {
          value: decoded ? decoded.value : options.decode(Buffer.concat(chunks)),
          etag,
          source: source.id,
        };
      } finally {
        cancel();
      }
    },
  };
}

/** Race real content, retain the winning stream, and close all losing transfers. */
export async function downloadFromSources<T>(
  sources: DownloadSource[],
  options: DownloadOptions<T>,
): Promise<{ value: T; etag?: string; source: string }> {
  const remaining = new Set(sources);
  const failures: string[] = [];
  while (remaining.size) {
    const candidates = [...remaining].map((source) => openCandidate(source, options));
    let winner: Candidate<T> | undefined;
    try {
      winner = await Promise.any(
        candidates.map(async (candidate) => {
          await candidate.ready;
          return candidate;
        }),
      );
      for (const candidate of candidates) if (candidate !== winner) candidate.cancel();
      try {
        return await winner.finish();
      } catch (error) {
        failures.push(
          `${winner.source.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        remaining.delete(winner.source);
      }
    } catch (error) {
      if (error instanceof AggregateError)
        failures.push(
          ...error.errors.map((reason) =>
            reason instanceof Error ? reason.message : String(reason),
          ),
        );
      else failures.push(String(error));
      break;
    } finally {
      for (const candidate of candidates) candidate.cancel();
    }
  }
  throw new Error(`下载失败: ${failures.join("；") || "没有可用来源"}`);
}
