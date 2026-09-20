import project from "../package.json" with { type: "json" };

/** Build metadata is read from one version source by both controller and publisher. */
export const HOST_VERSION: string = project.version;
export const CHORD_VERSION: string = project.dependencies["@earendil-works/chord"];
/** New bundles require the first host shipping this runtime, regardless of plugin API minimum. */
export const CHORD_MIN_HOST_VERSION = "0.4.6";
/** 0.86.1 and 0.85.1 publish identical runtime/loader code; only Delta internals changed.
 * Keep this compatibility exception tied to the audited upgrade, never assume 0.x compatibility.
 */
export function compatibleChordVersion(version: string): boolean {
  return version === CHORD_VERSION || (CHORD_VERSION === "0.86.1" && version === "0.85.1");
}
