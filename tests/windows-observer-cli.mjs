import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { projectWindowsResponse } from "../plugins/telemetry/src/windows-response.ts";

assert.equal(process.platform, "win32");
const executable = resolve(
  process.argv[2] ?? "build/plugin-native/com.chord.telemetry/debug/chord-observer.exe",
);
function collect(request) {
  const raw = JSON.parse(
    execFileSync(executable, [], {
      input: JSON.stringify(request),
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 65_536,
    }),
  );
  return projectWindowsResponse(raw, request);
}
const request = { format: 1, processes: [{ role: "controller", pid: process.pid }], registry: [] };
const initial = collect(request);
assert.equal(initial.processes[0].ok, true, JSON.stringify(initial.processes[0]));
const birth = initial.processes[0].value.createdAt;
// All probes are read-only; eight real descriptors exercise the maximum request batch.
request.registry = Array.from({ length: 8 }, (_, index) => ({
  eventId: `contract-${index}`,
  pid: process.pid,
  createdAt: birth,
  path: "Software",
  name: "",
  desiredAccess: 1,
  allowParent: false,
  observedAtMs: Date.now(),
}));
const result = collect(request);
for (const probe of result.registry) {
  assert.equal(probe.ok, true, JSON.stringify(probe));
  const descriptor = probe.value.securityDescriptor;
  assert.equal(descriptor.ok, true, JSON.stringify(descriptor));
  assert.ok(descriptor.value.sddl.includes("D:"));
  assert.ok(!descriptor.value.sddl.includes("\0"));
  assert.ok(descriptor.value.aces.length > 0);
}
assert.equal(result.vendorEvidence.probes.length, 8);
assert.ok(result.vendorEvidence.probes.every((probe) => probe.status === "ready"));
console.log(
  "Native observer to JavaScript contract passed: real process token and eight registry descriptors.",
);
