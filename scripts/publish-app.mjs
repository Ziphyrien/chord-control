import { compareVersion } from "../shared/plugin-format.ts";
import { currentRepositorySlug } from "./repository-config.mjs";
import { githubClient, publishRelease } from "./github-release.mjs";
import { prepareAppRelease } from "./prepare-app-release.mjs";
import { isMain, repositoryRoot, withDirectoryLock } from "./release-files.mjs";
import { join } from "node:path";

export async function publishApp({
  root = repositoryRoot,
  repository = currentRepositorySlug(root),
  target = process.env.GITHUB_SHA,
  refType = process.env.GITHUB_REF_TYPE,
  refName = process.env.GITHUB_REF_NAME,
  client,
} = {}) {
  if (!/^[a-f0-9]{40}$/.test(target ?? "")) throw new Error("A full source commit is required");
  if (refType !== "tag") throw new Error("Application publication requires an app-v* tag");
  return withDirectoryLock(join(root, "release/app-publication"), async () => {
    const { tag, notes, assets } = await prepareAppRelease({ root, repository, refType, refName });
    const previous = await client.latestRelease();
    const previousVersion = previous?.tag_name?.match(/^app-v(\d+\.\d+\.\d+)$/)?.[1];
    if (previousVersion && compareVersion(previousVersion, tag.slice(5)) > 0)
      throw new Error("Refusing to replace latest with an older application version");
    return publishRelease(client, {
      tag,
      title: `Chord Control ${tag.slice(5)}`,
      notes,
      target,
      assets,
      latest: true,
    });
  });
}

if (isMain(import.meta.url)) {
  const repository = currentRepositorySlug();
  await publishApp({
    repository,
    client: githubClient({ repository, token: process.env.GH_TOKEN }),
  });
  console.log("Published the complete signed Windows release as latest");
}
