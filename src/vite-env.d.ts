/// <reference types="vite/client" />

/** Distribution values are provided by the bundler; no native globals leak into application state. */
declare global {
  const __CHORD_CONTROL_REPOSITORY__: string;
  const __CHORD_CONTROL_CATALOG_PUBLIC_KEY__: string;
}
export {};
