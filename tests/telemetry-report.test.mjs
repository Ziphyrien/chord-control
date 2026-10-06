import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { Reporter } from "../plugins/telemetry/src/reporter.ts";
import { isTelemetryReport } from "../shared/telemetry.ts";

test("signed reports default to summary, queue explicit diagnostics and return to summary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telemetry-report-"));
  const modes = [],
    reports = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    close() {}
    send() {}
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", async (_url, options) => {
    const report = JSON.parse(options.body);
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(options.headers["X-Client-Key"], "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    assert.equal(
      verify(
        null,
        Buffer.from(options.body),
        key,
        Buffer.from(options.headers["X-Client-Signature"], "hex"),
      ),
      true,
    );
    reports.push(report);
    return new Response(null, { status: 201 });
  });
  const reporter = new Reporter(
    directory,
    async (_signal, detailed) => {
      modes.push(detailed);
      return { kind: detailed ? "diagnostic" : "summary" };
    },
    async () => {},
  );
  t.onTestFinished(async () => {
    await reporter.stop();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });
  await reporter.start();
  // A manual diagnostic requested during a summary must not be lost to coalescing.
  await Promise.all([reporter.send(), reporter.send(true)]);
  await reporter.send();
  assert.equal(reporter.status().succeeded, 3, String(reporter.status().lastError));
  assert.deepEqual(modes, [false, true, false]);
  assert.deepEqual(
    reports.map((report) => report.sequence),
    [1, 2, 3],
  );
  for (const report of reports) {
    assert.equal(isTelemetryReport(report), true);
    assert.equal(report.client.username, userInfo().username);
    assert.equal(Object.hasOwn(report.process, "cpuUserMicros"), false);
    assert.equal(Object.hasOwn(report.process, "cpuSystemMicros"), false);
  }
  assert.equal(reporter.report().host.kind, "summary");
});
