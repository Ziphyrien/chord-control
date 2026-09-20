import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { observationRequest, collectWindows } from "../plugins/telemetry/src/windows.ts";
import { isTelemetryReport } from "../shared/telemetry.ts";

function event(n, changes = {}) {
  return {
    eventId: `native-${n}`,
    operation: "registry.write",
    api: "RegSetValueExW",
    desiredAccess: 2,
    process: { pid: 24, createdAt: "1234567890" },
    target: { kind: "registry", hive: "HKCU", path: "Software\\Example", name: "Example" },
    ...changes,
  };
}
test("observation binds failed registry operations to their executing process and keeps newest eight", () => {
  const host = {
    native: {
      pid: 24,
      process: { pid: 24, createdAt: "1234567890" },
      failures: { events: Array.from({ length: 16 }, (_, n) => event(n)) },
    },
  };
  const request = observationRequest(host);
  assert.deepEqual(request.processes, [
    { role: "controller", pid: process.pid },
    { role: "host", pid: 24, createdAt: "1234567890" },
  ]);
  assert.deepEqual(
    request.registry.map((item) => item.eventId),
    Array.from({ length: 8 }, (_, n) => `native-${15 - n}`),
  );
  assert(
    request.registry.every(
      (item) => item.pid === 24 && item.createdAt === "1234567890" && !item.allowParent,
    ),
  );
});
test("old hosts retain process probes and malformed or unrelated operations never become ACL requests", () => {
  assert.deepEqual(observationRequest({ native: { pid: 24 } }).processes.at(-1), {
    role: "host",
    pid: 24,
  });
  const invalid = [
    event(1, { operation: "process.spawn" }),
    event(2, { desiredAccess: 0xf003f }),
    event(3, { process: { pid: 24 } }),
    event(4, { process: { pid: 0, createdAt: "123" } }),
    event(5, { target: { kind: "registry", hive: "HKLM", path: "Software", name: "" } }),
    event(6, { target: { kind: "registry", hive: "HKCU", path: "..\\Software", name: "" } }),
  ];
  assert.equal(
    observationRequest({ native: { failures: { events: invalid } } }).registry.length,
    0,
  );
  const create = observationRequest({
    native: { failures: { events: [event(7, { api: "RegCreateKeyExW" })] } },
  });
  assert.equal(create.registry[0].allowParent, true);
});
test("collector missing or cancelled is an explicit failure and can still form an accepted report", async () => {
  const windows = await collectWindows("Z:/missing-plugin-test", {}, new AbortController().signal);
  assert.equal(windows.ok, false);
  assert.equal(typeof windows.error, "string");
  const cancelled = await collectWindows("Z:/missing-plugin-test", {}, AbortSignal.abort());
  assert.equal(cancelled.ok, false);
  assert.equal(
    isTelemetryReport({
      format: 1,
      sequence: 1,
      capturedAt: new Date().toISOString(),
      requestId: null,
      client: {
        hostname: "test",
        username: "test",
        platform: "win32",
        release: "test",
        arch: "x64",
        uptimeSeconds: 1,
      },
      process: {
        uptimeSeconds: 1,
        rssBytes: 1,
        heapUsedBytes: 1,
        cpuUserMicros: 0,
        cpuSystemMicros: 0,
      },
      host: { native: { error: "old host unavailable" }, windows },
    }),
    true,
  );
});
