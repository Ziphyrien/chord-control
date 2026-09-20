import { execFile } from "node:child_process";
import { join } from "node:path";
import type { Json } from "../../../shared/protocol.ts";
import { jsonValue, message, object } from "../../../shared/validation.ts";

type ProcessProbe = { role: string; pid: number; createdAt?: string };
type RegistryProbe = {
  eventId: string;
  pid: number;
  createdAt: string;
  path: string;
  name: string;
  desiredAccess: number;
  allowParent: boolean;
};
type Request = { format: 1; processes: ProcessProbe[]; registry: RegistryProbe[] };
const validPid = (pid: unknown): pid is number =>
  typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid <= 0xffffffff;
const validBirth = (birth: unknown): birth is string =>
  typeof birth === "string" && /^[1-9][0-9]{0,19}$/.test(birth);

/** Select only host-reported failed operations, never accept probe commands from the network. */
export function observationRequest(host: Json): Request {
  const native = object(host) && object(host.native) ? host.native : {};
  const identity = object(native.process) ? native.process : {};
  const processes: ProcessProbe[] = [{ role: "controller", pid: process.pid }];
  const pid = identity.pid ?? native.pid;
  if (validPid(pid))
    processes.push({
      role: "host",
      pid,
      ...(validBirth(identity.createdAt) ? { createdAt: identity.createdAt } : {}),
    });
  const history = object(native.failures) ? native.failures : {};
  const events = Array.isArray(history.events) ? history.events.slice(-16).reverse() : [];
  const registry: RegistryProbe[] = [];
  for (const event of events) {
    if (!object(event) || !object(event.target) || !object(event.process)) continue;
    const { target, process: owner } = event;
    if (
      event.operation !== "registry.write" ||
      target.kind !== "registry" ||
      target.hive !== "HKCU" ||
      typeof event.api !== "string" ||
      !["RegOpenKeyExW", "RegCreateKeyExW", "RegSetValueExW", "RegDeleteValueW"].includes(
        event.api,
      ) ||
      !validPid(owner.pid) ||
      !validBirth(owner.createdAt) ||
      typeof event.eventId !== "string" ||
      event.eventId.length > 100 ||
      !event.eventId.length ||
      typeof target.path !== "string" ||
      !target.path.length ||
      target.path.length > 512 ||
      /[\0/]/.test(target.path) ||
      target.path.split("\\").some((part) => !part || part === "." || part === "..") ||
      typeof target.name !== "string" ||
      target.name.length > 256 ||
      target.name.includes("\0") ||
      event.desiredAccess !== 2
    )
      continue;
    registry.push({
      eventId: event.eventId,
      pid: owner.pid,
      createdAt: owner.createdAt,
      path: target.path,
      name: target.name,
      desiredAccess: event.desiredAccess,
      allowParent: event.api === "RegCreateKeyExW",
    });
    if (registry.length === 8) break;
  }
  return { format: 1, processes, registry };
}

function validateResult(value: unknown, request: Request): value is Json {
  if (
    !object(value) ||
    value.format !== 1 ||
    !jsonValue(value) ||
    typeof value.observedAtMs !== "number" ||
    !Number.isSafeInteger(value.observedAtMs) ||
    !object(value.uac) ||
    !Array.isArray(value.processes) ||
    !Array.isArray(value.registry) ||
    value.processes.length !== request.processes.length ||
    value.registry.length !== request.registry.length ||
    !object(value.vendorEvidence)
  )
    return false;
  const outcome = (item: unknown) =>
    object(item) &&
    (item.ok === true
      ? Object.hasOwn(item, "value")
      : item.ok === false && typeof item.error === "string");
  const uac = value.uac;
  return (
    [
      "EnableLUA",
      "FilterAdministratorToken",
      "ConsentPromptBehaviorAdmin",
      "PromptOnSecureDesktop",
    ].every((key) => outcome(uac[key])) &&
    value.processes.every(
      (item, index) =>
        outcome(item) &&
        object(item) &&
        item.pid === request.processes[index].pid &&
        item.role === request.processes[index].role,
    ) &&
    value.registry.every(
      (item, index) =>
        outcome(item) && object(item) && item.eventId === request.registry[index].eventId,
    )
  );
}

/** Child process has no shell, bounded output, deadline and cancellation tied to plugin disposal. */
export async function collectWindows(
  bundleDir: string,
  host: Json,
  signal: AbortSignal,
): Promise<Json> {
  const observedAt = new Date().toISOString();
  if (process.platform !== "win32")
    return { ok: false, stage: "platform", error: "Windows 采集器仅支持 Windows", observedAt };
  let stage = "launch";
  try {
    signal.throwIfAborted();
    const request = observationRequest(host);
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 32768) throw new Error("Windows 采集请求过大");
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        join(bundleDir, "native/chord-observer.exe"),
        [],
        {
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          encoding: "utf8",
          signal,
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      // A child exiting before it reads stdin may report EPIPE. Keep it in the same outcome.
      child.stdin?.on("error", reject);
      child.stdin?.end(input);
    });
    stage = "protocol";
    const value: unknown = JSON.parse(output);
    if (!validateResult(value, request)) throw new Error("Windows 采集器返回无效报告");
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      stage,
      error: message(error).slice(0, 1000),
      code:
        object(error) && (typeof error.code === "string" || typeof error.code === "number")
          ? error.code
          : null,
      observedAt,
    };
  }
}
