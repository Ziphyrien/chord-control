import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function parseRepositorySlug(value) {
  if (typeof value !== "string") return;
  const candidate = value.trim().replace(/\.git\/?$/, "");
  if (!candidate) return;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)) return candidate;
  const scp = !candidate.includes("://") && candidate.match(/^(?:[^@/]+@)?([^:]+):(.+)$/);
  const parsed = scp
    ? { hostname: scp[1], pathname: `/${scp[2]}` }
    : (() => {
        try {
          return new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
        } catch {
          return;
        }
      })();
  if (!parsed || parsed.hostname.toLowerCase() !== "github.com") return;
  const parts = parsed.pathname.split("/").filter(Boolean);
  return parts.length === 2 &&
    /^[A-Za-z0-9_.-]+$/.test(parts[0]) &&
    /^[A-Za-z0-9_.-]+$/.test(parts[1])
    ? parts.join("/")
    : undefined;
}
export function currentRepositorySlug(cwd = process.cwd()) {
  for (const value of [
    process.env.CHORD_CONTROL_REPOSITORY,
    process.env.GITHUB_REPOSITORY,
    process.env.GH_REPO,
  ]) {
    const parsed = parseRepositorySlug(value);
    if (parsed) return parsed;
  }
  try {
    return parseRepositorySlug(
      execFileSync("git", ["config", "--get", "remote.origin.url"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return;
  }
}
export function catalogPublicKey(cwd = process.cwd()) {
  const fromEnv = process.env.PLUGIN_SIGNING_PUBLIC_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(resolve(cwd, "config/plugin-public.pem"), "utf8").trim();
  } catch {
    return "";
  }
}
export function distributionFor(repository) {
  if (!repository) return;
  return {
    repository,
    pluginCatalogUrl: `https://github.com/${repository}/releases/download/plugin-channel/catalog.json`,
    pluginReleaseBaseUrl: `https://github.com/${repository}/releases/download/PLUGIN_RELEASE_TAG`,
    appReleaseUrl: `https://github.com/${repository}/releases/latest/download/Chord.Control-setup.exe`,
  };
}
