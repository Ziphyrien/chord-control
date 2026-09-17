import project from "../package.json" with { type: "json" };

/** Build metadata is read from one version source by both controller and publisher. */
export const HOST_VERSION: string = project.version;
export const CHORD_VERSION: string = project.dependencies["@earendil-works/chord"];
