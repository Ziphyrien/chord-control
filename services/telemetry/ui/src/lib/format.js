export const number = (value, suffix = "") =>
  typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value * 100) / 100}${suffix}`
    : "未知";
export const date = (value) => (value ? new Date(value).toLocaleString() : "未知");
export const deviceName = (device) =>
  device.label || `${device.report.client.hostname} / ${device.report.client.username}`;
export const labels = {
  active: "运行中",
  update: "可更新",
  paused: "已暂停",
  ignored: "已忽略",
  blocked: "无法启动",
  error: "异常",
  idle: "待安装",
};
