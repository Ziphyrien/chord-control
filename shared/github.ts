export interface DownloadSource {
  id: string;
  url: string;
}
import mirrors from "./github-mirrors.json" with { type: "json" };

/** Only public GitHub release/raw routes are sent to mirror operators. Trust is still signature based. */
export function githubSources(address: string): DownloadSource[] {
  const direct = { id: "direct", url: address },
    url = new URL(address);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port
  )
    return [direct];
  const release =
    url.hostname === "github.com" &&
    /^\/[^/]+\/[^/]+\/releases\/(?:download\/[^/]+|latest\/download)\/[^/]+$/.test(url.pathname);
  const raw =
    url.hostname === "raw.githubusercontent.com" && /^\/[^/]+\/[^/]+\/.+/.test(url.pathname);
  if (!release && !raw) return [direct];
  return [
    direct,
    ...mirrors.map((prefix) => ({ id: new URL(prefix).hostname, url: prefix + address })),
  ];
}
