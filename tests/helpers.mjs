import { generateKeyPairSync, sign } from "node:crypto";
import { signingBytes } from "../shared/signing.ts";
import { emptyConfiguration } from "../controller/src/domain/configuration.ts";
import { serialQueue } from "../controller/src/application/execution.ts";
import { PluginService } from "../controller/src/application/plugin-service.ts";

export function manifest(id, options = {}) {
  return {
    id,
    name: id,
    version: "1.0.0",
    artifactUrl: `https://example.test/${id}.zip`,
    artifactSha256: "a".repeat(64),
    permissions: [],
    ...options,
  };
}
export function registration(release, options = {}) {
  return {
    id: release.id,
    source: { kind: "catalog", url: "https://example.test/catalog.json", publicKey: "" },
    sourceStatus: "available",
    enabled: true,
    installed: release,
    available: release,
    ...options,
  };
}
export function signed(value, key) {
  return { ...value, signature: sign(null, signingBytes(value), key).toString("base64") };
}
export function publisher() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() };
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
/** Domain fixture uses real application policy and persistence boundaries, deterministic runtime ports. */
export async function applicationFixture(plugins = []) {
  let state = {
    ...emptyConfiguration(),
    settings: {
      checkIntervalMinutes: 30,
      autoUpdate: true,
      catalogUrl: "https://example.test/catalog.json",
      catalogPublicKey: "",
    },
    plugins,
  };
  const calls = [],
    running = new Map(),
    events = [];
  let failCommit = false,
    failActivate = new Set(),
    catalog = { format: 1, plugins: plugins.map((item) => item.available ?? item.installed) },
    blockDownload;
  const repository = {
    snapshot: () => structuredClone(state),
    async commit(next) {
      if (failCommit) throw new Error("disk full");
      state = structuredClone(next);
    },
  };
  const runtime = {
    has: (id) => running.has(id),
    revision: (id) => running.get(id)?.artifactSha256,
    async activate(release) {
      calls.push(`start:${release.id}@${release.version}`);
      if (failActivate.has(`${release.id}@${release.version}`))
        throw new Error("activation failed");
      running.set(release.id, release);
    },
    async deactivate(id) {
      calls.push(`stop:${id}`);
      running.delete(id);
    },
    async before() {
      return true;
    },
    async ui() {
      return { html: "<p>fixture</p>", revision: "a".repeat(64) };
    },
    async call() {
      return "responsive";
    },
  };
  const source = {
    async catalog() {
      return { value: catalog, etag: '"fixture"' };
    },
    async manifest(origin) {
      const release = catalog.plugins.find(
        (item) => item.artifactUrl === origin.url || item.id === origin.url,
      );
      if (!release) throw new Error("missing");
      return { value: release };
    },
    async archive(release) {
      calls.push(`download:${release.id}`);
      if (blockDownload) await blockDownload.promise;
      return new Uint8Array([1]);
    },
    close() {
      blockDownload?.reject(new Error("stopped"));
    },
  };
  const archives = {
    async read() {
      return new Uint8Array([1]);
    },
    async write() {},
    async validate() {},
  };
  const gate = serialQueue();
  const service = new PluginService({
    repository,
    runtime,
    source,
    archives,
    gate,
    allowUnsigned: true,
    log: (...event) => events.push(event),
  });
  await service.restore();
  calls.length = 0;
  return {
    service,
    runtime,
    repository,
    gate,
    calls,
    events,
    set catalog(value) {
      catalog = value;
    },
    set failCommit(value) {
      failCommit = value;
    },
    set failActivate(value) {
      failActivate = new Set(value);
    },
    set blockDownload(value) {
      blockDownload = value;
    },
  };
}
