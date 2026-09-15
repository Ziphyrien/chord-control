import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
const exec = promisify(execFile);
const tag = process.env.PLUGIN_RELEASE_TAG;
const repo = process.env.GH_REPO;
if (!tag || !/^plugins-[a-zA-Z0-9-]+$/.test(tag) || !repo)
  throw new Error("PLUGIN_RELEASE_TAG and GH_REPO are required");
const directory = "release/plugins";
const files = (await readdir(directory))
  .filter((name) => name.endsWith(".zip") || (name.endsWith(".json") && name !== "catalog.json"))
  .map((name) => join(directory, name));
// Only after immutable artifacts are visible do clients receive a new catalogue.
await exec("gh", [
  "release",
  "create",
  tag,
  "--repo",
  repo,
  "--title",
  `Plugins ${tag}`,
  "--notes",
  "Compiled and signed Chord plugins.",
  "--latest=false",
  ...files,
]);
try {
  await exec("gh", ["release", "view", "plugin-channel", "--repo", repo]);
} catch {
  await exec("gh", [
    "release",
    "create",
    "plugin-channel",
    "--repo",
    repo,
    "--title",
    "Plugin update channel",
    "--notes",
    "Signed catalogue for Chord Control. Configure this release's catalog.json URL and an independently obtained publisher public key.",
    "--latest=false",
  ]);
}
await exec("gh", [
  "release",
  "upload",
  "plugin-channel",
  join(directory, "catalog.json"),
  join(directory, "publisher-public.pem"),
  "--clobber",
  "--repo",
  repo,
]);
console.log(`Published https://github.com/${repo}/releases/download/plugin-channel/catalog.json`);
