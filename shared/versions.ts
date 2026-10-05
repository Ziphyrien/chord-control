import project from "../package.json" with { type: "json" };

/** Build metadata is read from one version source by both controller and publisher. */
export const HOST_VERSION: string = project.version;
export const CHORD_VERSION: string = project.dependencies["@earendil-works/chord"];
/** Chord 1.0.2 bundles require the first host shipping this runtime. */
export const CHORD_MIN_HOST_VERSION = "0.4.10";
export function compatibleChordVersion(version: string): boolean {
  return version === CHORD_VERSION;
}
