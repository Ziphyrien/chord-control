import { join } from "node:path";
import { normalizePublicKey } from "../shared/signing.ts";
import { catalogPublicKey, currentRepositorySlug } from "./repository-config.mjs";
import { githubClient, promoteCatalog, publishRelease } from "./github-release.mjs";
import { isMain, repositoryRoot, withDirectoryLock } from "./release-files.mjs";
import { validatePluginRelease } from "./plugin-artifacts.mjs";

export async function publishPlugins({
  directory = join(repositoryRoot, "release/plugins"),
  tag,
  repository,
  publicKey,
  target,
  client,
}) {
  if (!/^plugins-[a-zA-Z0-9-]+$/.test(tag ?? ""))
    throw new Error("An immutable plugins-* release tag is required");
  if (!/^[a-f0-9]{40}$/.test(target ?? "")) throw new Error("A full source commit is required");
  return withDirectoryLock(directory, async () => {
    const key = normalizePublicKey(publicKey);
    const baseUrl = `https://github.com/${repository}/releases/download/${tag}`;
    const { catalog, assets } = await validatePluginRelease(directory, { publicKey: key, baseUrl });
    if (!catalog.plugins.length) throw new Error("Refusing to publish an empty channel");
    await publishRelease(client, {
      tag,
      target,
      title: `Plugins ${tag}`,
      notes: `Signed plugin artifacts from ${target}.`,
      assets,
    });
    if (client.branchHead && (await client.branchHead("main")) !== target)
      throw new Error("Source is no longer main HEAD; artifacts published, channel left unchanged");
    await promoteCatalog(client, { bytes: assets.get("catalog.json"), publicKey: key, target });
    return catalog;
  });
}

if (isMain(import.meta.url)) {
  const repository = currentRepositorySlug();
  const client = githubClient({ repository, token: process.env.GH_TOKEN });
  await publishPlugins({
    tag: process.env.PLUGIN_RELEASE_TAG,
    repository,
    publicKey: catalogPublicKey(),
    target: process.env.GITHUB_SHA,
    client,
  });
  console.log(
    `Published https://github.com/${repository}/releases/download/plugin-channel/catalog.json`,
  );
}
