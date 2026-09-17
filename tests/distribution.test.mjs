import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { buildCatalog, buildPlugin } from "../scripts/build-plugins.mjs";
import { githubClient, promoteCatalog, publishRelease } from "../scripts/github-release.mjs";
import {
  publisherKey,
  validatePluginRelease,
  validatePluginZip,
} from "../scripts/plugin-artifacts.mjs";
import {
  appAssetNames,
  prepareAppRelease,
  verifyUpdaterSignature,
} from "../scripts/prepare-app-release.mjs";
import { publishPlugins } from "../scripts/publish-plugins.mjs";
import { publishApp } from "../scripts/publish-app.mjs";
import {
  currentRepositorySlug,
  distributionFor,
  parseRepositorySlug,
} from "../scripts/repository-config.mjs";
import {
  discoverPackages,
  jsonBytes,
  releaseTime,
  sha256,
  withDirectoryLock,
} from "../scripts/release-files.mjs";
import { signingBytes, verifySigned } from "../shared/signing.ts";

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "chord-distribution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function keys() {
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { privateKey, publicKey: publisherKey(privateKey) };
}
async function packageFixture(root, name, control = {}) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    jsonBytes({ name, version: "1.0.0", description: "Fixture", control }),
  );
  return directory;
}
async function fixtureCompiler({ bundleDir, pkg }) {
  const worker = Buffer.from("module.exports = {};\n");
  await writeFile(join(bundleDir, "worker.cjs"), worker);
  await writeFile(
    join(bundleDir, "chord-facets.json"),
    jsonBytes({
      format: "chord.facet-bundle",
      formatVersion: 2,
      plugin: { id: pkg.name, version: pkg.version },
      entries: {
        worker: {
          file: "worker.cjs",
          integrity: `sha256-${createHash("sha256").update(worker).digest("base64")}`,
          externalImports: ["node:fs"],
        },
      },
    }),
  );
  if (pkg.control?.ui) await writeFile(join(bundleDir, "ui.html"), "<p>Fixture</p>");
}
function fakeGithub() {
  const releases = new Map(),
    events = [];
  let next = 1;
  const client = {
    releases,
    events,
    failRename: false,
    failUpload: false,
    async getRelease(tag) {
      return releases.get(tag);
    },
    async createRelease(value) {
      const release = { ...value, id: next++, assets: [] };
      releases.set(value.tag_name, release);
      events.push(`create:${value.tag_name}`);
      return release;
    },
    async editRelease(id, patch) {
      const release = [...releases.values()].find((item) => item.id === id);
      Object.assign(release, patch);
      events.push(`promote:${release.tag_name}`);
      return release;
    },
    async assets(id) {
      return [...releases.values()]
        .find((item) => item.id === id)
        .assets.map((asset) => ({ ...asset }));
    },
    async download(asset) {
      return Buffer.from(asset.bytes);
    },
    async upload(release, name, bytes) {
      if (client.failUpload) throw new Error("upload interrupted");
      const asset = {
        id: next++,
        name,
        size: bytes.length,
        state: "uploaded",
        bytes: Buffer.from(bytes),
      };
      release.assets.push(asset);
      events.push(`upload:${release.tag_name}:${name}`);
      return asset;
    },
    async removeAsset(asset) {
      for (const release of releases.values())
        release.assets = release.assets.filter((item) => item.id !== asset.id);
    },
    async renameAsset(asset, name) {
      if (client.failRename && name === "catalog.json" && asset.name.endsWith("pending.json")) {
        client.failRename = false;
        throw new Error("rename interrupted");
      }
      const actual = [...releases.values()]
        .flatMap((release) => release.assets)
        .find((item) => item.id === asset.id);
      actual.name = name;
      events.push(`rename:${name}`);
      return actual;
    },
  };
  return client;
}

