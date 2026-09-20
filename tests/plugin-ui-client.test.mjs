import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { createPluginCall } from "../sdk/ui.ts";
import { deferred } from "./helpers.mjs";

test("UI transport uses its injected endpoint and retains native error results", async () => {
  const requests = [];
  const call = createPluginCall({
    endpoint: new URL("https://plugin.test/generation/rpc"),
    request: async (url, options) => {
      requests.push({
        url: url instanceof URL ? url.href : typeof url === "string" ? url : url.url,
        options,
      });
      return Response.json({ ok: true, result: { saved: true } });
    },
  });
  assert.deepEqual(await call("save", { value: "hello" }), { saved: true });
  assert.equal(requests[0].url, "https://plugin.test/generation/rpc");
  assert.equal(requests[0].options.credentials, "omit");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    method: "save",
    input: { value: "hello" },
  });
  const denied = createPluginCall({
    endpoint: new URL("https://plugin.test/rpc"),
    request: async () => Response.json({ ok: false, message: "已暂停" }, { status: 400 }),
  });
  await assert.rejects(denied("status"), /已暂停/);
});
for (const [status, body, expected] of [
  [404, "", /页面已失效/],
  [410, "expired", /页面已失效/],
  [503, "<html>Unavailable</html>", /连接暂时不可用/],
  [200, "not json", /数据格式有误/],
]) {
  test(`UI transport reports a readable error for non-JSON HTTP ${status}`, async () => {
    const call = createPluginCall({
      endpoint: new URL("http://127.0.0.1/rpc"),
      request: async () => new Response(body, { status }),
    });
    await assert.rejects(call("challenge"), expected);
  });
}

test("UI mount cancellation rejects a late response and blocks subsequent requests", async () => {
  const reply = deferred(),
    lifetime = new AbortController();
  let calls = 0;
  const call = createPluginCall({
    endpoint: new URL("https://plugin.test/rpc"),
    signal: lifetime.signal,
    request: async () => {
      calls++;
      return reply.promise;
    },
  });
  const pending = call("status");
  lifetime.abort();
  reply.resolve(Response.json({ ok: true, result: "stale" }));
  await assert.rejects(pending, /abort/i);
  await assert.rejects(call("status"), /abort/i);
  assert.equal(calls, 1);
});
