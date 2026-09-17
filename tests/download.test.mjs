import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { downloadFromSources } from "../controller/src/infrastructure/downloads.ts";
import { githubSources } from "../controller/src/infrastructure/github.ts";

const direct = {
  id: "direct",
  url: "https://github.com/example/project/releases/download/v1/plugin.zip",
};
const proxy = { id: "proxy", url: "https://proxy.example/plugin.zip" };
const defaults = {
  maxBytes: 1_000_000,
  probeBytes: 4,
  decode: (bytes) => Buffer.from(bytes).toString(),
  probeTimeoutMs: 500,
  timeoutMs: 2000,
};

function delayedBody(text, milliseconds, signal, onCancel = () => {}) {
  let timer,
    finished = false;
  let abort;
  const clean = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  };
  return new Response(
    new ReadableStream({
      start(controller) {
        abort = () => {
          if (finished) return;
          finished = true;
          clean();
          controller.error(signal.reason);
          onCancel();
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
          if (finished) return;
          finished = true;
          clean();
          controller.enqueue(Buffer.from(text));
          controller.close();
        }, milliseconds);
      },
      cancel() {
        if (!finished) {
          finished = true;
          clean();
          onCancel();
        }
      },
    }),
    { headers: { "content-type": "application/octet-stream" } },
  );
}

test("only public GitHub release and raw routes are eligible for mirror racing", () => {
  for (const url of [
    direct.url,
    "https://github.com/a/b/releases/latest/download/latest.json",
    "https://raw.githubusercontent.com/a/b/main/catalog.json",
  ]) {
    const sources = githubSources(url);
    assert.equal(sources.length, 4);
    assert.deepEqual(sources[0], { id: "direct", url });
    assert.equal(new Set(sources.map((source) => source.id)).size, sources.length);
  }
  for (const url of [
    "https://example.org/plugin.zip",
    "https://api.github.com/repos/a/b",
    `${direct.url}?token=private`,
    `${direct.url}#private`,
    "https://user:secret@github.com/a/b/releases/download/v1/a.zip",
    "https://github.com/login",
    "http://github.com/a/b/releases/download/v1/a.zip",
    "https://github.com.evil.test/a/b/releases/download/v1/a.zip",
  ])
    assert.deepEqual(githubSources(url), [{ id: "direct", url }]);
});

test("body throughput selects the winner and cancels the slower stream", async () => {
  let cancelled = 0;
  const result = await downloadFromSources([direct, proxy], {
    ...defaults,
    fetcher: async (url, init) =>
      delayedBody(
        url === direct.url ? "slow" : "fast",
        url === direct.url ? 100 : 1,
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

test("fast untrusted metadata cannot beat slower content accepted by the verifier", async () => {
  const result = await downloadFromSources([proxy, direct], {
    ...defaults,
    probeBytes: 100,
    fetcher: async (url, init) =>
      delayedBody(
        JSON.stringify({ valid: url === direct.url }),
        url === proxy.url ? 1 : 20,
        init.signal,
      ),
    decode(bytes) {
      const value = JSON.parse(Buffer.from(bytes));
      if (!value.valid) throw new Error("signature rejected");
      return value;
    },
  });
  assert.equal(result.source, "direct");
  assert.equal(result.value.valid, true);
});

test("a corrupt body after a valid probe restarts a cancelled alternative", async () => {
  let directCalls = 0;
  const result = await downloadFromSources([proxy, direct], {
    ...defaults,
    fetcher: async (url, init) => {
      if (url === direct.url) {
        directCalls++;
        return delayedBody("verified-body", 40, init.signal);
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
      if (value !== "verified-body") throw new Error("SHA-256 mismatch");
      return value;
    },
  });
  assert.equal(result.value, "verified-body");
  assert.equal(directCalls, 2);
});

test("ETags belong to one route and a 304 requires cached verified content", async () => {
  const first = await downloadFromSources([proxy], {
    ...defaults,
    fetcher: async () => new Response("valid", { headers: { etag: '"proxy-tag"' } }),
  });
  const seen = new Map();
  const result = await downloadFromSources([direct, proxy], {
    ...defaults,
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
  await assert.rejects(
    downloadFromSources([proxy], {
      ...defaults,
      etag: first.etag,
      fetcher: async () => new Response(null, { status: 304 }),
    }),
    /304/,
  );
});

test("HTML, oversized declared bodies, and oversized streamed bodies cannot win", async () => {
  for (const headers of [{ "content-type": "text/html" }, { "content-length": "1000001" }]) {
    const result = await downloadFromSources([proxy, direct], {
      ...defaults,
      fetcher: async (url) =>
        url === proxy.url ? new Response("bad", { headers }) : new Response("valid"),
    });
    assert.equal(result.source, "direct");
  }
  await assert.rejects(
    downloadFromSources([direct], {
      ...defaults,
      maxBytes: 2,
      fetcher: async () => new Response("large"),
    }),
    /大小限制/,
  );
});

test("probe timeout rejects and caller cancellation stops every active transfer", async () => {
  const pending = (_url, init) =>
    new Promise((_resolve, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  await assert.rejects(
    downloadFromSources([direct], { ...defaults, probeTimeoutMs: 10, fetcher: pending }),
    /超时/,
  );
  const controller = new AbortController();
  let aborted = 0;
  const result = downloadFromSources([direct, proxy], {
    ...defaults,
    signal: controller.signal,
    fetcher: async (url, init) => {
      init.signal.addEventListener(
        "abort",
        () => {
          aborted++;
        },
        { once: true },
      );
      return pending(url, init);
    },
  });
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(result, /caller cancelled/);
  assert.equal(aborted, 2);
});

test("already cancelled and empty-source requests fail without a network call", async () => {
  let calls = 0;
  await assert.rejects(
    downloadFromSources([direct], {
      ...defaults,
      signal: AbortSignal.abort(new Error("stopped")),
      fetcher: async () => {
        calls++;
        return new Response("bad");
      },
    }),
    /stopped/,
  );
  assert.equal(calls, 0);
  await assert.rejects(downloadFromSources([], defaults), /没有可用来源/);
});
