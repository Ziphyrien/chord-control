declare const __CHORD_CONTROL_REPOSITORY__: string;
declare const __CHORD_CONTROL_CATALOG_PUBLIC_KEY__: string;

const inTestHarness = typeof process !== "undefined" && process.env?.CHORD_CONTROL_TEST === "1";
const distributionRepository = inTestHarness ? "" : __CHORD_CONTROL_REPOSITORY__;
export const defaultCatalogUrl = distributionRepository
  ? `https://github.com/${distributionRepository}/releases/download/plugin-channel/catalog.json`
  : "";
export const defaultCatalogPublicKey = inTestHarness ? "" : __CHORD_CONTROL_CATALOG_PUBLIC_KEY__;
