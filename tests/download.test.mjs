import test from "node:test";
import assert from "node:assert/strict";
import { downloadFromSources } from "../controller/src/download-race.ts";
import { githubSources } from "../controller/src/github-sources.ts";
const direct = {
  id: "direct",
  url: "https://github.com/example/project/releases/download/v1/plugin.zip",
};
const proxy = { id: "proxy", url: "https://proxy.example/plugin.zip" };
const options = {
  maxBytes: 1000000,
  probeBytes: 4,
  decode: (bytes) => Buffer.from(bytes).toString(),
  probeTimeoutMs: 200,
  timeoutMs: 1000,
};
function streamResponse(text, delay, signal, cancelled = () => {}) {
  let timer;
  return new Response(
    new ReadableStream({
      start(controller) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            try {
              controller.error(new Error("aborted"));
            } catch {}
            cancelled();
          },
          { once: true },
        );
        timer = setTimeout(() => {
          controller.enqueue(Buffer.from(text));
          controller.close();
        }, delay);
      },
      cancel() {
        clearTimeout(timer);
        cancelled();
      },
    }),
    { headers: { "content-type": "application/octet-stream" } },
  );
}
test("only public GitHub release and raw URLs are sent through proxies", () => {
  assert.equal(githubSources(direct.url).length, 4);
  assert.equal(githubSources("https://raw.githubusercontent.com/a/b/main/catalog.json").length, 4);
  for (const url of [
    "https://example.org/plugin.zip",
    "https://api.github.com/repos/a/b",
    direct.url + "?token=private",
    "https://github.com/login",
    "http://github.com/a/b/releases/download/v1/a.zip",
    "https://github.com.evil.test/a/b/releases/download/v1/a.zip",
  ])
    assert.equal(githubSources(url).length, 1);
});
test("races actual body throughput and cancels the slower source", async () => {
  let cancelled = 0;
  const result = await downloadFromSources([direct, proxy], {
    ...options,
    fetcher: async (url, init) =>
      streamResponse(
        url === direct.url ? "slow" : "fast",
        url === direct.url ? 100 : 5,
        init.signal,
        () => {
          if (url === direct.url) cancelled++;
        },
      ),
  });
  assert.equal(result.value, "fast");
  assert.equal(result.source, "proxy");
  assert(cancelled > 0);
});
test("invalid signed metadata cannot win against slower valid content", async () => {
  const result = await downloadFromSources([proxy, direct], {
    ...options,
    probeBytes: 100,
    fetcher: async (url, init) =>
      streamResponse(
        url === proxy.url ? '{"valid":false}' : '{"valid":true}',
        url === proxy.url ? 1 : 15,
        init.signal,
      ),
    decode(bytes) {
      const value = JSON.parse(Buffer.from(bytes).toString());
      if (!value.valid) throw new Error("signature rejected");
      return value;
    },
  });
  assert.equal(result.source, "direct");
  assert.equal(result.value.valid, true);
});
test("a corrupt winning download falls back and restarts another source", async () => {
  let directCalls = 0;
  const result = await downloadFromSources([proxy, direct], {
    ...options,
    fetcher: async (url, init) => {
      if (url === direct.url) {
        directCalls++;
        return streamResponse("good-body", 30, init.signal);
      }
      let timer;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from("head"));
            timer = setTimeout(() => {
              controller.enqueue(Buffer.from("-corrupt"));
              controller.close();
            }, 10);
          },
          cancel() {
            clearTimeout(timer);
          },
        }),
      );
    },
    decode(bytes) {
      const value = Buffer.from(bytes).toString();
      if (value !== "good-body") throw new Error("SHA-256 mismatch");
      return value;
    },
  });
  assert.equal(result.value, "good-body");
  assert.equal(directCalls, 2);
});
test("ETags stay with their original source and unsolicited 304 cannot win", async () => {
  const first = await downloadFromSources([proxy], {
    ...options,
    fetcher: async () => new Response("valid", { headers: { etag: '"proxy-tag"' } }),
  });
  const seen = new Map();
  const result = await downloadFromSources([direct, proxy], {
    ...options,
    cached: first.value,
    etag: first.etag,
    fetcher: async (url, init) => {
      seen.set(url, init.headers["if-none-match"]);
      return new Response(null, { status: 304 });
    },
  });
  assert.equal(result.value, "valid");
  assert.equal(result.source, "proxy");
  assert.equal(seen.get(direct.url), undefined);
  assert.equal(seen.get(proxy.url), '"proxy-tag"');
});
test("oversized or HTML proxy responses fall back, and all timeouts reject", async () => {
  const result = await downloadFromSources([proxy, direct], {
    ...options,
    fetcher: async (url) =>
      url === proxy.url
        ? new Response("error", { headers: { "content-type": "text/html" } })
        : new Response("valid"),
  });
  assert.equal(result.source, "direct");
  await assert.rejects(
    downloadFromSources([direct], {
      ...options,
      probeTimeoutMs: 15,
      fetcher: async (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener("abort", () => reject(new Error("timeout"))),
        ),
    }),
    /timeout/,
  );
  await assert.rejects(
    downloadFromSources([direct], {
      ...options,
      maxBytes: 2,
      fetcher: async () => new Response("large"),
    }),
    /大小限制/,
  );
});
