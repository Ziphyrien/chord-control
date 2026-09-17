/** Build-time repository identity; explicit invalid environment values throw. */
export function parseRepositorySlug(value: unknown): string | undefined;
export function currentRepositorySlug(cwd?: string): string | undefined;
export function catalogPublicKey(cwd?: string): string;
export interface Distribution {
  repository: string;
  pluginCatalogUrl: string;
  pluginReleaseBaseUrl: string;
  appReleaseUrl: string;
}
export function distributionFor(repository: string | undefined): Distribution | undefined;
