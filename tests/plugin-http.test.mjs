import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { PluginHttpServer } from "../controller/src/transport/plugin-http.ts";

async function fixture(t, gate = (task) => task()) {
  let revision = "artifact-a";
  const calls = [];
  let reads = 0;
  let nextRead;
  const server = new PluginHttpServer(
    {
      revision: () => revision,
      async ui() {
        reads++;
        const pending = nextRead;
        nextRead = undefined;
        if (pending) return pending;
        return { html: "<!doctype html><p>plugin</p>", revision };
      },
      async call(pluginId, method, input) {
        calls.push({ pluginId, method, input });
        return input;
      },
    },
    gate,
  );
  await server.start();
  t.onTestFinished(() => server.close());
  return {
    server,
    calls,
    get reads() {
      return reads;
    },
    set revision(value) {
      revision = value;
    },
    set nextRead(value) {
      nextRead = value;
    },
  };
}
function rpc(url, input = null) {
  return fetch(new URL("rpc", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "echo", input }),
  });
}

for (const method of ["GET", "POST"]) {
  for (const scenario of ["revoked token with same artifact", "changed artifact"]) {
    test(`queued ${method} rejects ${scenario} before runtime access`, async (t) => {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const h = await fixture(t, async (task) => {
        entered.resolve();
        await release.promise;
        return task();
      });
      const page = await h.server.open("plugin");
      const pending = method === "GET" ? fetch(page.url) : rpc(page.url, "stale");
      try {
        await entered.promise;
        if (scenario === "revoked token with same artifact") {
          h.server.revoke("plugin");
          const fresh = await h.server.open("plugin");
          assert.notEqual(fresh.url, page.url);
          assert.equal(fresh.revision, page.revision);
        } else h.revision = "artifact-b";
        const reads = h.reads;
        release.resolve();
        const response = await pending;
        assert.equal(response.status, method === "GET" ? 410 : 400);
        await response.text();
        assert.deepEqual(h.calls, [], "stale requests must not invoke plugin methods");
        assert.equal(h.reads, reads, "stale requests must not read plugin UI");
      } finally {
        release.resolve();
        await pending.catch(() => {});
      }
    });
  }
}

test("current plugin page serves HTML and executes RPC once", async (t) => {
  const h = await fixture(t);
  const page = await h.server.open("plugin");
  assert.deepEqual(await h.server.open("plugin"), page);
  const response = await fetch(page.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(await response.text(), "<!doctype html><p>plugin</p>");
  const result = await rpc(page.url, { current: true });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true, result: { current: true } });
  assert.deepEqual(h.calls, [{ pluginId: "plugin", method: "echo", input: { current: true } }]);
});

test("panel and window have independent addresses and only window addresses expire on close", async (t) => {
  const h = await fixture(t);
  const panel = await h.server.open("plugin");
  const window = await h.server.open("plugin", "window");
  assert.notEqual(new URL(panel.url).pathname, new URL(window.url).pathname);
  assert.equal(new URL(panel.url).hash, "#panel");
  assert.equal(new URL(window.url).hash, "#window");
  assert.deepEqual(await h.server.open("plugin"), panel);
  assert.deepEqual(await h.server.open("plugin", "window"), window);
  h.server.revoke("plugin", "window");
  assert.equal((await fetch(window.url)).status, 404);
  assert.deepEqual(await (await rpc(panel.url, "panel remains available")).json(), {
    ok: true,
    result: "panel remains available",
  });
  const next = await h.server.open("plugin", "window");
  assert.notEqual(next.url, window.url);
  assert.deepEqual(await h.server.open("plugin"), panel);
  h.server.revoke("plugin");
  assert.equal((await fetch(panel.url)).status, 404);
  assert.equal((await fetch(next.url)).status, 404);
});

for (const scenario of ["revoked token with same artifact", "changed artifact"]) {
  test(`GET suppresses HTML when ${scenario} occurs during its read`, async (t) => {
    const entered = Promise.withResolvers();
    const read = Promise.withResolvers();
    const h = await fixture(t, (task) => {
      const result = task();
      entered.resolve();
      return result;
    });
    const page = await h.server.open("plugin");
    h.nextRead = read.promise;
    const pending = fetch(page.url);
    try {
      await entered.promise;
      if (scenario === "revoked token with same artifact") {
        h.server.revoke("plugin");
        const fresh = await h.server.open("plugin");
        assert.notEqual(fresh.url, page.url);
        assert.equal(fresh.revision, page.revision);
      } else h.revision = "artifact-b";
      read.resolve({ html: "stale private HTML", revision: page.revision });
      const response = await pending;
      assert.equal(response.status, 410);
      assert.doesNotMatch(await response.text(), /stale private HTML/);
      assert.deepEqual(h.calls, []);
    } finally {
      read.resolve({ html: "stale private HTML", revision: page.revision });
      await pending.catch(() => {});
    }
  });
}
