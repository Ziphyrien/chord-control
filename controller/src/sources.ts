import type { PluginManifest } from "../../shared/protocol.ts";
import { assertUrl } from "../../shared/plugin-format.ts";
import { verifyHash } from "./artifacts.ts";
import { githubSources } from "./github-sources.ts";
import { downloadFromSources } from "./download-race.ts";

export interface JsonRequest<T> {
  etag?: string;
  cached?: T;
  validate(value: unknown): T;
}
export async function fetchJson<T>(
  url: string,
  options: JsonRequest<T>,
): Promise<{ value: T; etag?: string }> {
  assertUrl(url);
  // A metadata source is eligible only after its entire signed document validates.
  let cached: T | undefined;
  try {
    if (options.cached !== undefined) cached = options.validate(options.cached);
  } catch {
    /* Fetch fresh metadata if a legacy cache fails current validation. */
  }
  return downloadFromSources(githubSources(url), {
    maxBytes: 2 * 1024 * 1024,
    probeBytes: 2 * 1024 * 1024,
    etag: options.etag,
    cached,
    decode(bytes) {
      return options.validate(JSON.parse(Buffer.from(bytes).toString("utf8")));
    },
  });
}
export async function download(manifest: PluginManifest): Promise<Uint8Array> {
  const result = await downloadFromSources(githubSources(manifest.artifactUrl), {
    maxBytes: 100 * 1024 * 1024,
    probeBytes: 64 * 1024,
    prefix(bytes) {
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("来源未返回 ZIP 文件");
    },
    decode(bytes) {
      verifyHash(manifest, bytes);
      return bytes;
    },
  });
  return result.value;
}
