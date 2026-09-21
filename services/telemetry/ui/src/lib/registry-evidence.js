const unknown = "未知";
const array = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (value == null ? unknown : String(value));
const time = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? new Date(value).toLocaleString() : unknown;
const mask = (value) =>
  Number.isInteger(value) && value >= 0 ? `0x${value.toString(16).toUpperCase()}` : unknown;
const yesNo = (value) => (value === true ? "是" : value === false ? "否" : unknown);
const error = (item) =>
  [item?.reason ?? item?.error ?? "未提供原因", item?.code == null ? null : `错误码 ${item.code}`]
    .filter(Boolean)
    .join(" · ");
const sourceState = (item) =>
  ({ collected: "已读取", partial: "部分读取", unavailable: "无法读取" })[item?.status] ?? unknown;
const principal = (sid) =>
  ({
    "S-1-5-18": "SYSTEM",
    "S-1-5-32-544": "Administrators",
    "S-1-5-32-545": "Users",
    "S-1-1-0": "Everyone",
    "S-1-5-11": "Authenticated Users",
  })[sid] ?? text(sid);
const rights = (value) => {
  if (!Number.isInteger(value)) return unknown;
  const names = [
    [1, "读取值"],
    [2, "设置值"],
    [4, "创建子键"],
    [8, "枚举子键"],
    [16, "监视变化"],
    [0x20000, "读取权限"],
    [0x40000, "修改权限"],
    [0x80000, "更改所有者"],
  ];
  return `${mask(value)} · ${
    names
      .filter(([bit]) => (value & bit) !== 0)
      .map(([, name]) => name)
      .join("、") || "未列出的权限"
  }`;
};

// Current access checks, past permission changes and vendor events are different evidence.
export function registryEvidence(windows, failures) {
  const checks = array(windows?.registry).slice(0, 8);
  const descriptors = checks
    .filter((item) => item.ok === true)
    .map((item) => ({
      eventId: item.eventId,
      path: item.value?.checkedPath,
      result: item.value?.securityDescriptor,
    }));
  const security = descriptors.map(({ eventId, path, result }) => {
    const value = result?.ok === true ? result.value : null;
    return [
      eventId,
      text(path),
      value ? "读取成功" : result ? error(result) : "当前报告未采集权限条目",
      principal(value?.ownerSid),
      principal(value?.groupSid),
      yesNo(value?.daclProtected),
      yesNo(value?.daclAutoInherited),
      text(value?.sddl),
    ];
  });
  const aces = descriptors.flatMap(({ eventId, result }) => {
    const value = result?.ok === true ? result.value : null;
    return array(value?.aces)
      .slice(0, 32)
      .map((ace) => [
        eventId,
        principal(ace.sid),
        ace.type === 0 ? "允许" : ace.type === 1 ? "拒绝" : `类型 ${text(ace.type)}`,
        rights(ace.mask),
        yesNo(ace.inherited),
        yesNo(ace.inheritOnly),
      ]);
  });
  const evidence = windows?.vendorEvidence?.schemaVersion === 1 ? windows.vendorEvidence : null;
  const channels = array(evidence?.channels).slice(0, 8);
  const correlations = channels
    .flatMap((channel) =>
      array(channel.events).map((event) => ({ channel: channel.name, ...event })),
    )
    .slice(0, 16);
  const sourceSummary = [];
  const policy = evidence?.auditPolicy;
  if (evidence) {
    sourceSummary.push([
      "采集状态",
      `${sourceState(evidence)}${evidence.reason ? ` · ${evidence.reason}` : ""}`,
    ]);
    sourceSummary.push([
      "注册表失败审计",
      policy?.ok === true ? yesNo(policy.value?.registryFailure) : error(policy),
    ]);
    sourceSummary.push([
      "注册表成功审计",
      policy?.ok === true ? yesNo(policy.value?.registrySuccess) : error(policy),
    ]);
    sourceSummary.push(["审计范围", "系统当前审计策略；目标键的审计规则未读取"]);
    for (const probe of array(evidence.probes).slice(0, 8)) {
      sourceSummary.push([
        text(probe.failureEventId),
        probe.status === "ready"
          ? `${time(probe.windowStartMs)} — ${time(probe.windowEndMs)}`
          : `无法关联 · ${error(probe)}`,
      ]);
    }
    const enumeration = evidence.channelEnumeration;
    sourceSummary.push([
      "日志通道发现",
      enumeration?.ok === true
        ? `已检查 ${text(enumeration.value?.scanned)} 个通道${enumeration.value?.truncated ? "，已达到采集上限" : ""}`
        : error(enumeration),
    ]);
  }
  const attribution = array(failures)
    .slice(-16)
    .filter((event) => event.target?.kind === "registry")
    .map((event) => {
      const check = checks.find(
        (item) => item.eventId === event.eventId && item.ok === true,
      )?.value;
      const related = correlations.filter(
        (item) => item.correlation?.failureEventId === event.eventId,
      );
      const changes = related.filter(
        (item) => item.eventId === 4670 && item.provider === "Microsoft-Windows-Security-Auditing",
      );
      const failedAccess = related.some(
        (item) =>
          item.eventId === 4656 &&
          item.provider === "Microsoft-Windows-Security-Auditing" &&
          item.operation === "access_denied",
      );
      const access =
        check?.daclAllowed === false
          ? "采样时 Windows 权限检查拒绝"
          : check?.daclAllowed === true
            ? "采样时权限允许"
            : "权限检查结果不足";
      return [
        event.eventId,
        access,
        failedAccess ? "已找到关联访问失败审计" : "尚无关联访问失败审计",
        changes.length
          ? changes
              .map(
                (item) =>
                  `${time(item.timeMs)} · ${text(item.processName)} · ${principal(item.subjectSid)}`,
              )
              .join("；")
          : "权限设置者未确定",
      ];
    });
  return {
    vendor: evidence
      ? "来源证据已按原始失败时间和目标关联。权限修改记录中的进程是修改者；厂商日志的存在本身不代表拦截。"
      : "归因证据：未提供；当前报告未采集关联审计记录。",
    security,
    securityEmpty: "当前报告未采集权限描述符。",
    aces,
    aceLimit: descriptors.some(
      ({ result }) => result?.value?.acesTruncated || array(result?.value?.aces).length > 32,
    )
      ? "权限条目达到展示或采集上限，请结合原始报告。"
      : "允许和拒绝条目共同决定有效权限；标为“仅用于继承”的条目不作用于当前键。",
    attribution,
    sourceSummary,
    evidenceChannels: channels.map((channel) => [
      text(channel.name),
      sourceState(channel),
      text(channel.scanned),
      channel.reason || channel.code != null ? error(channel) : "—",
    ]),
    evidenceEvents: correlations.map((event) => [
      text(event.correlation?.failureEventId),
      time(event.timeMs),
      text(event.channel),
      `${text(event.provider)} / ${text(event.eventId)} / ${text(event.recordId)}`,
      text(event.operation),
      text(event.objectName),
      `${text(event.processName)} · PID ${text(event.processId)}`,
      principal(event.subjectSid),
      text(event.correlation?.basis),
      text(event.correlation?.timeDeltaMs),
    ]),
    evidenceEmpty: evidence ? "当前可读取范围内未找到关联记录。" : "当前报告未采集来源记录。",
  };
}
