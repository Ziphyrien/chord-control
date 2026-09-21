import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  NativeWindowsResponseError,
  projectWindowsResponse,
} from "../plugins/telemetry/src/windows-response.ts";

const ok = (value) => ({ ok: true, value });
const failed = { ok: false, code: 5, stage: "token.open", error: "Access denied" };
const request = {
  format: 1,
  processes: [{ role: "host", pid: 24, createdAt: "123" }],
  registry: [
    {
      eventId: "failure-1",
      pid: 24,
      createdAt: "123",
      path: "Software\\Example",
      name: "Setting",
      desiredAccess: 2,
      allowParent: true,
      observedAtMs: 1000000,
    },
  ],
};
function fixture() {
  return {
    format: 1,
    observedAtMs: 1000001,
    uac: Object.fromEntries(
      [
        "EnableLUA",
        "FilterAdministratorToken",
        "ConsentPromptBehaviorAdmin",
        "PromptOnSecureDesktop",
      ].map((key) => [key, ok(1)]),
    ),
    processes: [
      {
        role: "host",
        pid: 24,
        ...ok({
          pid: 24,
          createdAt: "123",
          elevated: false,
          elevationType: "limited",
          integrity: "medium",
          userSid: "S-1-5-21-1",
          executable: ok("C:\\app.exe"),
          fileVersion: ok("1.2.3.4"),
        }),
      },
    ],
    registry: [
      {
        eventId: "failure-1",
        ...ok({
          pid: 24,
          createdAt: "123",
          requestedAccess: 2,
          checkedAccess: 2,
          checkedPath: "HKEY_USERS\\S-1-5-21-1\\Software\\Example",
          ancestorUsed: false,
          daclAllowed: false,
          grantedAccess: 0,
          securityDescriptor: ok({
            sddl: "D:(D;;KA;;;WD)",
            ownerSid: "S-1-5-21-1",
            groupSid: "S-1-5-32-545",
            daclPresent: true,
            daclNull: false,
            daclProtected: false,
            daclAutoInherited: false,
            acesTruncated: false,
            aces: [
              {
                type: 1,
                flags: 0,
                inherited: false,
                inheritOnly: false,
                mask: 983103,
                sid: "S-1-1-0",
              },
            ],
          }),
        }),
      },
    ],
    vendorEvidence: {
      schemaVersion: 1,
      status: "collected",
      attribution: "unsupported",
      reason: "Bounded records only",
      limits: { windowMs: 120000, maxEvents: 16, maxChannels: 8, maxScanPerChannel: 128 },
      auditPolicy: ok({
        registrySuccess: true,
        registryFailure: true,
        scope: "current-system-policy",
        sacl: "not-read",
      }),
      channelEnumeration: ok({ scanned: 10, truncated: false }),
      probes: [
        {
          failureEventId: "failure-1",
          status: "ready",
          windowStartMs: 880000,
          windowEndMs: 1120000,
        },
      ],
      channels: [
        {
          name: "Security",
          status: "collected",
          scanned: 1,
          configuration: ok({ enabled: true }),
          events: [
            {
              recordId: "18446744073709551615",
              eventId: 4670,
              provider: "Microsoft-Windows-Security-Auditing",
              timeMs: 1000000,
              attribution: "unsupported",
              operation: "permissions-changed",
              objectName: "\\REGISTRY\\USER\\S-1-5-21-1\\Software\\Example",
              processId: 99,
              processName: "C:\\actor.exe",
              subjectSid: "S-1-5-18",
              oldSd: "D:",
              newSd: "D:(D;;KA;;;WD)",
              correlation: {
                failureEventId: "failure-1",
                basis: "target-path+time;acl-actor-not-failure-process",
                timeDeltaMs: 0,
              },
            },
          ],
        },
      ],
    },
  };
}
const project = (input) => projectWindowsResponse(input, request);

