import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { SignedReleaseSource } from "../controller/src/infrastructure/release-source.ts";
import { createTransportHarness } from "./transport-harness.mjs";
import { publisher, manifest, signed } from "./helpers.mjs";

async function server(t) {
  const responses = [],
    requests = [],
    server = createServer((req, res) => {
      requests.push(req.headers);
      const next = responses.shift();
      res.writeHead(next?.status ?? 500, { "Content-Type": "application/json", ETag: '"test"' });
      res.end(next?.body ?? "{}");
    });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env.CHORD_CONTROL_ALLOW_LOCAL_HTTP;
  process.env.CHORD_CONTROL_ALLOW_LOCAL_HTTP = "1";
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.CHORD_CONTROL_ALLOW_LOCAL_HTTP;
    else process.env.CHORD_CONTROL_ALLOW_LOCAL_HTTP = previous;
  });
  return { url: `http://127.0.0.1:${server.address().port}/manifest.json`, responses, requests };
}
test("source revalidates conditional cache and only trusts verified version history", async (t) => {
  const h = await server(t),
    keys = publisher(),
    release = signed(manifest("signed.plugin"), keys.privateKey),
    source = new SignedReleaseSource();
  t.after(() => source.close());
  const origin = { kind: "manifest", url: h.url, publicKey: keys.publicKey };
  h.responses.push({ status: 200, body: JSON.stringify(release) });
  const first = await source.manifest(origin);
  h.responses.push({ status: 304 });
  assert.deepEqual((await source.manifest(origin, first.etag, release)).value, release);
  assert.equal(h.requests[1]["if-none-match"], '"test"');
  h.responses.push({ status: 200, body: JSON.stringify(release) });
  const corrupt = { ...release, version: "999.0.0" };
  assert.deepEqual((await source.manifest(origin, first.etag, corrupt)).value, release);
  assert.equal(
    h.requests[2]["if-none-match"],
    undefined,
    "unverified bytes cannot authorize a304 or set version floor",
  );
  h.responses.push({
    status: 200,
    body: JSON.stringify(signed({ ...release, version: "0.1.0" }, keys.privateKey)),
  });
  await assert.rejects(source.manifest(origin, first.etag, release), /版本回退/);
});
test(
  "signed catalogue rejection leaves existing runtime and saved source intact",
  { timeout: 30000 },
  async (t) => {
    const h = await createTransportHarness();
    t.after(() => h.close());
    await h.start();
    const release = await h.fixture();
    await h.add(release);
    const tampered = { ...release, permissions: ["registry-current-user"] };
    h.routes.set(`/${release.id}.json`, Buffer.from(JSON.stringify(tampered)));
    const result = await h.command({ type: "check_updates" });
    assert.equal(result.failures, 1);
    assert.equal(h.snapshot.plugins[0].running, true);
    assert.deepEqual((await h.config()).plugins[0].installed, release);
    assert.match(h.snapshot.plugins[0].error, /签名/);
  },
);
