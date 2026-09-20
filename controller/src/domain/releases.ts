import type { PluginManifest } from "../../../shared/protocol.ts";
import { assertManifest, compareVersion } from "../../../shared/plugin-format.ts";
import { verifySigned } from "../../../shared/signing.ts";
import { HOST_VERSION, CHORD_VERSION, compatibleChordVersion } from "../../../shared/versions.ts";
import { isIgnored, type Configuration, type Registration } from "./configuration.ts";

export function verifyRelease(
  manifest: PluginManifest,
  key: string,
  allowUnsigned: boolean,
  compatible = true,
): void {
  assertManifest(manifest);
  verifySigned(manifest, key, allowUnsigned);
  if (!compatible) return;
  if (completed(manifest)) throw new Error("一次性插件已完成，无需再次安装");
  if (manifest.minHostVersion && compareVersion(HOST_VERSION, manifest.minHostVersion) < 0)
    throw new Error(`请将主程序更新至 ${manifest.minHostVersion} 或更高版本`);
  if (manifest.chordVersion && !compatibleChordVersion(manifest.chordVersion))
    throw new Error(
      `插件与当前主程序不兼容（Chord 要求 ${manifest.chordVersion} / 当前 ${CHORD_VERSION}）`,
    );
}
export function completed(manifest: PluginManifest): boolean {
  return Boolean(
    manifest.retireAfterHostVersion &&
    compareVersion(HOST_VERSION, manifest.retireAfterHostVersion) >= 0,
  );
}
export function automaticCandidates(config: Configuration): Registration[] {
  if (!config.settings.autoUpdate) return [];
  return config.plugins.filter(
    (plugin) => plugin.enabled && !isIgnored(config, plugin) && hasUpdate(plugin),
  );
}
export function hasUpdate(registration: Registration): boolean {
  const { available, installed } = registration;
  return Boolean(
    available &&
    !completed(available) &&
    registration.sourceStatus === "available" &&
    (!installed ||
      (compareVersion(available.version, installed.version) >= 0 &&
        available.artifactSha256 !== installed.artifactSha256)),
  );
}
