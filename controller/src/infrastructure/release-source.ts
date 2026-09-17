import type { PluginManifest, PluginCatalog } from "../../../shared/protocol.ts";
import { assertCatalog, compareVersion } from "../../../shared/plugin-format.ts";
import { verifySigned } from "../../../shared/signing.ts";
import { verifyRelease } from "../domain/releases.ts";
import type { PluginSource } from "../domain/configuration.ts";
import type { ReleaseSource } from "../domain/ports.ts";
import { verifyHash } from "./archives.ts";
import { githubSources } from "../../../shared/github.ts";
import { downloadFromSources } from "../../../shared/downloads.ts";

export class SignedReleaseSource implements ReleaseSource {
  private readonly lifetime = new AbortController();
  private readonly unsigned: boolean;
  constructor(allowUnsigned = false) {
    this.unsigned = allowUnsigned;
  }
  private json<T>(
    source: PluginSource,
    decode: (value: unknown) => T,
    etag?: string,
    cached?: T,
    continues?: (next: T, previous: T) => void,
  ) {
    let trusted: T | undefined;
    try {
      if (cached !== undefined) trusted = decode(cached);
    } catch {
      trusted = undefined;
    }
    return downloadFromSources(githubSources(source.url), {
      maxBytes: 2 * 1024 * 1024,
      probeBytes: 2 * 1024 * 1024,
      etag,
      cached: trusted,
      signal: this.lifetime.signal,
      decode: (bytes) => {
        const next = decode(JSON.parse(Buffer.from(bytes).toString("utf8")));
        if (trusted !== undefined) continues?.(next, trusted);
        return next;
      },
    });
  }
  manifest(source: PluginSource, etag?: string, cached?: PluginManifest) {
    return this.json(
      source,
      (value): PluginManifest => {
        const release = value as PluginManifest;
        verifyRelease(release, source.publicKey, this.unsigned, false);
        return release;
      },
      etag,
      cached,
      (release, previous) => {
        if (release.id !== previous.id || compareVersion(release.version, previous.version) < 0)
          throw new Error("来源身份变化或版本回退");
      },
    );
  }
  catalog(source: PluginSource, etag?: string, cached?: PluginCatalog) {
    return this.json(
      source,
      (value): PluginCatalog => {
        assertCatalog(value);
        verifySigned(value, source.publicKey, this.unsigned);
        for (const release of value.plugins)
          verifyRelease(release, source.publicKey, this.unsigned, false);
        return value;
      },
      etag,
      cached,
      (value, previous) => {
        if (
          previous.generatedAt &&
          (!value.generatedAt || Date.parse(value.generatedAt) < Date.parse(previous.generatedAt))
        )
          throw new Error("来源返回了较旧的插件目录");
      },
    );
  }
  async archive(manifest: PluginManifest): Promise<Uint8Array> {
    const result = await downloadFromSources(githubSources(manifest.artifactUrl), {
      maxBytes: 100 * 1024 * 1024,
      probeBytes: 64 * 1024,
      signal: this.lifetime.signal,
      prefix: (bytes) => {
        if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("来源未返回 ZIP 文件");
      },
      decode: (bytes) => {
        verifyHash(manifest, bytes);
        return bytes;
      },
    });
    return result.value;
  }
  close(): void {
    this.lifetime.abort(new Error("控制器正在关闭"));
  }
}
