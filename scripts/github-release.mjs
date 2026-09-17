import { setTimeout as delay } from "node:timers/promises";
import { parseRepositorySlug } from "./repository-config.mjs";
import { sha256 } from "./release-files.mjs";

/** Small REST client: bounded retries, explicit 404 handling, no shell or secret logging. */
export function githubClient({ repository, token, fetcher = fetch, wait = delay }) {
  if (parseRepositorySlug(repository) !== repository || !token)
    throw new Error("GitHub repository and token are required");
  const root = `https://api.github.com/repos/${repository}`;
  async function request(
    url,
    { method = "GET", json, bytes, missing = false, binary = false } = {},
  ) {
    for (let attempt = 0; attempt < 5; attempt++) {
      let response;
      try {
        response = await fetcher(url, {
          method,
          signal: AbortSignal.timeout(60_000),
          headers: {
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
            accept: binary ? "application/octet-stream" : "application/vnd.github+json",
            ...(json !== undefined ? { "content-type": "application/json" } : {}),
            ...(bytes !== undefined ? { "content-type": "application/octet-stream" } : {}),
          },
          body: bytes ?? (json !== undefined ? JSON.stringify(json) : undefined),
        });
      } catch (error) {
        if (attempt === 4) throw new Error(`GitHub ${method} transport failed`, { cause: error });
        await wait(500 * 2 ** attempt);
        continue;
      }
      if (missing && response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      if (response.ok)
        return response.status === 204
          ? undefined
          : binary
            ? Buffer.from(await response.arrayBuffer())
            : response.json();
      const retry =
        response.status === 429 ||
        response.status >= 500 ||
        (response.status === 403 &&
          (response.headers.has("retry-after") ||
            response.headers.get("x-ratelimit-remaining") === "0"));
      await response.body?.cancel();
      if (!retry || attempt === 4)
        throw new Error(`GitHub ${method} failed: HTTP ${response.status}`);
      const seconds = Number(response.headers.get("retry-after"));
      await wait(Math.min(30_000, seconds > 0 ? seconds * 1000 : 500 * 2 ** attempt));
    }
    throw new Error("GitHub retry budget exhausted");
  }
  return {
    branchHead: async (branch) =>
      (await request(`${root}/commits/${encodeURIComponent(branch)}`)).sha,
    latestRelease: () => request(`${root}/releases/latest`, { missing: true }),
    getRelease: (tag) =>
      request(`${root}/releases/tags/${encodeURIComponent(tag)}`, { missing: true }),
    createRelease: (value) => request(`${root}/releases`, { method: "POST", json: value }),
    editRelease: (id, value) => request(`${root}/releases/${id}`, { method: "PATCH", json: value }),
    async assets(id) {
      const assets = [];
      for (let page = 1; ; page++) {
        const batch = await request(`${root}/releases/${id}/assets?per_page=100&page=${page}`);
        assets.push(...batch);
        if (batch.length < 100) return assets;
      }
    },
    download: (asset) => request(`${root}/releases/assets/${asset.id}`, { binary: true }),
    removeAsset: (asset) =>
      request(`${root}/releases/assets/${asset.id}`, { method: "DELETE", missing: true }),
    renameAsset: (asset, name) =>
      request(`${root}/releases/assets/${asset.id}`, { method: "PATCH", json: { name } }),
    upload: (release, name, bytes) =>
      request(
        `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
        { method: "POST", bytes },
      ),
  };
}

async function equalAsset(client, asset, bytes) {
  return (
    asset.state === "uploaded" &&
    asset.size === bytes.length &&
    sha256(await client.download(asset)) === sha256(bytes)
  );
}

/** Resume a draft after interruptions; never mutate an already public artifact release. */
export async function publishRelease(
  client,
  { tag, title, notes, target, assets, latest = false },
) {
  let release = await client.getRelease(tag);
  if (!release) {
    try {
      release = await client.createRelease({
        tag_name: tag,
        name: title,
        body: notes,
        target_commitish: target,
        draft: true,
        prerelease: false,
        make_latest: "false",
      });
    } catch (error) {
      release = await client.getRelease(tag);
      if (!release) throw error;
    }
  }
  const existing = new Map((await client.assets(release.id)).map((asset) => [asset.name, asset]));
  if (release.prerelease) throw new Error(`Unexpected prerelease: ${tag}`);
  for (const name of existing.keys())
    if (!assets.has(name)) throw new Error(`Unexpected remote asset: ${name}`);
  for (const [name, bytes] of assets) {
    const asset = existing.get(name);
    if (asset && (await equalAsset(client, asset, bytes))) continue;
    if (!release.draft) throw new Error(`Published asset differs or is missing: ${name}`);
    if (asset) await client.removeAsset(asset);
    try {
      await client.upload(release, name, bytes);
    } catch (error) {
      const recovered = (await client.assets(release.id)).find((item) => item.name === name);
      if (!recovered || !(await equalAsset(client, recovered, bytes))) throw error;
    }
  }
  const uploaded = await client.assets(release.id);
  if (uploaded.length !== assets.size) throw new Error("Release asset set is incomplete");
  for (const asset of uploaded)
    if (!assets.has(asset.name) || !(await equalAsset(client, asset, assets.get(asset.name))))
      throw new Error(`Uploaded asset verification failed: ${asset.name}`);
  if (release.draft)
    release = await client.editRelease(release.id, {
      draft: false,
      name: title,
      body: notes,
      make_latest: latest ? "true" : "false",
    });
  else if (latest) release = await client.editRelease(release.id, { make_latest: "true" });
  return release;
}

/** Keep the live catalogue intact until staged bytes have been downloaded and verified. */
export async function promoteCatalog(client, { bytes, publicKey, target }) {
  let release = await client.getRelease("plugin-channel");
  if (!release)
    return publishRelease(client, {
      tag: "plugin-channel",
      title: "Plugin update channel",
      notes: "Signed plugin catalogue. Trust the publisher key shipped with the application.",
      target,
      assets: new Map([
        ["catalog.json", bytes],
        ["publisher-public.pem", Buffer.from(publicKey)],
      ]),
    });
  if (release.draft)
    return publishRelease(client, {
      tag: "plugin-channel",
      title: "Plugin update channel",
      notes: "Signed plugin catalogue.",
      target,
      assets: new Map([
        ["catalog.json", bytes],
        ["publisher-public.pem", Buffer.from(publicKey)],
      ]),
    });
  let assets = await client.assets(release.id);
  const key = assets.find((asset) => asset.name === "publisher-public.pem");
  if (!key || !(await equalAsset(client, key, Buffer.from(publicKey))))
    throw new Error("Channel publisher key differs; key rotation requires a separate migration");
  const live = assets.find((asset) => asset.name === "catalog.json");
  if (live && (await equalAsset(client, live, bytes))) return release;
  const stageName = `catalog-${sha256(bytes)}.pending.json`;
  let staged = assets.find((asset) => asset.name === stageName);
  if (!staged) {
    try {
      staged = await client.upload(release, stageName, bytes);
    } catch (error) {
      staged = (await client.assets(release.id)).find((asset) => asset.name === stageName);
      if (!staged) throw error;
    }
  }
  if (!(await equalAsset(client, staged, bytes)))
    throw new Error("Staged catalogue verification failed");
  // Preserve the old bytes under a unique asset name. GitHub has no atomic asset swap.
  const previousName = live
    ? `catalog-${sha256(await client.download(live))}.previous.json`
    : undefined;
  if (live) {
    const prior = assets.find((asset) => asset.name === previousName);
    if (prior) await client.removeAsset(prior);
    await client.renameAsset(live, previousName);
  }
  try {
    await client.renameAsset(staged, "catalog.json");
  } catch (error) {
    assets = await client.assets(release.id);
    const current = assets.find((asset) => asset.name === "catalog.json");
    if (current && (await equalAsset(client, current, bytes))) return release;
    if (!current && live) await client.renameAsset(live, "catalog.json");
    throw error;
  }
  const current = (await client.assets(release.id)).find((asset) => asset.name === "catalog.json");
  if (!current || !(await equalAsset(client, current, bytes)))
    throw new Error("Promoted catalogue verification failed");
  // Retain previous catalogues for recovery; remove only stale pending uploads.
  for (const asset of await client.assets(release.id))
    if (/^catalog-[a-f0-9]{64}\.pending\.json$/.test(asset.name)) await client.removeAsset(asset);
  return release;
}
