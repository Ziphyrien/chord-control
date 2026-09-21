import type { Json } from "../../../shared/protocol.ts";
import { object, text } from "../../../shared/validation.ts";

export type WindowsObservationRequest = {
  format: 1;
  processes: { role: string; pid: number; createdAt?: string }[];
  registry: {
    eventId: string;
    pid: number;
    createdAt: string;
    path: string;
    name: string;
    desiredAccess: number;
    allowParent: boolean;
    observedAtMs?: number;
  }[];
};
type Request = WindowsObservationRequest;
type RecordValue = { [key: string]: Json };
type Project = (value: unknown, path: string) => Json;
const U32 = 0xffffffff;
const WINDOW = 120_000;

function invalid(path: string): never {
  // Only schema paths, never untrusted field contents, enter local diagnostics.
  throw new Error(`Invalid native response: ${path}`);
}
function record(value: unknown, path: string): Record<string, unknown> {
  if (!object(value)) invalid(path);
  return value;
}
function integer(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    invalid(path);
  return value;
}
const uint: Project = (v, p) => integer(v, p, U32);
function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path);
  return value;
}
function string(value: unknown, path: string, max = 1000, empty = false): string {
  return text(value, path, max, empty);
}
function bytes(value: unknown, path: string, max: number): string {
  const result = string(value, path, max, true);
  if (Buffer.byteLength(result) > max) invalid(path);
  for (let i = 0; i < result.length; i++) {
    const code = result.charCodeAt(i);
    if (code < 32 || (code >= 127 && code <= 159)) invalid(path);
  }
  return result;
}
function choice(value: unknown, path: string, choices: readonly string[]): string {
  if (typeof value !== "string" || !choices.includes(value)) invalid(path);
  return value;
}
function exact(value: unknown, expected: Json, path: string): Json {
  if (value !== expected) invalid(path);
  return expected;
}
function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(path);
  return value;
}
function decimal(value: unknown, path: string, nonzero = true): string {
  const result = string(value, path, 20);
  if (
    !/^(0|[1-9][0-9]*)$/.test(result) ||
    BigInt(result) > 18446744073709551615n ||
    (nonzero && result === "0")
  )
    invalid(path);
  return result;
}
function sid(value: unknown, path: string): string {
  const result = string(value, path, 184);
  if (!/^S-1-(?:[0-9]+|0x[0-9a-fA-F]+)(?:-[0-9]+){0,15}$/.test(result)) invalid(path);
  return result;
}
function failure(path: string): RecordValue {
  return {
    ok: false,
    code: 13,
    stage: "protocol.validation",
    error: `Invalid native response: ${path}`,
  };
}
function outcome(value: unknown, path: string, project: Project): RecordValue {
  try {
    const v = record(value, path);
    if (v.ok === true) return { ok: true, value: project(v.value, `${path}.value`) };
    if (v.ok !== false) invalid(`${path}.ok`);
    return {
      ok: false,
      error: string(v.error, `${path}.error`),
      code: uint(v.code, `${path}.code`),
      stage: string(v.stage, `${path}.stage`, 100),
    };
  } catch {
    return failure(path);
  }
}
function optional(
  v: Record<string, unknown>,
  out: RecordValue,
  key: string,
  path: string,
  project: Project,
): void {
  if (Object.hasOwn(v, key)) out[key] = project(v[key], `${path}.${key}`);
}
function descriptor(value: unknown, path: string): Json {
  const v = record(value, path);
  return {
    sddl: bytes(v.sddl, `${path}.sddl`, 4096),
    ownerSid: sid(v.ownerSid, `${path}.ownerSid`),
    groupSid: sid(v.groupSid, `${path}.groupSid`),
    daclPresent: bool(v.daclPresent, `${path}.daclPresent`),
    daclNull: bool(v.daclNull, `${path}.daclNull`),
    daclProtected: bool(v.daclProtected, `${path}.daclProtected`),
    daclAutoInherited: bool(v.daclAutoInherited, `${path}.daclAutoInherited`),
    acesTruncated: bool(v.acesTruncated, `${path}.acesTruncated`),
    aces: list(v.aces, `${path}.aces`, 32).map((raw, i) => {
      const p = `${path}.aces[${i}]`,
        ace = record(raw, p);
      const out: RecordValue = {
        type: integer(ace.type, `${p}.type`, 255),
        flags: integer(ace.flags, `${p}.flags`, 255),
        inherited: bool(ace.inherited, `${p}.inherited`),
        inheritOnly: bool(ace.inheritOnly, `${p}.inheritOnly`),
      };
      optional(ace, out, "mask", p, uint);
      optional(ace, out, "sid", p, sid);
      return out;
    }),
  };
}
function processValue(value: unknown, path: string, expected: Request["processes"][number]): Json {
  const v = record(value, path);
  const birth = decimal(v.createdAt, `${path}.createdAt`);
  if (expected.createdAt && BigInt(birth) !== BigInt(expected.createdAt))
    invalid(`${path}.createdAt`);
  const integrity = string(v.integrity, `${path}.integrity`, 32);
  if (
    !["untrusted", "low", "medium", "mediumPlus", "high", "system", "protected"].includes(
      integrity,
    ) &&
    !/^unknown:[0-9]{1,10}$/.test(integrity)
  )
    invalid(`${path}.integrity`);
  if (integrity.startsWith("unknown:") && Number(integrity.slice(8)) > U32)
    invalid(`${path}.integrity`);
  return {
    pid: exact(v.pid, expected.pid, `${path}.pid`),
    createdAt: birth,
    elevated: bool(v.elevated, `${path}.elevated`),
    elevationType: choice(v.elevationType, `${path}.elevationType`, ["default", "full", "limited"]),
    integrity,
    userSid: sid(v.userSid, `${path}.userSid`),
    executable: outcome(v.executable, `${path}.executable`, (x, p) => string(x, p, 32768)),
    fileVersion: outcome(v.fileVersion, `${path}.fileVersion`, (x, p) => {
      const version = string(x, p, 23);
      if (
        !/^\d+\.\d+\.\d+\.\d+$/.test(version) ||
        version.split(".").some((n) => Number(n) > 65535)
      )
        invalid(p);
      return version;
    }),
  };
}
function registryValue(value: unknown, path: string, expected: Request["registry"][number]): Json {
  const v = record(value, path),
    birth = decimal(v.createdAt, `${path}.createdAt`);
  if (BigInt(birth) !== BigInt(expected.createdAt)) invalid(`${path}.createdAt`);
  const ancestor = bool(v.ancestorUsed, `${path}.ancestorUsed`);
  if (ancestor && !expected.allowParent) invalid(`${path}.ancestorUsed`);
  const checkedPath = string(v.checkedPath, `${path}.checkedPath`, 708);
  const match = /^HKEY_USERS\\(S-[^\\]+)(?:\\(.*))?$/.exec(checkedPath);
  if (!match) invalid(`${path}.checkedPath`);
  sid(match[1], `${path}.checkedPath`);
  const relative = (match[2] ?? "").toLowerCase(),
    requested = expected.path.toLowerCase();
  if (
    ancestor
      ? relative === requested || (relative !== "" && !requested.startsWith(`${relative}\\`))
      : relative !== requested
  )
    invalid(`${path}.checkedPath`);
  return {
    pid: exact(v.pid, expected.pid, `${path}.pid`),
    createdAt: birth,
    requestedAccess: exact(v.requestedAccess, expected.desiredAccess, `${path}.requestedAccess`),
    checkedAccess: exact(
      v.checkedAccess,
      ancestor ? 4 : expected.desiredAccess,
      `${path}.checkedAccess`,
    ),
    checkedPath,
    ancestorUsed: ancestor,
    daclAllowed: bool(v.daclAllowed, `${path}.daclAllowed`),
    grantedAccess: uint(v.grantedAccess, `${path}.grantedAccess`),
    securityDescriptor: outcome(v.securityDescriptor, `${path}.securityDescriptor`, descriptor),
  };
}
const statuses = ["collected", "partial", "unavailable"];
function details(v: Record<string, unknown>, out: RecordValue, path: string): void {
  optional(v, out, "code", path, uint);
  optional(v, out, "reason", path, string);
}
function eventValue(value: unknown, path: string, request: Request): Json {
  const v = record(value, path),
    c = record(v.correlation, `${path}.correlation`);
  const id = string(c.failureEventId, `${path}.correlation.failureEventId`, 128);
  const target = request.registry.find((p) => p.eventId === id);
  if (!target || target.observedAtMs === undefined) invalid(`${path}.correlation.failureEventId`);
  const time = integer(v.timeMs, `${path}.timeMs`);
  const delta = integer(c.timeDeltaMs, `${path}.correlation.timeDeltaMs`, WINDOW, -WINDOW);
  if (time - target.observedAtMs !== delta) invalid(`${path}.correlation.timeDeltaMs`);
  const basis = choice(c.basis, `${path}.correlation.basis`, [
    "ancestor-path+time;acl-actor-not-failure-process",
    "target-path+time;acl-actor-not-failure-process",
    "ancestor-path+time+pid+verified-process-lifetime",
    "target-path+time+pid+verified-process-lifetime",
  ]);
  const out: RecordValue = {
    recordId: decimal(v.recordId, `${path}.recordId`, false),
    eventId: uint(v.eventId, `${path}.eventId`),
    provider: bytes(v.provider, `${path}.provider`, 256),
    timeMs: time,
    attribution: exact(v.attribution, "unsupported", `${path}.attribution`),
    correlation: { failureEventId: id, basis, timeDeltaMs: delta },
  };
  for (const key of ["objectName", "processName"])
    optional(v, out, key, path, (x, p) => bytes(x, p, 2048));
  for (const key of ["subjectSid", "accessMask", "status", "operation"])
    optional(v, out, key, path, (x, p) => bytes(x, p, 256));
  optional(v, out, "processId", path, uint);
  // ACL text is the only historical registry content in the output contract.
  for (const key of ["oldSd", "newSd"]) {
    if (
      Object.hasOwn(v, key) &&
      (v.eventId !== 4670 || v.provider !== "Microsoft-Windows-Security-Auditing")
    )
      invalid(`${path}.${key}`);
    optional(v, out, key, path, (x, p) => bytes(x, p, 2048));
  }
  if (basis.includes("acl-actor")) {
    if (v.eventId !== 4670 || v.provider !== "Microsoft-Windows-Security-Auditing")
      invalid(`${path}.correlation.basis`);
  } else if (v.processId !== target.pid) invalid(`${path}.processId`);
  return out;
}
function evidence(value: unknown, path: string, request: Request): Json {
  const v = record(value, path),
    limits = record(v.limits, `${path}.limits`);
  let count = 0;
  const channels = list(v.channels, `${path}.channels`, 8).map((raw, i) => {
    const p = `${path}.channels[${i}]`,
      channel = record(raw, p);
    const out: RecordValue = {
      name: bytes(channel.name, `${p}.name`, 256),
      status: choice(channel.status, `${p}.status`, statuses),
      scanned: integer(channel.scanned, `${p}.scanned`, 128),
      configuration: outcome(channel.configuration, `${p}.configuration`, (x, q) => {
        const config = record(x, q);
        return { enabled: bool(config.enabled, `${q}.enabled`) };
      }),
      events: [],
    };
    details(channel, out, p);
    const events = list(channel.events, `${p}.events`, 16);
    count += events.length;
    if (count > 16) invalid(`${path}.channels.events.count`);
    const projected: Json[] = [];
    for (const [j, event] of events.entries()) {
      try {
        projected.push(eventValue(event, `${p}.events[${j}]`, request));
      } catch {
        out.status = "partial";
        out.code = 13;
        out.reason = `Invalid native response: ${p}.events[${j}]`;
      }
    }
    out.events = projected;
    return out;
  });
  return {
    schemaVersion: exact(v.schemaVersion, 1, `${path}.schemaVersion`),
    status: choice(v.status, `${path}.status`, statuses),
    attribution: exact(v.attribution, "unsupported", `${path}.attribution`),
    ...(Object.hasOwn(v, "reason") ? { reason: string(v.reason, `${path}.reason`) } : {}),
    channels,
    probes: list(v.probes, `${path}.probes`, request.registry.length).map((raw, i) => {
      const p = `${path}.probes[${i}]`,
        probe = record(raw, p);
      const out: RecordValue = {
        failureEventId: exact(
          probe.failureEventId,
          request.registry[i].eventId,
          `${p}.failureEventId`,
        ),
        status: choice(probe.status, `${p}.status`, ["ready", "unavailable"]),
      };
      details(probe, out, p);
      optional(probe, out, "windowStartMs", p, integer);
      const time = request.registry[i].observedAtMs;
      if (time !== undefined) {
        exact(probe.windowStartMs, Math.max(0, time - WINDOW), `${p}.windowStartMs`);
        // Native emits the window even for rejected future timestamps. Its u64 end
        // can exceed MAX_SAFE_INTEGER; accept only the JSON-rounded expected sum.
        out.windowEndMs = exact(probe.windowEndMs, time + WINDOW, `${p}.windowEndMs`);
      } else if (
        probe.status === "ready" ||
        Object.hasOwn(probe, "windowStartMs") ||
        Object.hasOwn(probe, "windowEndMs")
      )
        invalid(p);
      return out;
    }),
    auditPolicy: outcome(v.auditPolicy, `${path}.auditPolicy`, (x, p) => {
      const policy = record(x, p);
      return {
        registrySuccess: bool(policy.registrySuccess, `${p}.registrySuccess`),
        registryFailure: bool(policy.registryFailure, `${p}.registryFailure`),
        scope: exact(policy.scope, "current-system-policy", `${p}.scope`),
        sacl: exact(policy.sacl, "not-read", `${p}.sacl`),
      };
    }),
    channelEnumeration: outcome(v.channelEnumeration, `${path}.channelEnumeration`, (x, p) => {
      const enumeration = record(x, p);
      return {
        scanned: integer(enumeration.scanned, `${p}.scanned`, 512),
        truncated: bool(enumeration.truncated, `${p}.truncated`),
      };
    }),
    limits: {
      windowMs: exact(limits.windowMs, WINDOW, `${path}.limits.windowMs`),
      maxEvents: exact(limits.maxEvents, 16, `${path}.limits.maxEvents`),
      maxChannels: exact(limits.maxChannels, 8, `${path}.limits.maxChannels`),
      maxScanPerChannel: exact(limits.maxScanPerChannel, 128, `${path}.limits.maxScanPerChannel`),
    },
  };
}

