declare const __CHORD_CONTROL_REPOSITORY__: string;
declare const __CHORD_CONTROL_CATALOG_PUBLIC_KEY__: string;

const testing = typeof process !== "undefined" && process.env?.CHORD_CONTROL_TEST === "1";
const repository =
  !testing && typeof __CHORD_CONTROL_REPOSITORY__ !== "undefined"
    ? __CHORD_CONTROL_REPOSITORY__
    : "";
export const defaultCatalogUrl = repository
  ? `https://github.com/${repository}/releases/download/plugin-channel/catalog.json`
  : "";
export const defaultCatalogPublicKey =
  !testing && typeof __CHORD_CONTROL_CATALOG_PUBLIC_KEY__ !== "undefined"
    ? __CHORD_CONTROL_CATALOG_PUBLIC_KEY__
    : "";
