export function parseRepositorySlug(value: unknown): string | undefined;
export function currentRepositorySlug(cwd?: string): string | undefined;
export function catalogPublicKey(cwd?: string): string;
export function distributionFor(repository: string | undefined):
  | {
      repository: string;
      pluginCatalogUrl: string;
      pluginReleaseBaseUrl: string;
      appReleaseUrl: string;
    }
  | undefined;
