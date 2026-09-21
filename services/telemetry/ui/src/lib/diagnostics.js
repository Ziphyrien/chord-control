import { registryEvidence } from "./registry-evidence.js";

const UNKNOWN = "未知";
export const DIAGNOSTIC_LIMIT = 16;
const text = (value) => (value === null || value === undefined ? UNKNOWN : String(value));
const boolean = (value) => (value === true ? "是" : value === false ? "否" : UNKNOWN);
const time = (value) => {
  if (value === null || value === undefined || value === "") return UNKNOWN;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? UNKNOWN : date.toLocaleString();
};
const mask = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? `0x${value.toString(16).toUpperCase()}`
    : UNKNOWN;
const array = (value) => (Array.isArray(value) ? value : []);
function errorText(result) {
  return [
    result?.error ? String(result.error) : "未提供结果或错误详情",
    result?.stage != null ? `阶段：${result.stage}` : null,
    result?.code != null ? `代码：${result.code}` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
function outcome(result) {
  return result?.ok === true ? text(result.value) : `${UNKNOWN} · ${errorText(result)}`;
}
function optional(result) {
  return result && typeof result === "object" ? outcome(result) : text(result);
}
function identity(process) {
  return `PID ${text(process?.pid)} · 创建时间 FILETIME ${text(process?.createdAt)}${process?.error ? ` · ${process.error}` : ""}`;
}
function targetText(target) {
  if (!target) return UNKNOWN;
  if (target.kind === "registry")
    return `${text(target.hive)}\\${text(target.path)} · 值：${target.name === "" ? "（默认）" : text(target.name)}`;
  return text(target.kind);
}
const UAC_KEYS = [
  "EnableLUA",
  "FilterAdministratorToken",
  "ConsentPromptBehaviorAdmin",
  "PromptOnSecureDesktop",
];

// Only report observed facts. A later AccessCheck cannot explain the earlier API failure.
export function diagnosticView(host = {}) {
  const native = host.native;
  const controllerVersion = text(host.controller?.version);
  const nativeVersion = text(native?.version);
  const versionsKnown = controllerVersion !== UNKNOWN && nativeVersion !== UNKNOWN;
  const probe = host.windows;
  const windows = probe?.ok === true && probe.value?.format === 1 ? probe.value : null;
  const probeState = windows
    ? "采集成功（各项结果见下表）"
    : probe?.ok === false
      ? `采集失败 · ${errorText(probe)}`
      : `未知 · ${probe ? "不支持的探测结果格式" : "未提供 Windows 探测结果"}`;
  const hasFailures = native?.schemaVersion === 2 && native?.failures != null;
  const failures = hasFailures ? native.failures : null;
  const events = array(failures?.events).slice(-DIAGNOSTIC_LIMIT);
  const failureStatus = hasFailures
    ? `统计起点：${time(failures.sinceMs)} · 总数 ${text(failures.total)} · 保留 ${text(failures.retained)} · 丢弃 ${text(failures.dropped)} · 页面显示 ${events.length} 条（最多 ${DIAGNOSTIC_LIMIT} 条）`
    : "原始失败详情不可用。请确认主程序为 0.4.6 或更高版本，再点击“立即采集”。";
  const checks = array(windows?.registry).slice(-DIAGNOSTIC_LIMIT);
  const registry = checks.map((check) => {
    const value = check.ok === true ? check.value : null;
    const event = events.find((entry) => entry.eventId === check.eventId);
    const verdict =
      value?.daclAllowed === true
        ? value.ancestorUsed
          ? "父键创建权限允许；目标权限待查"
          : "权限允许；原因待查"
        : value?.daclAllowed === false
          ? "权限拒绝"
          : `未知 · ${check.ok === false ? errorText(check) : "未提供 DACL 判断"}`;
    return [
      text(check.eventId),
      event ? `${text(event.pluginId)} / ${text(event.operation)}` : "未匹配到本页原始失败记录",
      verdict,
      time(windows.observedAtMs),
      text(value?.checkedPath),
      boolean(value?.ancestorUsed),
      mask(value?.requestedAccess),
      mask(value?.checkedAccess),
      mask(value?.grantedAccess),
      value ? identity(value) : UNKNOWN,
    ];
  });
  // A missing recheck must not silently disappear or become a denial.
  for (const event of events) {
    if (registry.length >= DIAGNOSTIC_LIMIT) break;
    if (
      event.target?.kind === "registry" &&
      !checks.some((check) => check.eventId === event.eventId)
    )
      registry.push([
        text(event.eventId),
        `${text(event.pluginId)} / ${text(event.operation)}`,
        `未知 · ${windows ? "未提供此事件的 DACL 复查结果" : probeState}`,
        UNKNOWN,
        UNKNOWN,
        UNKNOWN,
        UNKNOWN,
        UNKNOWN,
        UNKNOWN,
        UNKNOWN,
      ]);
  }
  return {
    summary: [
      ["控制器 / sidecar 版本", controllerVersion],
      ["原生主程序版本", nativeVersion],
      [
        "版本比较",
        versionsKnown
          ? controllerVersion === nativeVersion
            ? "版本一致"
            : "版本不一致，请核对更新状态"
          : "未知 · 缺少版本信息",
      ],
      ["原生快照采集时间", time(native?.observedAtMs)],
      ["原生进程身份", identity(native?.process ?? { pid: native?.pid })],
      ["Windows 探测结果", probeState],
      ["Windows 采集时间", time(windows?.observedAtMs ?? probe?.observedAt)],
    ],
    uac: UAC_KEYS.map((key) => [
      key,
      windows ? outcome(windows.uac?.[key]) : `未知 · ${probeState}`,
    ]),
    processes: array(windows?.processes).map((entry) => {
      const value = entry.ok === true ? entry.value : null;
      return [
        text(entry.role),
        text(entry.pid),
        value ? "读取成功" : `未知 · ${errorText(entry)}`,
        text(value?.pid),
        text(value?.createdAt),
        boolean(value?.elevated),
        text(value?.elevationType),
        text(value?.integrity),
        text(value?.userSid),
        optional(value?.executable),
        optional(value?.fileVersion),
      ];
    }),
    processEmpty: `未知 · ${windows ? "未提供目标进程令牌结果" : probeState}`,
    failureStatus,
    failureEmpty:
      hasFailures && failures.total === 0
        ? "此统计周期暂无原始失败记录。"
        : "未知 · 未提供保留的原始失败记录。",
    failures: events.map((event) => [
      `${text(event.eventId)} / ${text(event.sequence)}`,
      time(event.observedAtMs),
      `${text(event.pluginId)} / ${text(event.operation)}`,
      identity(event.process),
      text(event.api),
      text(event.code),
      targetText(event.target),
      mask(event.desiredAccess),
      text(event.message),
    ]),
    registry,
    registryEmpty: `未知 · ${windows ? "未提供 DACL 复查结果" : probeState}`,
    ...registryEvidence(windows, events),
  };
}