/** A handled native envelope can still represent a fatal collection failure. */
export class NativeWindowsResponseError extends Error {
  readonly code: number;
  readonly stage: string;

  constructor(error: string, code: number, stage: string) {
    super(error);
    this.name = "NativeWindowsResponseError";
    this.code = code;
    this.stage = stage;
  }
}

/** Rebuild every native object; unknown fields never cross the telemetry boundary. */
export function projectWindowsResponse(value: unknown, request: Request): Json {
  const v = record(value, "response");
  exact(v.format, 1, "format");
  const observedAtMs = integer(v.observedAtMs, "observedAtMs");
  if (v.ok === false) {
    throw new NativeWindowsResponseError(
      string(v.error, "response.error"),
      integer(v.code, "response.code", U32),
      string(v.stage, "response.stage", 100),
    );
  }
  const uac = record(v.uac, "uac"),
    projectedUac: RecordValue = {};
  for (const key of [
    "EnableLUA",
    "FilterAdministratorToken",
    "ConsentPromptBehaviorAdmin",
    "PromptOnSecureDesktop",
  ])
    projectedUac[key] = outcome(uac[key], `uac.${key}`, uint);
  const processes = list(v.processes, "processes", 3),
    registry = list(v.registry, "registry", 8);
  if (processes.length !== request.processes.length || registry.length !== request.registry.length)
    invalid("probe counts");
  let vendorEvidence: Json;
  try {
    vendorEvidence = evidence(v.vendorEvidence, "vendorEvidence", request);
  } catch {
    vendorEvidence = {
      schemaVersion: 1,
      status: "unavailable",
      attribution: "unsupported",
      reason: "Invalid native response: vendorEvidence",
      channels: [],
      probes: [],
      auditPolicy: failure("vendorEvidence"),
      channelEnumeration: failure("vendorEvidence"),
      limits: { windowMs: WINDOW, maxEvents: 16, maxChannels: 8, maxScanPerChannel: 128 },
    };
  }
  return {
    format: 1,
    observedAtMs,
    uac: projectedUac,
    processes: processes.map((raw, i) => {
      const expected = request.processes[i],
        item = record(raw, `processes[${i}]`);
      exact(item.pid, expected.pid, `processes[${i}].pid`);
      exact(item.role, expected.role, `processes[${i}].role`);
      return {
        role: expected.role,
        pid: expected.pid,
        ...outcome(item, `processes[${i}]`, (x, p) => processValue(x, p, expected)),
      };
    }),
    registry: registry.map((raw, i) => {
      const expected = request.registry[i],
        item = record(raw, `registry[${i}]`);
      exact(item.eventId, expected.eventId, `registry[${i}].eventId`);
      return {
        eventId: expected.eventId,
        ...outcome(item, `registry[${i}]`, (x, p) => registryValue(x, p, expected)),
      };
    }),
    vendorEvidence,
  };
}
