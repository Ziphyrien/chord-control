import type { PluginManifest } from "../../shared/protocol.ts";
import { assertManifest, compareVersion } from "../../shared/plugin-format.ts";
import { verifySigned } from "../../shared/signing.ts";
import { HOST_VERSION, CHORD_VERSION } from "../../shared/versions.ts";

export const ALLOW_UNSIGNED = process.env.CHORD_CONTROL_ALLOW_UNSIGNED === "1";
export function verifyManifest(
  manifest: PluginManifest,
  publicKey: string,
  requireCompatible = true,
): void {
  assertManifest(manifest);
  verifySigned(manifest, publicKey, ALLOW_UNSIGNED);
  if (!requireCompatible) return;
  if (manifest.minHostVersion && compareVersion(HOST_VERSION, manifest.minHostVersion) < 0)
    throw new Error(`需要宿主版本 ${manifest.minHostVersion}`);
  if (manifest.chordVersion && manifest.chordVersion !== CHORD_VERSION)
    throw new Error(`需要 Chord ${manifest.chordVersion}，当前为 ${CHORD_VERSION}`);
}
