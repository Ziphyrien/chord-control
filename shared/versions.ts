import project from "../package.json" with { type: "json" };
export const HOST_VERSION = project.version;
export const CHORD_VERSION = project.dependencies["@earendil-works/chord"];