test("repository identity accepts supported GitHub forms and rejects ambiguous overrides", (t) => {
  for (const value of [
    "owner/project",
    "https://github.com/owner/project.git",
    "git@github.com:owner/project.git",
    "ssh://git@github.com/owner/project.git",
    "github.com/owner/project",
  ])
    assert.equal(parseRepositorySlug(value), "owner/project");
  for (const value of [
    "https://gitlab.com/a/b",
    "https://github.com/a/b/tree/main",
    "a/b/c",
    "../b",
    "https://github.com/a/b?token=x",
    "https://user@github.com/a/b",
    "",
  ])
    assert.equal(parseRepositorySlug(value), undefined, value);
  const previous = process.env.CHORD_CONTROL_REPOSITORY;
  t.after(() => {
    if (previous === undefined) delete process.env.CHORD_CONTROL_REPOSITORY;
    else process.env.CHORD_CONTROL_REPOSITORY = previous;
  });
  process.env.CHORD_CONTROL_REPOSITORY = "fork/desktop";
  assert.equal(currentRepositorySlug(), "fork/desktop");
  process.env.CHORD_CONTROL_REPOSITORY = "invalid";
  assert.throws(() => currentRepositorySlug(), /Invalid CHORD_CONTROL_REPOSITORY/);
  assert.equal(
    distributionFor("owner/project").appReleaseUrl,
    "https://github.com/owner/project/releases/latest/download/Chord.Control-setup.exe",
  );
  assert.equal(
    distributionFor("owner/project").pluginCatalogUrl,
    "https://github.com/owner/project/releases/download/plugin-channel/catalog.json",
  );
});

test("catalogues discover only packages, preserve metadata and reproduce signed ZIP bytes", async (t) => {
  const root = await temporary(t),
    pluginsRoot = join(root, "plugins"),
    outdir = join(root, "release");
  await mkdir(join(pluginsRoot, "support"), { recursive: true });
  await packageFixture(pluginsRoot, "sample.plugin", {
    ui: "ui/index.html",
    icon: "sparkles",
    color: "#123456",
    hooks: ["beforeDisable"],
    services: { provides: ["sample.service"], requires: [] },
  });
  assert.equal((await discoverPackages(pluginsRoot)).length, 1);
  const { privateKey, publicKey } = keys();
  const options = {
    pluginsRoot,
    outdir,
    privateKey,
    baseUrl: "https://github.com/owner/project/releases/download/plugins-test",
    generatedAt: releaseTime("1000000000"),
    compiler: fixtureCompiler,
  };
  const first = await buildCatalog(options);
  const snapshot = new Map(
    await Promise.all(
      (await readdir(outdir)).map(async (name) => [name, await readFile(join(outdir, name))]),
    ),
  );
  const second = await buildCatalog(options);
  assert.deepEqual(first, second);
  for (const [name, bytes] of snapshot) assert.deepEqual(await readFile(join(outdir, name)), bytes);
  assert.equal(first.plugins[0].icon, "sparkles");
  assert.equal(first.plugins[0].color, "#123456");
  assert.equal(first.plugins[0].ui, "ui.html");
  verifySigned(first, publicKey);
  const { assets } = await validatePluginRelease(outdir, { publicKey, baseUrl: options.baseUrl });
  assert.equal(assets.size, 4);
  const reordered = Object.fromEntries(Object.entries(first).reverse());
  assert.deepEqual(signingBytes(first), signingBytes(reordered));
  verifySigned(reordered, publicKey);
  await writeFile(join(outdir, "stale.zip"), "stale");
  await assert.rejects(validatePluginRelease(outdir, { publicKey }), /Unexpected release file/);
});

test("dependency failures retain the last complete catalogue and concurrent writers are rejected", async (t) => {
  const root = await temporary(t),
    pluginsRoot = join(root, "plugins"),
    outdir = join(root, "release");
  await packageFixture(pluginsRoot, "sample.plugin");
  const options = {
    pluginsRoot,
    outdir,
    baseUrl: "https://example.test/plugins",
    compiler: fixtureCompiler,
  };
  await buildCatalog(options);
  const before = await readFile(join(outdir, "catalog.json"));
  await packageFixture(pluginsRoot, "missing.consumer", {
    services: { provides: [], requires: ["missing"] },
  });
  await assert.rejects(buildCatalog(options), /missing/);
  assert.deepEqual(await readFile(join(outdir, "catalog.json")), before);
  await withDirectoryLock(outdir, () => assert.rejects(buildCatalog(options), /Another writer/));
});

