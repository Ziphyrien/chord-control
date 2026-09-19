const element = (id) => document.getElementById(id);
let token = "";
let selected = null;
let requestPoll;
let pollAttempts = 0;
function stopPolling() {
  clearTimeout(requestPoll);
  pollAttempts = 0;
}
const labels = {
  active: "运行中",
  update: "可更新",
  paused: "已暂停",
  ignored: "已忽略",
  blocked: "无法启动",
  error: "异常",
  idle: "待安装",
};
const number = (value, suffix = "") =>
  typeof value === "number" ? `${Math.round(value * 100) / 100}${suffix}` : "未知";
const date = (value) => (value ? new Date(value).toLocaleString() : "未知");
function node(tag, text, className = "") {
  const item = document.createElement(tag);
  item.textContent = text;
  item.className = className;
  return item;
}
function row(target, values) {
  const tr = document.createElement("tr");
  for (const value of values) tr.append(node("td", String(value ?? "未知")));
  target.append(tr);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
async function perform(task) {
  element("error").textContent = "";
  try {
    await task();
  } catch (error) {
    element("error").textContent = String(error);
  }
}
async function list() {
  stopPolling();
  selected = null;
  const result = await api(`/api/devices?q=${encodeURIComponent(element("query").value)}`);
  element("login").hidden = true;
  element("workspace").hidden = false;
  element("detail").hidden = true;
  element("devices").hidden = false;
  element("updated").textContent =
    `${result.devices.length} 台客户端（最多显示100台） · ${date(result.receivedAt)}`;
  const target = element("devices");
  target.replaceChildren();
  for (const device of result.devices) {
    const client = device.report.client,
      host = device.report.host;
    const article = node("article", "", "device"),
      info = node("div", "");
    info.append(node("strong", device.label || `${client.hostname} / ${client.username}`));
    info.append(
      node(
        "p",
        `v${host.controller?.version ?? host.native?.version ?? "未知"} · ${device.ageSeconds > 900 ? "未收到近期上报" : "近期有上报"} · ${date(device.lastSeen)}`,
      ),
    );
    info.append(
      node("span", device.trusted ? "已确认客户端" : "待确认客户端 · 尚未记录历史", "badge"),
    );
    const open = node("button", "查看");
    open.onclick = () => {
      void perform(() => detail(device.id));
    };
    const trust = node("button", device.trusted ? "取消确认" : "确认此客户端");
    trust.onclick = () => {
      void perform(async () => {
        await api(`/api/devices/${device.id}/trust`, {
          method: "POST",
          body: JSON.stringify({ trusted: !device.trusted, label: device.label }),
        });
        await list();
      });
    };
    article.append(info, open, trust);
    target.append(article);
  }
  if (!result.devices.length) target.append(node("p", "尚未收到匹配客户端的上报。"));
}
async function detail(id) {
  const result = await api(`/api/devices/${id}`),
    device = result.device,
    report = device.report,
    host = report.host;
  selected = id;
  element("devices").hidden = true;
  element("detail").hidden = false;
  element("name").textContent =
    device.label || `${report.client.hostname} / ${report.client.username}`;
  const summary = element("summary");
  summary.replaceChildren();
  for (const [name, value] of [
    ["主程序版本", host.controller?.version ?? host.native?.version],
    ["最近上报", date(device.lastSeen)],
    ["进程运行时长", number(report.process.uptimeSeconds, " 秒")],
    ["进程内存", number(report.process.rssBytes / 1048576, " MiB")],
    [
      "插件运行 / 总数",
      `${host.controller?.plugins?.filter((p) => p.running).length ?? "?"} / ${host.controller?.plugins?.length ?? "?"}`,
    ],
    [
      "主程序更新",
      host.native?.updater?.error ||
        host.native?.updater?.availableVersion ||
        (host.native?.updater?.busy ? "进行中" : "空闲"),
    ],
  ]) {
    const item = node("div", name, "card");
    item.append(node("strong", String(value ?? "未知")));
    summary.append(item);
  }
  const plugins = element("plugins");
  plugins.replaceChildren();
  for (const plugin of host.controller?.plugins ?? [])
    row(plugins, [
      plugin.name,
      `${plugin.version} / ${plugin.latestVersion ?? "—"}`,
      labels[plugin.status] ?? plugin.status,
      plugin.error ?? plugin.blockedReason ?? "—",
    ]);
  const metrics = element("metrics");
  metrics.replaceChildren();
  for (const metric of host.metrics ?? [])
    row(metrics, [
      `${metric.pluginId} / ${metric.operation}`,
      `${metric.attempts} / ${metric.failed}`,
      number(metric.successRatio === null ? null : metric.successRatio * 100, "%"),
      `${number(metric.meanMs)} / ${number(metric.maxMs)} ms`,
      date(metric.since),
      metric.lastError ?? "—",
    ]);
  const custom = element("custom-metrics");
  custom.replaceChildren();
  for (const [pluginId, snapshot] of Object.entries(host.plugins ?? {})) {
    for (const metric of snapshot.metrics ?? [])
      row(custom, [
        `${pluginId} / ${metric.name}`,
        number(metric.value),
        metric.unit,
        date(snapshot.since),
      ]);
    if (snapshot.error || snapshot.lastError)
      row(custom, [pluginId, snapshot.error || snapshot.lastError, "—", date(snapshot.observedAt)]);
  }
  const activities = element("activities");
  activities.replaceChildren();
  for (const activity of host.controller?.activities ?? [])
    activities.append(node("p", `${date(activity.time)} · ${activity.title} · ${activity.detail}`));
  const history = element("history");
  history.replaceChildren();
  for (const sample of result.history)
    history.append(
      node(
        "p",
        `${date(sample.receivedAt)} · v${sample.report.host?.controller?.version ?? "未知"} · 运行 ${sample.report.host?.controller?.plugins?.filter((p) => p.running).length ?? "?"} 个插件 · 内存 ${number(sample.report.process?.rssBytes / 1048576, " MiB")}`,
      ),
    );
  if (!result.history.length) history.append(node("p", "确认客户端后开始保留历史样本。"));
  element("raw").textContent = JSON.stringify(report, null, 2);
}
element("login").onsubmit = (event) => {
  event.preventDefault();
  token = element("token").value;
  element("token").value = "";
  void perform(list);
};
element("search").onsubmit = (event) => {
  event.preventDefault();
  void perform(list);
};
element("logout").onclick = () => {
  stopPolling();
  selected = null;
  token = "";
  element("workspace").hidden = true;
  element("login").hidden = false;
  element("devices").replaceChildren();
  element("raw").textContent = "";
};
element("close").onclick = () => {
  void perform(list);
};
element("request").onclick = () => {
  const id = selected;
  if (!id) return;
  stopPolling();
  void perform(async () => {
    const state = await api(`/api/devices/${id}/request-report`, { method: "POST" });
    element("request-status").textContent = state.connected
      ? "已下发，等待新报告…"
      : "等待客户端连接，重连后会执行本次采集。";
    async function poll() {
      if (selected !== id) return;
      const next = await api(`/api/devices/${id}/live`);
      if (!next.pending) {
        element("request-status").textContent = "已收到本次采集的新报告。";
        await detail(id);
      } else if (++pollAttempts < 15)
        requestPoll = setTimeout(() => {
          void perform(poll);
        }, 2000);
      else element("request-status").textContent = "仍在等待客户端；请求已保留，可稍后刷新。";
    }
    requestPoll = setTimeout(() => {
      void perform(poll);
    }, 1500);
  });
};