test("unavailable future probe keeps native u64 window end near MAX_SAFE_INTEGER", () => {
  const expected = structuredClone(request);
  expected.registry[0].observedAtMs = Number.MAX_SAFE_INTEGER;
  const input = fixture();
  input.vendorEvidence.channels = [];
  input.vendorEvidence.probes = [
    {
      failureEventId: "failure-1",
      status: "unavailable",
      code: 87,
      reason: "Future timestamp",
      windowStartMs: Number.MAX_SAFE_INTEGER - 120000,
      windowEndMs: Number(BigInt(Number.MAX_SAFE_INTEGER) + 120000n),
    },
  ];
  assert.deepEqual(projectWindowsResponse(input, expected), input);
});

test("event text rejects control characters and enforces UTF-8 byte bounds", () => {
  for (const oldSd of ["D:\u0001", "界".repeat(683)]) {
    const input = fixture();
    input.vendorEvidence.channels[0].events[0].oldSd = oldSd;
    const output = project(input);
    assert.equal(output.vendorEvidence.channels[0].status, "partial");
    assert.deepEqual(output.vendorEvidence.channels[0].events, []);
  }
});

test("paired native baseline, descriptor and rich evidence round-trip exactly", () => {
  assert.deepEqual(project(fixture()), fixture());
});

test("recursive projection removes private and unexpected fields at every native object boundary", () => {
  const input = fixture();
  function poison(value) {
    if (Array.isArray(value)) return value.forEach(poison);
    if (!value || typeof value !== "object") return;
    Object.values(value).forEach(poison);
    Object.assign(value, {
      commandLine: "PRIVATE",
      Details: "PRIVATE",
      rawRegistryValues: { secret: "PRIVATE" },
      valueName: "PRIVATE",
      oldValue: "PRIVATE",
      newValue: "PRIVATE",
      unexpected: "PRIVATE",
    });
  }
  poison(input);
  const output = project(input);
  assert.deepEqual(output, fixture());
  assert(!JSON.stringify(output).includes("PRIVATE"));
  assert.equal(output.vendorEvidence.channels[0].events[0].oldSd, "D:");
  assert.equal(output.vendorEvidence.channels[0].events[0].newSd, "D:(D;;KA;;;WD)");
});

test("native probe failures and optional failures retain successful siblings", () => {
  const input = fixture();
  input.uac.EnableLUA = failed;
  input.processes[0].value.fileVersion = failed;
  input.registry[0].value.securityDescriptor = failed;
  input.vendorEvidence.auditPolicy = failed;
  input.vendorEvidence.channels[0].configuration = failed;
  assert.deepEqual(project(input), input);
});

test("malformed known Outcome fields produce explicit protocol diagnostics without losing baseline siblings", () => {
  for (const bad of ["1", -1, 2 ** 32, 1.5, null, Infinity]) {
    const input = fixture();
    input.uac.EnableLUA = ok(bad);
    const output = project(input);
    assert.equal(output.uac.EnableLUA.stage, "protocol.validation");
    assert.deepEqual(output.uac.PromptOnSecureDesktop, ok(1));
    assert.deepEqual(output.registry, fixture().registry);
  }
  const input = fixture();
  input.processes[0].value.fileVersion = ok("65536.0.0.0");
  input.registry[0].value.securityDescriptor.value.aces[0].flags = 256;
  const output = project(input);
  assert.equal(output.processes[0].ok, true);
  assert.equal(output.processes[0].value.fileVersion.stage, "protocol.validation");
  assert.equal(output.registry[0].ok, true);
  assert.equal(output.registry[0].value.securityDescriptor.stage, "protocol.validation");
});

test("reject mismatched request echoes and response counts", () => {
  for (const mutate of [
    (v) => v.processes[0].pid++,
    (v) => (v.processes[0].role = "other"),
    (v) => (v.registry[0].eventId = "other"),
    (v) => v.processes.push(v.processes[0]),
    (v) => (v.registry = []),
    (v) => (v.observedAtMs = -1),
    (v) => (v.format = 2),
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => project(input), /Invalid native response/);
  }
});