test("archive validation rejects traversal, hash mismatch, identity changes and unbundled dependencies", async (t) => {
  const root = await temporary(t),
    directory = await packageFixture(root, "sample.plugin"),
    outdir = join(root, "out");
  const manifest = await buildPlugin({
    directory,
    outdir,
    baseUrl: "https://example.test",
    compiler: fixtureCompiler,
  });
  const bytes = await readFile(join(outdir, `${manifest.id}-${manifest.artifactSha256}.zip`));
  const files = validatePluginZip(bytes, manifest);
  assert.throws(
    () => validatePluginZip(bytes, { ...manifest, artifactSha256: "0".repeat(64) }),
    /hash/,
  );
  function altered(entries) {
    const archive = zipSync(entries);
    return () => validatePluginZip(archive, { ...manifest, artifactSha256: sha256(archive) });
  }
  assert.throws(altered({ ...files, "../escape": new Uint8Array([1]) }), /路径/);
  const bundle = JSON.parse(Buffer.from(files["chord-facets.json"]));
  bundle.plugin.id = "another.plugin";
  assert.throws(altered({ ...files, "chord-facets.json": jsonBytes(bundle) }), /identity/);
  bundle.plugin.id = manifest.id;
  bundle.entries.worker.externalImports = ["not-bundled"];
  assert.throws(altered({ ...files, "chord-facets.json": jsonBytes(bundle) }), /unbundled/);
});

test("draft publication resumes failures, verifies uploaded bytes and never overwrites public artifacts", async () => {
  const client = fakeGithub();
  const options = {
    tag: "plugins-test",
    title: "Fixture",
    notes: "Notes",
    target: "a".repeat(40),
    assets: new Map([
      ["one.zip", Buffer.from("one")],
      ["two.json", Buffer.from("two")],
    ]),
  };
  client.failUpload = true;
  await assert.rejects(publishRelease(client, options), /interrupted/);
  assert.equal((await client.getRelease(options.tag)).draft, true);
  client.failUpload = false;
  await publishRelease(client, options);
  assert.equal((await client.getRelease(options.tag)).draft, false);
  const count = client.events.length;
  await publishRelease(client, options);
  assert.equal(client.events.length, count);
  await assert.rejects(
    publishRelease(client, {
      ...options,
      assets: new Map([
        ["one.zip", Buffer.from("changed")],
        ["two.json", Buffer.from("two")],
      ]),
    }),
    /Published asset differs/,
  );
});

test("channel staging rolls back interrupted promotion and supports retry", async () => {
  const client = fakeGithub(),
    publicKey = keys().publicKey;
  await promoteCatalog(client, { bytes: Buffer.from("old"), publicKey, target: "a".repeat(40) });
  client.failRename = true;
  await assert.rejects(
    promoteCatalog(client, { bytes: Buffer.from("new"), publicKey }),
    /interrupted/,
  );
  const channel = await client.getRelease("plugin-channel");
  assert.equal(
    (
      await client.download(channel.assets.find((asset) => asset.name === "catalog.json"))
    ).toString(),
    "old",
  );
  await promoteCatalog(client, { bytes: Buffer.from("new"), publicKey });
  assert.equal(
    (
      await client.download(channel.assets.find((asset) => asset.name === "catalog.json"))
    ).toString(),
    "new",
  );
  await assert.rejects(
    promoteCatalog(client, { bytes: Buffer.from("other"), publicKey: keys().publicKey }),
    /key differs/,
  );
});

test("end-to-end publisher exposes artifacts before channel and rejects superseded source", async (t) => {
  const root = await temporary(t),
    pluginsRoot = join(root, "plugins"),
    directory = join(root, "release");
  await packageFixture(pluginsRoot, "sample.plugin");
  const { privateKey, publicKey } = keys(),
    tag = "plugins-fixture",
    repository = "owner/project",
    target = "a".repeat(40);
  await buildCatalog({
    pluginsRoot,
    outdir: directory,
    privateKey,
    baseUrl: `https://github.com/${repository}/releases/download/${tag}`,
    compiler: fixtureCompiler,
  });
  const client = fakeGithub();
  await publishPlugins({ directory, tag, repository, publicKey, target, client });
  assert(client.events.indexOf(`promote:${tag}`) < client.events.indexOf("create:plugin-channel"));
  client.branchHead = async () => "b".repeat(40);
  await assert.rejects(
    publishPlugins({ directory, tag, repository, publicKey, target, client }),
    /no longer main HEAD/,
  );
});

