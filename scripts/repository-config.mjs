import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { repositoryRoot } from "./release-files.mjs";

const segment = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
export function parseRepositorySlug(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const candidate = value.trim().replace(/\.git\/?$/, "");
  let path = candidate;
  if (!/^[^/:]+\/[^/]+$/.test(candidate) || candidate.startsWith("github.com/")) {
    const scp = candidate.match(/^git@github\.com:(.+)$/i);
    if (scp) path = scp[1];
    else {
      let url;
      try {
        url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
      } catch {
        return undefined;
      }
      if (
        url.hostname.toLowerCase() !== "github.com" ||
        !["https:", "ssh:"].includes(url.protocol) ||
        url.password ||
        url.search ||
        url.hash ||
        url.port
      )
        return undefined;
      if (url.username && !(url.protocol === "ssh:" && url.username === "git")) return undefined;
      path = url.pathname.replace(/^\//, "");
    }
  }
  const parts = path.split("/");
  return parts.length === 2 && parts.every((part) => segment.test(part))
    ? parts.join("/")
    : undefined;
}

export function currentRepositorySlug(cwd = repositoryRoot) {
  for (const name of ["CHORD_CONTROL_REPOSITORY", "GITHUB_REPOSITORY", "GH_REPO"]) {
    const value = process.env[name];
    if (value === undefined || value === "") continue;
    const slug = parseRepositorySlug(value);
    if (!slug) throw new Error(`Invalid ${name}; expected a GitHub owner/repository`);
    return slug;
  }
  try {
    return parseRepositorySlug(
      execFileSync("git", ["config", "--get", "remote.origin.url"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }),
    );
  } catch {
    return undefined;
  }
}

export function catalogPublicKey(cwd = repositoryRoot) {
  const override = process.env.PLUGIN_SIGNING_PUBLIC_KEY?.trim();
  if (override) return override;
  try {
    return readFileSync(resolve(cwd, "config/plugin-public.pem"), "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

export function distributionFor(repository) {
  if (!repository) return undefined;
  const slug = parseRepositorySlug(repository);
  if (!slug) throw new Error("Invalid distribution repository");
  const releases = `https://github.com/${slug}/releases`;
  return {
    repository: slug,
    pluginCatalogUrl: `${releases}/download/plugin-channel/catalog.json`,
    pluginReleaseBaseUrl: `${releases}/download/PLUGIN_RELEASE_TAG`,
    appReleaseUrl: `${releases}/latest/download/Chord.Control-setup.exe`,
  };
}