test("core process and ACL identities, checked rights and ancestor paths are bound to the request", () => {
  for (const mutate of [
    (v) => v.pid++,
    (v) => (v.createdAt = "124"),
    (v) => (v.createdAt = "18446744073709551616"),
    (v) => (v.elevated = 1),
    (v) => (v.integrity = "root"),
  ]) {
    const input = fixture();
    mutate(input.processes[0].value);
    const output = project(input);
    assert.equal(output.processes[0].stage, "protocol.validation");
    assert.deepEqual(output.registry, fixture().registry);
  }
  for (const mutate of [
    (v) => v.pid++,
    (v) => (v.requestedAccess = 4),
    (v) => (v.checkedAccess = 4),
    (v) => (v.checkedPath = "HKEY_USERS\\S-1-5-21-1\\Other"),
  ]) {
    const input = fixture();
    mutate(input.registry[0].value);
    assert.equal(project(input).registry[0].stage, "protocol.validation");
  }
  const input = fixture();
  Object.assign(input.registry[0].value, {
    ancestorUsed: true,
    checkedAccess: 4,
    checkedPath: "HKEY_USERS\\S-1-5-21-1\\Software",
  });
  assert.deepEqual(project(input), input);
});

test("malformed event correlation and forbidden ACL text contexts do not remove valid sibling records", () => {
  for (const mutate of [
    (v) => (v.correlation.failureEventId = "other"),
    (v) => (v.correlation.timeDeltaMs = 1),
    (v) => (v.timeMs += 120001),
    (v) => (v.eventId = 4657),
    (v) => (v.oldSd = 3),
    (v) => (v.recordId = "18446744073709551616"),
  ]) {
    const input = fixture(),
      events = input.vendorEvidence.channels[0].events;
    const bad = structuredClone(events[0]);
    mutate(bad);
    events.push(bad);
    const output = project(input);
    assert.equal(output.vendorEvidence.channels[0].status, "partial");
    assert.equal(output.vendorEvidence.channels[0].events.length, 1);
    assert.deepEqual(output.processes, fixture().processes);
  }
});

test("bounds for ACEs, channels, events, scans, probes and evidence versions fail explicitly", () => {
  const input = fixture();
  input.registry[0].value.securityDescriptor.value.aces = Array(33).fill(
    input.registry[0].value.securityDescriptor.value.aces[0],
  );
  assert.equal(project(input).registry[0].value.securityDescriptor.stage, "protocol.validation");
  for (const mutate of [
    (v) => (v.schemaVersion = 2),
    (v) => (v.channels = Array(9).fill(v.channels[0])),
    (v) => (v.channels[0].events = Array(17).fill(v.channels[0].events[0])),
    (v) => (v.channels[0].scanned = 129),
    (v) => v.probes.push(v.probes[0]),
    (v) => (v.limits.maxEvents = 17),
  ]) {
    const input = fixture();
    mutate(input.vendorEvidence);
    const output = project(input);
    assert.equal(output.vendorEvidence.status, "unavailable");
    assert.match(output.vendorEvidence.reason, /Invalid native response/);
    assert.deepEqual(output.registry, fixture().registry);
  }
});

test("native timeout snapshot remains explicit and bounded", () => {
  const input = fixture();
  Object.assign(input.vendorEvidence, {
    status: "unavailable",
    channels: [],
    probes: [],
    auditPolicy: failed,
    channelEnumeration: failed,
  });
  assert.deepEqual(project(input), input);
});

test("fatal native envelopes throw validated typed failures instead of returning report values", () => {
  for (const [stage, code] of [
    ["output.size", 122],
    ["input.schema", 87],
    ["input.size", 122],
  ]) {
    assert.throws(
      () =>
        project({
          format: 1,
          observedAtMs: 0,
          ok: false,
          error: "Native collection failed",
          code,
          stage,
          commandLine: "private",
        }),
      (error) => {
        assert(error instanceof NativeWindowsResponseError);
        assert.equal(error.code, code);
        assert.equal(error.stage, stage);
        assert.equal(error.message, "Native collection failed");
        assert(!Object.hasOwn(error, "commandLine"));
        assert(!Object.hasOwn(error, "value"));
        return true;
      },
    );
  }
  for (const fields of [{ code: "122" }, { code: -1 }, { stage: null }, { error: {} }]) {
    assert.throws(
      () => project({ format: 1, observedAtMs: 0, ...failed, ...fields }),
      (error) => {
        assert(!(error instanceof NativeWindowsResponseError));
        return true;
      },
    );
  }
});
