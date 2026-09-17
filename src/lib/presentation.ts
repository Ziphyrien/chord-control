import type { PluginStatus } from "../../shared/protocol.ts";

export const statusLabels: Record<PluginStatus, string> = {
  active: "运行中",
  update: "可更新",
  paused: "已暂停",
  blocked: "无法启动",
  error: "异常",
  idle: "待安装",
};
const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : dateFormat.format(date);
}
