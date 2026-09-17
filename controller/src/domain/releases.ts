import type { PluginManifest } from "../../../shared/protocol.ts";
import { assertManifest, compareVersion } from "../../../shared/plugin-format.ts";
import { verifySigned } from "../../../shared/signing.ts";
import { HOST_VERSION, CHORD_VERSION } from "../../../shared/versions.ts";
import type { Registration } from "./configuration.ts";

export function verifyRelease(
  manifest: PluginManifest,
  key: string,
  allowUnsigned: boolean,
  compatible = true,
): void {
  assertManifest(manifest);
  verifySigned(manifest, key, allowUnsigned);
  if (!compatible) return;
  if (manifest.minHostVersion && compareVersion(HOST_VERSION, manifest.minHostVersion) < 0)
    throw new Error(`需要宿主版本 ${manifest.minHostVersion}`);
  if (manifest.chordVersion && manifest.chordVersion !== CHORD_VERSION)
    throw new Error(`需要 Chord ${manifest.chordVersion}，当前为 ${CHORD_VERSION}`);
}
export function hasUpdate(registration: Registration): boolean {
  const { available, installed } = registration;
  return Boolean(
    available &&
    registration.sourceStatus === "available" &&
    (!installed ||
      (compareVersion(available.version, installed.version) >= 0 &&
        available.artifactSha256 !== installed.artifactSha256)),
  );
}