test("GitHub retries bounded transient failures and does not turn auth failures into missing releases", async () => {
  let calls = 0;
  const client = githubClient({
    repository: "owner/project",
    token: "fixture",
    wait: async () => {},
    fetcher: async () => {
      calls++;
      return calls === 1 ? new Response("busy", { status: 503 }) : Response.json({ id: 1 });
    },
  });
  assert.equal((await client.getRelease("fixture")).id, 1);
  assert.equal(calls, 2);
  const forbidden = githubClient({
    repository: "owner/project",
    token: "fixture",
    fetcher: async () => new Response("no", { status: 403 }),
  });
  await assert.rejects(forbidden.getRelease("fixture"), /HTTP 403/);
});

function updaterFixture(bytes) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = Buffer.from("12345678"),
    rawKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const rawSignature = sign(null, createHash("blake2b512").update(bytes).digest(), privateKey);
  const comment = "timestamp:1000000000";
  const packet = Buffer.concat([Buffer.from("ED"), keyId, rawSignature]);
  const global = sign(null, Buffer.concat([rawSignature, Buffer.from(comment)]), privateKey);
  return {
    publicKey: Buffer.from(
      `untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), keyId, rawKey]).toString("base64")}\n`,
    ).toString("base64"),
    signature: Buffer.from(
      `untrusted comment: fixture\n${packet.toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`,
    ).toString("base64"),
  };
}

test("app preparation verifies minisign, uses actual notes, and emits exactly five updater assets", async (t) => {
  const root = await temporary(t),
    bytes = Buffer.from("MZfixture installer"),
    fixture = updaterFixture(bytes);
  verifyUpdaterSignature(bytes, fixture.signature, fixture.publicKey);
  assert.throws(
    () => verifyUpdaterSignature(Buffer.from("tampered"), fixture.signature, fixture.publicKey),
    /verification failed/,
  );
  for (const directory of [
    "src-tauri/target/release/bundle/nsis",
    "src-tauri/binaries",
    "docs/releases",
  ])
    await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, "package.json"), jsonBytes({ version: "0.3.0" }));
  await writeFile(
    join(root, "src-tauri/tauri.conf.json"),
    jsonBytes({ version: "0.3.0", plugins: { updater: { pubkey: fixture.publicKey } } }),
  );
  await writeFile(join(root, "docs/releases/0.3.0.md"), "# 0.3.0\n\nActual release notes.\n");
  const installer = join(root, "src-tauri/target/release/bundle/nsis/setup.exe");
  await writeFile(installer, bytes);
  await writeFile(`${installer}.sig`, fixture.signature);
  await writeFile(join(root, "src-tauri/binaries", appAssetNames[2]), "MZfixture controller");
  const result = await prepareAppRelease({
    root,
    repository: "owner/project",
    generatedAt: releaseTime("1000000000"),
    refType: "tag",
    refName: "app-v0.3.0",
  });
  assert.equal(result.tag, "app-v0.3.0");
  assert.deepEqual([...result.assets.keys()], appAssetNames);
  const latest = JSON.parse(result.assets.get("latest.json"));
  assert.match(latest.notes, /Actual release notes/);
  assert.equal(latest.platforms["windows-x86_64"].signature, fixture.signature);
  assert.match(latest.platforms["windows-x86_64"].url, /app-v0\.3\.0\/Chord.Control-setup.exe$/);
  assert.equal(result.assets.get("SHA256SUMS.txt").toString().trim().split("\n").length, 4);
  await assert.rejects(
    prepareAppRelease({ root, repository: "owner/project", refType: "tag", refName: "app-v0.2.0" }),
    /tag does not match/,
  );
  const client = fakeGithub();
  client.latestRelease = async () => undefined;
  const publication = {
    root,
    repository: "owner/project",
    target: "a".repeat(40),
    refType: "tag",
    refName: "app-v0.3.0",
    client,
  };
  const published = await publishApp(publication);
  assert.equal(published.draft, false);
  assert.equal(published.make_latest, "true");
  assert.deepEqual(
    published.assets.map((asset) => asset.name),
    appAssetNames,
  );
  client.latestRelease = async () => ({ tag_name: "app-v0.4.0" });
  await assert.rejects(publishApp(publication), /older application version/);
});
