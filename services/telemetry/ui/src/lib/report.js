import { date, number, labels } from "./format.js";

export function reportView(result) {
  const { device, history } = result;
  const { report } = device;
  const host = report.host;
  return {
    summary: [
      ["主程序版本", host.controller?.version ?? host.native?.version],
      ["最近上报", date(device.lastSeen)],
      ["进程运行时长", number(report.process?.uptimeSeconds, " 秒")],
      ["进程内存", number(report.process?.rssBytes / 1048576, " MiB")],
      [
        "插件运行 / 总数",
        `${host.controller?.plugins?.filter((p) => p.running).length ?? "?"} / ${host.controller?.plugins?.length ?? "?"}`,
      ],
      [
        "主程序更新",
        host.native?.updater?.error ||
          host.native?.updater?.availableVersion ||
          (host.native?.updater?.busy === true
            ? "进行中"
            : host.native?.updater?.busy === false
              ? "空闲"
              : "未知"),
      ],
    ],
    plugins: (host.controller?.plugins ?? []).map((plugin) => [
      plugin.name,
      `${plugin.version} / ${plugin.latestVersion ?? "—"}`,
      labels[plugin.status] ?? plugin.status,
      plugin.error ?? plugin.blockedReason ?? "—",
    ]),
    metrics: (host.metrics ?? []).map((metric) => [
      `${metric.pluginId} / ${metric.operation}`,
      `${metric.attempts} / ${metric.failed}`,
      number(metric.successRatio === null ? null : metric.successRatio * 100, "%"),
      `${number(metric.meanMs)} / ${number(metric.maxMs)} ms`,
      date(metric.since),
      metric.lastError ?? "—",
    ]),
    custom: Object.entries(host.plugins ?? {}).flatMap(([pluginId, snapshot]) => [
      ...(snapshot.metrics ?? []).map((metric) => [
        `${pluginId} / ${metric.name}`,
        number(metric.value),
        metric.unit,
        date(snapshot.since),
      ]),
      ...(snapshot.error || snapshot.lastError
        ? [[pluginId, snapshot.error || snapshot.lastError, "—", date(snapshot.observedAt)]]
        : []),
    ]),
    activities: (host.controller?.activities ?? []).map(
      (activity) => `${date(activity.time)} · ${activity.title} · ${activity.detail}`,
    ),
    history: history.map(
      (sample) =>
        `${date(sample.receivedAt)} · v${sample.report.host?.controller?.version ?? "未知"} · 运行 ${sample.report.host?.controller?.plugins?.filter((p) => p.running).length ?? "?"} 个插件 · 内存 ${number(sample.report.process?.rssBytes / 1048576, " MiB")}`,
    ),
  };
}
