export interface DownloadSource {
  id: string;
  url: string;
}

// Public release/raw downloads only. Each address is verified against its operator's usage page.
const GITHUB_PROXIES = [
  "https://ghfast.top/",
  "https://gh-proxy.com/",
  "https://ghproxy.net/",
] as const;
export function githubSources(address: string): DownloadSource[] {
  const url = new URL(address);
  const direct = { id: "direct", url: address };
  const eligible =
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    !url.port &&
    ((url.hostname === "github.com" &&
      /^\/[^/]+\/[^/]+\/releases\/(download\/[^/]+|latest\/download)\/.+/.test(url.pathname)) ||
      (url.hostname === "raw.githubusercontent.com" && /^\/[^/]+\/[^/]+\/.+/.test(url.pathname)));
  return eligible
    ? [
        direct,
        ...GITHUB_PROXIES.map((prefix) => ({
          id: new URL(prefix).hostname,
          url: prefix + address,
        })),
      ]
    : [direct];
}
